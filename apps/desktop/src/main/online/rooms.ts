import { existsSync } from "node:fs";
import { join } from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import { os, ORPCError, type Router, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";

import type { DesktopRpcContext } from "../desktop-rpc-context";
import {
  assertLanAccess,
  type Hosted,
  type LanService,
  type Member,
  type Remote,
} from "../lan/service";
import { Coordinator } from "./coordinator";
import { challengeSchema, createChallenge, proofSchema, verifyProof } from "./identity";
import { type NativePeer } from "./native-peer";
import { fetchResource, resourceRouter } from "./resources";

const credentials = proofSchema;
const procedure = os.$context<DesktopRpcContext>();
export function attachHost(host: Hosted, peer: NativePeer, router: Router<DesktopRpcContext>) {
  let member: Member | undefined;
  let identity: string | undefined;
  const context = { ...host.context, player: { id: "", nickname: "" }, isHost: false };
  const challenge = createChallenge(host.roomId);
  let authenticated = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const expire = () => peer.close(Error("玩家认证或审批超时"));
  const bind = () => {
    if (!member) throw new ORPCError("FORBIDDEN");
    context.player = member.player;
    authenticated = true;
    clearTimeout(deadline);
  };
  const authorize = () => {
    if (
      !authenticated ||
      !member ||
      host.nativeOwners.get(member.token) !== peer ||
      host.members.get(member.token) !== member ||
      member.status !== "approved"
    )
      throw new ORPCError("FORBIDDEN", { message: "尚未获得房主授权" });
    return member.token;
  };
  const resources = resourceRouter((request) => host.request(request), authorize);
  const connection = {
    challenge: procedure.handler(() => challenge),
    join: procedure.input(credentials).handler(async ({ input }) => {
      let proof: string;
      try {
        proof = verifyProof(input, challenge, peer.identityBinding());
      } catch {
        throw new ORPCError("FORBIDDEN", { message: "玩家身份签名无效" });
      }
      const identityKey = `${input.player.id}:${proof}`;
      if (identity && identity !== identityKey)
        throw new ORPCError("FORBIDDEN", { message: "连接身份不可更改" });
      const first = !identity;
      identity = identityKey;
      const reply = await host.admit(input.player, proof);
      if (peer.isClosed) throw new ORPCError("PRECONDITION_FAILED");
      member = host.members.get(reply.token);
      if (!member) throw new ORPCError("FORBIDDEN");
      const previous = host.nativeOwners.get(member.token);
      host.nativeOwners.set(member.token, peer);
      if (previous && previous !== peer) previous.close();
      member.onDecision = (approve) => {
        if (host.nativeOwners.get(member!.token) !== peer) return;
        if (approve) bind();
        else {
          clearTimeout(deadline);
          deadline = setTimeout(() => peer.close(), 5000);
        }
      };
      if (first) {
        clearTimeout(deadline);
        deadline = setTimeout(expire, Math.max(0, member.expires - Date.now()));
      }
      if (reply.status === "approved") bind();
      return reply;
    }),
  };
  const handler = new RPCHandler(
    { ...router, connection },
    {
      clientInterceptors: [
        ({ path, input, next }) => {
          if (!["connection.join", "connection.challenge"].includes(path.join("."))) {
            authorize();
            if (path[0] !== "connection") assertLanAccess(path, input, host.roomId);
          }
          return next();
        },
      ],
    },
  );
  void peer.ready.then(
    (port) => {
      deadline = setTimeout(expire, 15_000);
      port.addEventListener(
        "close",
        () => {
          clearTimeout(deadline);
          resources.close();
          if (member && host.nativeOwners.get(member.token) === peer) {
            host.nativeOwners.delete(member.token);
            host.members.delete(member.token);
          }
        },
        { once: true },
      );
      handler.upgrade(port, { context });
    },
    () => resources.close(),
  );
  void peer.resourcesReady.then(
    (port) => {
      new RPCHandler(
        { resources: resources.router },
        {
          clientInterceptors: [
            ({ next }) => {
              authorize();
              return next();
            },
          ],
        },
      ).upgrade(port);
    },
    () => resources.close(),
  );
  return { connection, resources: resources.router };
}
type PeerClient = RouterClient<ReturnType<typeof attachHost>>;
type ConnectionClient = PeerClient["connection"];
type Guest = {
  code: string;
  coordinator: Coordinator;
  peer: NativePeer;
  link: RPCLink<object>;
  client: ConnectionClient;
  resources: PeerClient["resources"];
  approved: boolean;
  roomId?: string;
  timer: ReturnType<typeof setTimeout>;
};

export class OnlineRooms {
  private hosted?: { roomId: string; coordinator: Coordinator };
  private guest?: Guest;
  private joining?: { code: string; promise: Promise<Guest>; cancel: () => void };
  private generation = 0;
  private readonly base: string;
  private readonly ice?: string[];
  constructor(
    private readonly rooms: LanService,
    private readonly router: Router<DesktopRpcContext>,
    options?: { coordinatorUrl: string; iceServers?: string[] },
  ) {
    this.base =
      options?.coordinatorUrl ??
      process.env.TARP_COORDINATOR_URL ??
      "https://online.jointarp.party";
    this.ice = options?.iceServers;
  }
  status(roomId: string) {
    const host = this.hosted?.roomId === roomId ? this.hosted.coordinator : undefined;
    return host
      ? { code: host.online ? host.code : null, connected: host.online, error: host.error ?? null }
      : null;
  }
  async host(roomId: string) {
    if (this.hosted) {
      if (this.hosted.roomId !== roomId) throw Error("请先停止另一个互联网房间");
      return this.rooms.status(roomId);
    }
    const generation = this.generation;
    const host = await this.rooms.prepareHost(roomId, false);
    if (generation !== this.generation) {
      this.rooms.abandonHost(host);
      throw Error("开放房间已取消");
    }
    let coordinator: Coordinator;
    try {
      coordinator = await Coordinator.create(
        this.base,
        (peer) => attachHost(host, peer, this.router),
        this.ice,
      );
    } catch (error) {
      this.rooms.abandonHost(host);
      throw error;
    }
    if (generation !== this.generation) {
      coordinator.close();
      throw Error("开放房间已取消");
    }
    if (this.hosted) {
      coordinator.close();
      throw Error("互联网房间已经开放");
    }
    this.hosted = { roomId, coordinator };
    return this.rooms.status(roomId);
  }
  private async connect(code: string): Promise<Guest> {
    if (this.guest?.peer.isClosed) {
      clearTimeout(this.guest.timer);
      this.guest.coordinator.close();
      this.guest = undefined;
    }
    if (this.guest?.code === code) return this.guest;
    if (this.guest?.approved) throw Error("请先离开当前互联网房间");
    if (this.joining?.code === code) return this.joining.promise;
    this.cancelJoin();
    const generation = this.generation;
    let cancel = () => {};
    const promise = (async () => {
      let resolve!: (peer: NativePeer) => void;
      const native = new Promise<NativePeer>((ready) => {
        resolve = ready;
      });
      const coordinator = await Coordinator.join(this.base, code, resolve, this.ice);
      if (generation !== this.generation) {
        coordinator.close();
        throw Error("加入房间已取消");
      }
      let timeout!: ReturnType<typeof setTimeout>;
      const timedOut = new Promise<never>((_, reject) => {
        cancel = () => {
          coordinator.close();
          reject(Error("加入房间已取消"));
        };
        timeout = setTimeout(() => reject(Error("等待协商超时")), 30_000);
      });
      try {
        const peer = await Promise.race([native, timedOut]);
        const [port, resourcePort] = await Promise.all([peer.ready, peer.resourcesReady]);
        if (generation !== this.generation) throw Error("加入房间已取消");
        const link = new RPCLink({ port });
        const client = createORPCClient<PeerClient>(link).connection;
        const resources = createORPCClient<PeerClient>(
          new RPCLink({ port: resourcePort }),
        ).resources;
        const guest: Guest = {
          code,
          coordinator,
          peer,
          link,
          client,
          resources,
          approved: false,
          timer: setTimeout(() => {
            if (!guest.approved) this.cancelJoin(code);
          }, 120_000),
        };
        this.guest = guest;
        peer.addEventListener(
          "close",
          () => {
            clearTimeout(guest.timer);
            guest.coordinator.close();
            if (guest.roomId) {
              const remote = this.rooms.remote(guest.roomId);
              if (remote?.link === guest.link) this.rooms.markDisconnected(guest.roomId, remote);
            }
            if (this.guest === guest) this.guest = undefined;
          },
          { once: true },
        );
        return guest;
      } catch (error) {
        coordinator.close();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.joining = { code, promise, cancel: () => cancel() };
    try {
      return await promise;
    } finally {
      if (this.joining?.promise === promise) this.joining = undefined;
    }
  }
  async join(code: string, signal?: AbortSignal) {
    if (!/^\d{6}$/.test(code)) throw Error("请输入六位房间码");
    signal?.throwIfAborted();
    const cancelled = () => this.cancelJoin(code);
    signal?.addEventListener("abort", cancelled, { once: true });
    let guest: Guest;
    try {
      guest = await this.connect(code);
    } finally {
      signal?.removeEventListener("abort", cancelled);
    }
    signal?.throwIfAborted();
    const challenge = challengeSchema.parse(await guest.client.challenge(undefined, { signal }));
    const { context, proof } = await this.rooms.joinIdentity(
      challenge,
      guest.peer.identityBinding(),
    );
    const reply = await guest.client.join(proof, { signal });
    signal?.throwIfAborted();
    if (reply.status === "rejected") {
      this.cancelJoin(code);
      return reply;
    }
    if (reply.status !== "approved") return reply;
    if (existsSync(join(context.sessionsRoot, reply.roomId))) {
      this.cancelJoin(code);
      throw Error("本机已有同名存档，不能作为访客加入");
    }
    if (!guest.approved) {
      guest.approved = true;
      guest.roomId = reply.roomId;
      clearTimeout(guest.timer);
      const remote: Remote = {
        base: `p2p:${code}`,
        token: reply.token,
        link: guest.link,
        closed: false,
        controller: new AbortController(),
        request: (path, options) => fetchResource(guest.resources, path, options),
        close: () => {
          guest.coordinator.close();
          if (this.guest === guest) this.guest = undefined;
        },
      };
      this.rooms.attachRemote(reply.roomId, remote);
      if (guest.peer.isClosed) this.rooms.markDisconnected(reply.roomId, remote);
    }
    return reply;
  }
  cancelJoin(code?: string) {
    if (code && this.guest?.code !== code && this.joining?.code !== code) return;
    if (this.guest?.approved) return;
    this.generation++;
    if (this.guest) {
      clearTimeout(this.guest.timer);
      this.guest.coordinator.close();
      this.guest = undefined;
    }
    this.joining?.cancel();
    this.joining = undefined;
  }
  stop(roomId: string) {
    this.generation++;
    if (this.hosted?.roomId === roomId) {
      this.hosted.coordinator.close();
      this.hosted = undefined;
    }
  }
  close() {
    this.generation++;
    if (this.hosted) this.stop(this.hosted.roomId);
    if (this.guest) {
      clearTimeout(this.guest.timer);
      this.guest.coordinator.close();
      this.guest = undefined;
    }
    this.joining?.cancel();
    this.joining = undefined;
  }
}
