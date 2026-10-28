import { z } from "zod";

import { NativePeer, type PeerSignal } from "./native-peer";

const credentialSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  hostToken: z.string().regex(/^[a-f0-9]{64}$/),
});
const guestSchema = z.object({ guestToken: z.string().regex(/^[a-f0-9]{64}$/) });
const welcomeSchema = z.object({
  type: z.literal("welcome"),
  protocolVersion: z.literal(1),
  peerId: z.string(),
  peers: z.array(z.string()).max(16),
  pending: z.array(z.string()).max(16).optional(),
  approved: z.boolean(),
});
const iceSchema = z.object({
  iceServers: z.array(z.object({ urls: z.union([z.string(), z.array(z.string())]) })).max(16),
});

export function coordinatorUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw Error("协调服务需要 HTTPS 地址（本机开发可使用回环 HTTP）");
  return url.origin;
}

/** 仅实现公开协调协议；游戏数据不会通过该连接发送。 */
export class Coordinator {
  readonly peers = new Map<string, NativePeer>();
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ice: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  online = false;
  error?: string;
  private constructor(
    readonly base: string,
    readonly code: string,
    private readonly token: string,
    private readonly host: boolean,
    private readonly onPeer: (peer: NativePeer) => void,
    private readonly iceOverride?: string[],
  ) {}
  private async http(path: string, method: string, body?: unknown) {
    const response = await fetch(`${this.base}${path}`, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error(`协调服务请求失败（${response.status}）`);
    return response.json();
  }
  static async create(base: string, onPeer: (peer: NativePeer) => void, ice?: string[]) {
    base = coordinatorUrl(base);
    const response = await fetch(`${base}/v1/rooms`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error(`无法开放互联网房间（${response.status}）`);
    const credentials = credentialSchema.parse(await response.json());
    const room = new Coordinator(base, credentials.code, credentials.hostToken, true, onPeer, ice);
    try {
      await room.connect();
      return room;
    } catch (error) {
      room.close();
      throw error;
    }
  }
  static async join(
    base: string,
    code: string,
    onPeer: (peer: NativePeer) => void,
    ice?: string[],
  ) {
    base = coordinatorUrl(base);
    if (!/^\d{6}$/.test(code)) throw Error("请输入六位房间码");
    const response = await fetch(`${base}/v1/rooms/${code}/join`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error(`无法加入，请检查房间码与房主网络（${response.status}）`);
    const credentials = guestSchema.parse(await response.json());
    const room = new Coordinator(base, code, credentials.guestToken, false, onPeer, ice);
    try {
      await room.connect();
      return room;
    } catch (error) {
      room.close();
      throw error;
    }
  }
  private async loadIce() {
    if (this.iceOverride !== undefined) {
      this.ice = this.iceOverride;
      return;
    }
    const result = iceSchema.parse(await this.http(`/v1/rooms/${this.code}/ice`, "POST"));
    // 本阶段只使用 STUN，服务器 TURN 留待后续收费中继接入。
    this.ice = result.iceServers
      .flatMap((entry) => (typeof entry.urls === "string" ? [entry.urls] : entry.urls))
      .filter((url) => /^stun:[^\s]+$/.test(url));
    if (!this.ice.length)
      this.ice = ["stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478"];
  }
  private connect() {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error(`协调连接超时（${this.base}）；请检查协调服务及 WebSocket 网络连通性`));
        this.close();
      }, 10_000);
      const Socket = WebSocket as unknown as new (
        url: string,
        options: Bun.WebSocketOptions,
      ) => WebSocket;
      const socket = new Socket(
        `${this.base.replace(/^http/, "ws")}/v1/rooms/${this.code}/socket`,
        { headers: { Authorization: `Bearer ${this.token}` } },
      );
      this.socket = socket;
      socket.addEventListener("message", (event) => {
        this.tail = this.tail
          .then(async () => {
            if (this.stopped) return;
            if (typeof event.data !== "string" || Buffer.byteLength(event.data) > 64 * 1024)
              throw Error("协调信令格式无效");
            if (event.data === "pong") return;
            const data = JSON.parse(event.data);
            if (data.type === "welcome") {
              const parsed = welcomeSchema.safeParse(data);
              if (!parsed.success) throw Error("协调服务协议不匹配，请更新协调服务后重试");
              const welcome = parsed.data;
              if ((welcome.peerId === "host") !== this.host) throw Error("协调身份不符");
              this.online = true;
              if (this.host) {
                await this.loadIce();
                this.heartbeat = setInterval(() => {
                  if (socket.readyState === WebSocket.OPEN)
                    socket.send(JSON.stringify({ type: "heartbeat" }));
                }, 60_000);
                for (const id of welcome.peers)
                  await this.accept(id, welcome.pending?.includes(id) ?? false);
              } else if (welcome.approved) {
                await this.loadIce();
                this.makePeer("host");
              }
              clearTimeout(timer);
              resolve();
            } else if (data.type === "peer-joined" && this.host) {
              if (typeof data.peerId !== "string" || !/^[a-f0-9-]{36}$/.test(data.peerId))
                throw Error("协调玩家身份无效");
              await this.accept(data.peerId, true);
            } else if (data.type === "approved" && !this.host) {
              await this.loadIce();
              this.makePeer("host");
            } else if (data.type === "signal") {
              const peer = this.peers.get(data.from);
              if (!peer) return;
              try {
                const signal = data.data;
                if (signal?.description && !signal.candidate)
                  peer.receiveSignal({ kind: "description", ...signal.description });
                else if (signal?.candidate && !signal.description)
                  peer.receiveSignal({
                    kind: "candidate",
                    candidate: signal.candidate.candidate,
                    mid: signal.candidate.sdpMid ?? "0",
                  });
                else throw Error("无效协商消息");
              } catch {
                peer.close(Error("对端信令无效"));
                this.peers.delete(data.from);
              }
            } else if (["room-closed", "rejected", "error"].includes(data.type)) {
              throw Error("房间协调已中断，请重新开放或加入房间");
            }
          })
          .catch((error: unknown) => {
            // 不输出校验原文，避免把信令和凭证带入日志。
            this.error =
              error instanceof Error &&
              [
                "协调服务协议不匹配，请更新协调服务后重试",
                "协调身份不符",
                "协调信令格式无效",
                "房间协调已中断，请重新开放或加入房间",
              ].includes(error.message)
                ? error.message
                : error instanceof Error && /^协调服务请求失败（\d{3}）$/.test(error.message)
                  ? error.message
                  : "连接协调失败，请重新开放或加入房间";
            clearTimeout(timer);
            reject(Error(this.error));
            socket.close();
          });
      });
      const closed = () => {
        clearTimeout(timer);
        clearInterval(this.heartbeat);
        this.online = false;
        if (!this.stopped)
          this.error ??= "协调连接已断开，现有直连仍可继续；新玩家需要重新开放房间";
        reject(Error(this.error ?? "协调连接已关闭"));
        // 保留已建立的 P2P；握手中的连接由 NativePeer 超时清理。
      };
      socket.addEventListener("close", closed);
      socket.addEventListener("error", closed);
    });
  }
  private async accept(id: string, pending: boolean) {
    if (!this.peers.has(id) && this.peers.size >= 16) {
      if (pending)
        await this.http(`/v1/rooms/${this.code}/decision`, "POST", { peerId: id, approve: false });
      return;
    }
    this.makePeer(id);
    // 这里只放行加密握手；游戏准入仍需房主在 P2P 内审批并验证身份。
    if (pending)
      await this.http(`/v1/rooms/${this.code}/decision`, "POST", { peerId: id, approve: true });
  }
  private makePeer(id: string) {
    if (this.peers.has(id)) return;
    if (this.peers.size >= 16) throw Error("房间连接已满");
    const peer = new NativePeer({
      initiator: !this.host,
      iceServers: this.ice,
      onSignal: (signal: PeerSignal) => {
        if (this.socket?.readyState !== WebSocket.OPEN) throw Error("协调连接不可用");
        const data =
          signal.kind === "description"
            ? { description: { type: signal.type, sdp: signal.sdp } }
            : { candidate: { candidate: signal.candidate, sdpMid: signal.mid } };
        this.socket.send(JSON.stringify({ type: "signal", to: id, data }));
      },
    });
    this.peers.set(id, peer);
    peer.addEventListener(
      "close",
      () => {
        if (this.peers.get(id) === peer) this.peers.delete(id);
        if (this.host && !this.stopped)
          void this.http(`/v1/rooms/${this.code}/decision`, "POST", {
            peerId: id,
            approve: false,
          }).catch(() => undefined);
      },
      { once: true },
    );
    void peer.ready.then(
      (port) => {
        port.addEventListener(
          "close",
          () => {
            if (this.peers.get(id) === peer) this.peers.delete(id);
          },
          { once: true },
        );
      },
      () => {
        if (this.peers.get(id) === peer) this.peers.delete(id);
      },
    );
    this.onPeer(peer);
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.online = false;
    clearInterval(this.heartbeat);
    this.socket?.close();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    if (this.host) void this.http(`/v1/rooms/${this.code}`, "DELETE").catch(() => undefined);
  }
}
