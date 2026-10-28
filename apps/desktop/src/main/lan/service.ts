import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { readRoomState } from "@jointarp/core/node/sessions/session-store";
import { structuredFile } from "@jointarp/core/node/storage/structured-file";
import { type Player } from "@jointarp/core/shared/game";
import { RPCLink } from "@orpc/client/websocket";
import { ORPCError, type Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/websocket";
import type { Server, ServerWebSocket } from "bun";
import { z } from "zod";

import type { DesktopRpcContext } from "../desktop-rpc-context";
import { resolveMediaRequestFile } from "../media-path";
import {
  challengeSchema,
  createChallenge,
  proofSchema,
  roomIdentity,
  verifyProof,
  type IdentityChallenge,
} from "../online/identity";
import { OnlineRooms } from "../online/rooms";
import {
  loadLocalSession,
  loadLocalSessionModuleResources,
} from "../sessions/local-room-resources";
import { ModuleCache, ModulePublisher } from "./module-cache";

const secretSchema = z.string().regex(/^[a-f0-9]{64}$/);
const joinSchema = proofSchema;
const replySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]),
  roomId: z.string().uuid(),
  token: secretSchema,
});
const token = () => randomBytes(32).toString("hex");

const allowedSessions = new Set([
  "sessions.module.resources",
  "sessions.display.get",
  "sessions.details",
  "sessions.notes.get",
  "sessions.notes.save",
  "sessions.ai.get",
  "sessions.companion.get",
  "sessions.companion.reclaim",
]);
export function assertLanAccess(path: readonly string[], input: unknown, roomId: string) {
  const name = path.join(".");
  if (
    !(name.startsWith("game.") || allowedSessions.has(name)) ||
    !input ||
    typeof input !== "object" ||
    !("roomId" in input) ||
    input.roomId !== roomId
  )
    throw new ORPCError("FORBIDDEN", { message: "无法访问此房间或操作" });
  if (["game.launch.open", "game.launch.chooseStart"].includes(name))
    throw new ORPCError("FORBIDDEN", { message: "请由房主操作" });
}

function isPrivateIPv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || +part > 255))
    return false;
  const [a, b] = parts.map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 169 && b === 254)
  );
}
export function lanAddress(address: string) {
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d{1,5})$/.exec(address.trim());
  if (!match || !isPrivateIPv4(match[1]!) || +match[2]! < 1 || +match[2]! > 65535)
    throw new Error("请输入内网 IPv4 地址和端口，例如 192.168.1.10:8765");
  return `http://${match[1]}:${+match[2]!}`;
}

export type Member = {
  player: Player;
  proof: string;
  token: string;
  status: "pending" | "approved" | "rejected";
  expires: number;
  onDecision?: (approve: boolean) => void;
};
type SocketData = { member: Member; context: DesktopRpcContext };
export type Hosted = {
  roomId: string;
  server?: Server<SocketData>;
  context: DesktopRpcContext;
  admit: (player: Player, proof: string) => Promise<z.infer<typeof replySchema>>;
  request: (request: Request, server?: Server<SocketData>) => Promise<Response | undefined>;
  members: Map<string, Member>;
  sockets: Set<ServerWebSocket<SocketData>>;
  nativeOwners: Map<string, import("../online/native-peer").NativePeer>;
};
export type Remote = {
  base: string;
  token: string;
  link: Pick<RPCLink<object>, "call">;
  request?: (path: string, options: RequestInit) => Promise<Response>;
  close?: () => void;
  socket?: WebSocket;
  closed: boolean;
  controller: AbortController;
};

export class LanService {
  private hosted?: Hosted;
  private readonly remotes = new Map<string, Remote>();
  private readonly identity;
  private readonly modules: ModuleCache;
  readonly online: OnlineRooms;
  constructor(
    directory: string,
    private readonly context: () => Promise<DesktopRpcContext>,
    private readonly router: Router<DesktopRpcContext>,
    onlineOptions?: { coordinatorUrl: string; iceServers?: string[] },
  ) {
    this.online = new OnlineRooms(this, router, onlineOptions);
    this.modules = new ModuleCache(join(directory, "cache", "room-modules"));
    this.identity = roomIdentity(directory);
  }
  status(roomId: string) {
    const hosted = this.hosted?.roomId === roomId ? this.hosted : undefined;
    const online = this.online.status(roomId);
    this.prune();
    return {
      remote: this.remotes.has(roomId),
      hosting: Boolean(hosted?.server || online),
      connection: this.remotes.get(roomId)?.closed
        ? ("disconnected" as const)
        : this.remotes.has(roomId)
          ? ("connected" as const)
          : ("local" as const),
      online,
      addresses: hosted?.server
        ? Object.values(networkInterfaces()).flatMap(
            (entries) =>
              entries
                ?.filter(
                  (entry) =>
                    entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address),
                )
                .map((entry) => `${entry.address}:${hosted.server!.port}`) ?? [],
          )
        : [],
      pending: hosted
        ? [...hosted.members.values()]
            .filter((member) => member.status === "pending")
            .map((member) => ({ id: member.token, nickname: member.player.nickname }))
        : [],
    };
  }
  private prune() {
    if (!this.hosted) return;
    for (const [key, member] of this.hosted.members)
      if (member.status !== "approved" && member.expires < Date.now())
        this.hosted.members.delete(key);
  }
  async host(roomId: string) {
    await this.prepareHost(roomId, true);
    return this.status(roomId);
  }
  async prepareHost(roomId: string, lan: boolean): Promise<Hosted> {
    if (this.remotes.has(roomId)) throw new Error("只有房主可以开放联机");
    if (this.hosted) {
      if (this.hosted.roomId !== roomId) throw new Error("请先停止另一个房间的联机");
      if (lan && !this.hosted.server) throw Error("请先停止互联网联机，再开放内网房间");
      return this.hosted;
    }
    const context = await this.context();
    const session = await loadLocalSession(context.sessionsRoot, roomId);
    if (session.room.status !== "active") throw new Error("请先重新开启冒险");
    if (this.hosted) throw new Error("内网联机已经开放");
    const publisher = new ModulePublisher(
      join(context.sessionsRoot, roomId, "module"),
      () => loadLocalSessionModuleResources(context.sessionsRoot, roomId),
      async () => (await readRoomState(context.sessionsRoot, roomId)).state.room,
    );
    const members = new Map<string, Member>();
    const sockets = new Set<ServerWebSocket<SocketData>>();
    const handler = new RPCHandler(this.router, {
      clientInterceptors: [
        ({ path, input, next }) => {
          assertLanAccess(path, input, roomId);
          return next();
        },
      ],
    });
    const proofs = structuredFile(join(context.sessionsRoot, roomId, "lan-members.json"), {
      validate: z.record(z.string(), secretSchema).parse,
      missing: () => ({}),
      fileMode: 0o600,
    });
    const admit: Hosted["admit"] = async (player, proof) => {
      this.prune();
      if (player.id === context.player.id)
        throw new ORPCError("FORBIDDEN", { message: "玩家身份与房主相同" });
      const saved = (await proofs.read())[player.id];
      if (this.hosted?.members !== members) throw Error("房间已关闭");
      if (saved && saved !== proof)
        throw new ORPCError("FORBIDDEN", { message: "玩家身份无法验证" });
      let member = [...members.values()].find(
        (entry) => entry.player.id === player.id && entry.proof === proof,
      );
      if (!member) {
        if (members.size >= 32) throw new ORPCError("TOO_MANY_REQUESTS");
        member = {
          player,
          proof,
          token: token(),
          status: saved ? "approved" : "pending",
          expires: Date.now() + 120_000,
        };
        members.set(member.token, member);
      }
      if (member.status === "approved") await context.chat.registerMember(roomId, player);
      return { status: member.status, roomId, token: member.token };
    };
    const challenges = new Map<string, number>();
    const request: Hosted["request"] = async (request, server) => {
      try {
        if (this.hosted?.members !== members) return new Response(null, { status: 410 });
        if (request.headers.has("origin")) return new Response(null, { status: 403 });
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === "/challenge") {
          for (const [nonce, expires] of challenges)
            if (expires < Date.now()) challenges.delete(nonce);
          if (challenges.size >= 64) return new Response(null, { status: 429 });
          const challenge = createChallenge(roomId);
          challenges.set(challenge.nonce, Date.now() + 30_000);
          return Response.json(challenge);
        }
        if (request.method === "POST" && url.pathname === "/join") {
          const input = joinSchema.parse(await request.json());
          const expires = challenges.get(input.nonce);
          challenges.delete(input.nonce);
          if (!expires || expires < Date.now()) return new Response(null, { status: 403 });
          const proof = verifyProof(input, { roomId, nonce: input.nonce }, "lan");
          return Response.json(await admit(input.player, proof));
        }
        const member = members.get(
          request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
        );
        if (!member || member.status !== "approved") return new Response(null, { status: 403 });
        if (request.method === "GET" && url.pathname.startsWith("/module/"))
          return await publisher.handle(request);
        if (request.method === "DELETE" && url.pathname === "/leave") {
          members.delete(member.token);
          for (const socket of sockets)
            if (socket.data.member === member) socket.close(1000, "玩家已离开");
          return new Response(null, { status: 204 });
        }
        if (request.method === "GET" && url.pathname === "/rpc") {
          if (sockets.size >= 64) return new Response(null, { status: 429 });
          if (
            server?.upgrade(request, {
              data: { member, context: { ...context, player: member.player, isHost: false } },
            })
          )
            return;
        }
        if (["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/media/")) {
          const scope = decodeURIComponent(url.pathname.slice(7));
          if (scope !== `room:${roomId}` && scope !== `room-module:${roomId}`)
            return new Response(null, { status: 403 });
          const file = await resolveMediaRequestFile(
            `tarp://document/${encodeURIComponent(scope)}${url.search}`,
          );
          if (file) {
            const moduleHash = await publisher.imageHash(file);
            if (moduleHash && request.headers.get("If-None-Match") === `"${moduleHash}"`)
              return new Response(null, {
                status: 304,
                headers: { ETag: `"${moduleHash}"`, "Content-Type": Bun.file(file).type },
              });
            return new Response(request.method === "HEAD" ? null : Bun.file(file), {
              headers: {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Type": Bun.file(file).type,
                ...(moduleHash ? { ETag: `"${moduleHash}"` } : {}),
              },
            });
          }
        }
        return new Response(null, { status: 404 });
      } catch (error) {
        return new Response("连接请求无效", {
          status: error instanceof ORPCError && error.code === "FORBIDDEN" ? 403 : 400,
        });
      }
    };
    const server = lan
      ? Bun.serve<SocketData>({
          hostname: "0.0.0.0",
          port: 0,
          maxRequestBodySize: 4096,
          fetch: request,
          websocket: {
            maxPayloadLength: 1024 * 1024,
            open: (socket) => {
              sockets.add(socket);
            },
            message: (socket, data) => {
              if (members.get(socket.data.member.token)?.status !== "approved") {
                socket.close(1008);
                return;
              }
              void handler
                .message(socket, data, { context: socket.data.context })
                .catch(() => socket.close(1011));
            },
            close: (socket) => {
              sockets.delete(socket);
              void handler.close(socket);
            },
          },
        })
      : undefined;
    this.hosted = {
      roomId,
      server,
      members,
      sockets,
      context,
      request,
      admit,
      nativeOwners: new Map(),
    };
    return this.hosted;
  }
  abandonHost(host: Hosted) {
    if (this.hosted === host && !host.server) this.stop(host.roomId);
  }
  async decide(roomId: string, id: string, approve: boolean) {
    const hosted = this.hosted;
    const member = hosted?.roomId === roomId ? hosted.members.get(id) : undefined;
    if (!member || member.status !== "pending" || member.expires < Date.now())
      throw new Error("申请已失效");
    if (approve) {
      const context = await this.context();
      const proofs = structuredFile(join(context.sessionsRoot, roomId, "lan-members.json"), {
        validate: z.record(z.string(), secretSchema).parse,
        missing: () => ({}),
        fileMode: 0o600,
      });
      await proofs.update((saved) => {
        if (saved[member.player.id] && saved[member.player.id] !== member.proof)
          throw new Error("玩家身份冲突，请拒绝此申请");
        return { ...saved, [member.player.id]: member.proof };
      });
    }
    if (!hosted || this.hosted !== hosted || hosted.members.get(id) !== member)
      throw Error("申请已失效");
    if (approve) await hosted.context.chat.registerMember(roomId, member.player);
    member.status = approve ? "approved" : "rejected";
    member.onDecision?.(approve);
    return this.status(roomId);
  }
  async recent() {
    const context = await this.context();
    return this.recentFile(context.sessionsRoot).read();
  }
  async forgetRecent(roomId: string) {
    const context = await this.context();
    await this.recentFile(context.sessionsRoot).update((records) =>
      records.filter((record) => record.roomId !== roomId),
    );
  }
  private recentFile(root: string) {
    return structuredFile(join(root, "recent-joined.json"), {
      validate: z.array(
        z.object({
          roomId: z.string().uuid(),
          name: z.string(),
          target: z.string(),
          joinedAt: z.string(),
        }),
      ).parse,
      missing: () => [],
      fileMode: 0o600,
    });
  }
  async remember(roomId: string, target: string) {
    const context = await this.context();
    const file = this.recentFile(context.sessionsRoot);
    await file.update((records) => {
      const before = records.find((item) => item.roomId === roomId);
      return [
        { roomId, target, name: before?.name ?? "加入的冒险", joinedAt: new Date().toISOString() },
        ...records.filter((item) => item.roomId !== roomId),
      ];
    });
  }
  async removeMember(roomId: string, playerId: string) {
    const context = await this.context();
    if (this.remotes.has(roomId) || playerId === context.player.id)
      throw new Error("不能移除此成员");
    await context.chat.removeMember(roomId, playerId);
    const proofs = structuredFile(join(context.sessionsRoot, roomId, "lan-members.json"), {
      validate: z.record(z.string(), secretSchema).parse,
      missing: () => ({}),
      fileMode: 0o600,
    });
    await proofs.update((saved) => {
      delete saved[playerId];
      return saved;
    });
    const hosted = this.hosted?.roomId === roomId ? this.hosted : undefined;
    for (const [id, member] of hosted?.members ?? []) {
      if (member.player.id !== playerId) continue;
      member.status = "rejected";
      hosted!.members.delete(id);
      for (const socket of hosted!.sockets)
        if (socket.data.member === member) socket.close(1008, "已被移出房间");
      hosted!.nativeOwners.get(id)?.close();
    }
  }
  async join(address: string, signal?: AbortSignal, expectedRoomId?: string) {
    const base = lanAddress(address);
    const context = await this.context();
    const challengeResponse = await fetch(`${base}/challenge`, {
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
    });
    if (!challengeResponse.ok) throw Error("无法获取房间身份挑战");
    const challenge = challengeSchema.parse(await challengeResponse.json());
    if (expectedRoomId && challenge.roomId !== expectedRoomId)
      throw new Error("连接信息属于另一个房间，请输入原房间的新地址");
    const proof = await this.identity.prove(context.player, challenge, "lan");
    const response = await fetch(`${base}/join`, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? "玩家身份无法验证，不能加入"
          : "无法加入，请确认房主已开放内网联机",
      );
    const reply = replySchema.parse(await response.json());
    signal?.throwIfAborted();
    if (reply.status !== "approved") return { status: reply.status, roomId: reply.roomId };
    if (existsSync(join(context.sessionsRoot, reply.roomId)))
      throw new Error("本机已有同名存档，不能作为访客加入");
    const existing = this.remotes.get(reply.roomId);
    if (existing) this.disconnect(reply.roomId, false);
    if (!this.remotes.has(reply.roomId)) {
      const remote: Remote = {
        base,
        token: reply.token,
        closed: false,
        controller: new AbortController(),
        link: new RPCLink({
          connect: () => {
            if (remote.closed) throw new Error("已离开内网房间");
            const Socket = WebSocket as unknown as new (
              url: string,
              options: Bun.WebSocketOptions,
            ) => WebSocket;
            const socket = new Socket(`${base.replace("http:", "ws:")}/rpc`, {
              headers: { Authorization: `Bearer ${reply.token}` },
            });
            remote.socket = socket;
            return socket;
          },
          reconnect: { enabled: true, maxAttempt: 3 },
        }),
      };
      this.remotes.set(reply.roomId, remote);
    }
    await this.remember(reply.roomId, address.trim());
    return { status: reply.status, roomId: reply.roomId };
  }
  async joinIdentity(challenge: IdentityChallenge, binding: string) {
    const context = await this.context();
    return { context, proof: await this.identity.prove(context.player, challenge, binding) };
  }
  markDisconnected(roomId: string, remote: Remote) {
    if (this.remotes.get(roomId) !== remote) return;
    remote.closed = true;
    remote.controller.abort();
  }
  attachRemote(roomId: string, remote: Remote) {
    this.disconnect(roomId);
    this.remotes.set(roomId, remote);
  }
  private requestRemote(remote: Remote, path: string, options: RequestInit) {
    if (remote.request) return remote.request(path, options);
    return fetch(`${remote.base}${path}`, {
      ...options,
      redirect: "error",
      headers: { Authorization: `Bearer ${remote.token}`, ...options.headers },
    });
  }
  remote(roomId: string) {
    return this.remotes.get(roomId);
  }
  async moduleResources(roomId: string, signal?: AbortSignal) {
    const remote = this.remotes.get(roomId);
    if (!remote) throw new Error("尚未连接房间");
    const cancellation = AbortSignal.any([remote.controller.signal, ...(signal ? [signal] : [])]);
    const resources = await this.modules.sync(
      roomId,
      (path, headers) =>
        this.requestRemote(remote, path, {
          redirect: "error",
          headers: {
            Authorization: `Bearer ${remote.token}`,
            "Accept-Encoding": "gzip",
            ...headers,
          },
          signal: AbortSignal.any([cancellation, AbortSignal.timeout(120_000)]),
        }),
      cancellation,
    );
    const context = await this.context();
    await this.recentFile(context.sessionsRoot).update((records) =>
      records.map((record) =>
        record.roomId === roomId ? { ...record, name: resources.room.name } : record,
      ),
    );
    return resources;
  }
  async media(source: string, method: string): Promise<Response | undefined> {
    const url = new URL(source);
    const scope = decodeURIComponent(url.pathname.slice(1));
    const roomId = scope.replace(/^room(?:-module)?:/, "");
    const remote = this.remotes.get(roomId);
    if (!remote) return undefined;
    try {
      const target = `/media/${encodeURIComponent(scope)}${url.search}`;
      const candidate = await this.modules.imageCandidate(roomId, url);
      const response = await this.requestRemote(remote, target, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Bearer ${remote.token}`,
          ...(candidate ? { "If-None-Match": `"${candidate.hash}"` } : {}),
        },
        signal: AbortSignal.any([remote.controller.signal, AbortSignal.timeout(10_000)]),
      });
      if (response.status === 304 && candidate)
        return new Response(method === "HEAD" ? null : Bun.file(candidate.file), {
          headers: {
            "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      return response;
    } catch {
      return new Response(null, { status: 502 });
    }
  }
  private disconnect(roomId: string, leave = true) {
    const remote = this.remotes.get(roomId);
    if (!remote) return;
    remote.closed = true;
    remote.controller.abort();
    remote.socket?.close();
    remote.close?.();
    this.remotes.delete(roomId);
    if (leave && !remote.close)
      void fetch(`${remote.base}/leave`, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(2000),
        headers: { Authorization: `Bearer ${remote.token}` },
      }).catch(() => undefined);
  }
  stop(roomId: string) {
    this.online.stop(roomId);
    if (this.hosted?.roomId === roomId) {
      const hosted = this.hosted;
      this.hosted = undefined;
      hosted.members.clear();
      for (const peer of hosted.nativeOwners.values()) peer.close();
      hosted.nativeOwners.clear();
      for (const socket of hosted.sockets) socket.close(1001, "房主已停止内网联机");
      void hosted.server?.stop(true);
    }
    this.disconnect(roomId);
  }
  close() {
    this.online.close();
    if (this.hosted) this.stop(this.hosted.roomId);
    for (const roomId of this.remotes.keys()) this.disconnect(roomId);
  }
}
