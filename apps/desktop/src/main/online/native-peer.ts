import { createHash } from "node:crypto";

import { PeerConnection, type DataChannel } from "node-datachannel";
import { z } from "zod";

import { StreamPort, type ByteStream } from "./stream-port";

const signalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("description"),
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(64_000),
  }),
  z.object({
    kind: z.literal("candidate"),
    candidate: z.string().min(1).max(4096),
    mid: z.string().max(256),
  }),
]);
export type PeerSignal = z.infer<typeof signalSchema>;

class NativeChannelStream extends EventTarget implements ByteStream {
  maxReadBufferLength = 2 * 1024 * 1024;
  maxWriteBufferLength = 1024 * 1024;
  private queue: Buffer[] = [];
  private buffered = 0;
  private closed = false;
  private wake?: () => void;
  private nextSend = 0;
  constructor(
    private readonly channel: DataChannel,
    private readonly resource = false,
  ) {
    super();
    channel.onMessage((message) => {
      if (this.closed) return;
      if (typeof message === "string") return this.abort(Error("数据通道需要二进制消息"));
      const data = Buffer.isBuffer(message)
        ? Buffer.from(message)
        : Buffer.from(new Uint8Array(message));
      if (this.buffered + data.length > this.maxReadBufferLength)
        return this.abort(Error("数据通道接收缓冲超限"));
      this.queue.push(data);
      this.buffered += data.length;
      this.wake?.();
    });
    channel.onClosed(() => this.abort(Error("数据通道关闭")));
    channel.onError((message) => this.abort(Error(message)));
  }
  send(data: Uint8Array) {
    if (this.closed || !this.channel.isOpen()) throw Error("数据通道不可用");
    if (this.channel.bufferedAmount() + data.length > this.maxWriteBufferLength)
      throw Error("数据通道发送缓冲超限");
    // libdatachannel 返回 false 也可能表示消息已入队，不能再次发送。
    this.channel.sendMessageBinary(data);
    if (this.resource)
      this.nextSend =
        Math.max(performance.now(), this.nextSend) + (data.length / (2 * 1024 * 1024)) * 1000;
    return !this.resource && this.channel.bufferedAmount() < 256 * 1024;
  }
  async onDrain({ signal }: { signal: AbortSignal }) {
    while (
      this.channel.bufferedAmount() >= 256 * 1024 ||
      (this.resource && performance.now() < this.nextSend)
    ) {
      signal.throwIfAborted();
      if (this.closed) throw Error("等待发送时数据通道关闭");
      await Bun.sleep(5);
    }
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const data = this.queue.shift();
      if (data) {
        this.buffered -= data.length;
        yield data;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    }
  }
  abort(_error: Error) {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.buffered = 0;
    this.wake?.();
    this.channel.close();
    this.dispatchEvent(new Event("close"));
  }
}

/** 单个已授权玩家的可靠有序 RPC 连接；身份与房间准入由调用方验证。 */
export class NativePeer extends EventTarget {
  readonly ready: Promise<StreamPort>;
  readonly resourcesReady: Promise<StreamPort>;
  private resourcePort?: StreamPort;
  private resolveResources!: (port: StreamPort) => void;
  private rejectResources!: (error: Error) => void;
  get isClosed() {
    return this.closed;
  }
  private readonly peer: PeerConnection;
  private port?: StreamPort;
  private closed = false;
  private described = false;
  private opened = 0;
  private candidates: Extract<PeerSignal, { kind: "candidate" }>[] = [];
  private resolve!: (port: StreamPort) => void;
  private reject!: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(options: {
    initiator: boolean;
    iceServers: string[];
    onSignal: (signal: PeerSignal) => void;
  }) {
    super();
    this.resourcesReady = new Promise((resolve, reject) => {
      this.resolveResources = resolve;
      this.rejectResources = reject;
    });
    void this.resourcesReady.catch(() => undefined);
    this.ready = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // 调用方可能在交换信令后才等待 ready。
    void this.ready.catch(() => undefined);
    this.peer = new PeerConnection("tarp-rpc", { iceServers: options.iceServers });
    this.timer = setTimeout(() => this.close(Error("联机握手超时")), 30_000);
    const emit = (signal: PeerSignal) => {
      if (this.closed) return;
      try {
        options.onSignal(signal);
      } catch {
        this.close(Error("信令发送失败"));
      }
    };
    this.peer.onLocalDescription((sdp, type) => {
      if (type === "offer" || type === "answer") emit({ kind: "description", sdp, type });
    });
    this.peer.onLocalCandidate((candidate, mid) => emit({ kind: "candidate", candidate, mid }));
    this.peer.onStateChange((state) => {
      if (["failed", "closed", "disconnected"].includes(state)) this.close(Error("对端连接已断开"));
    });
    this.peer.onDataChannel((channel) => this.attach(channel));
    if (options.initiator) {
      this.attach(this.peer.createDataChannel("tarp-rpc-v1"));
      this.attach(this.peer.createDataChannel("tarp-resources-v1"));
    }
  }
  private attach(channel: DataChannel) {
    const resource = channel.getLabel() === "tarp-resources-v1";
    if (
      this.closed ||
      (resource ? this.resourcePort : this.port) ||
      !["tarp-rpc-v1", "tarp-resources-v1"].includes(channel.getLabel())
    ) {
      channel.close();
      return;
    }
    const port = new StreamPort(new NativeChannelStream(channel, resource));
    if (resource) this.resourcePort = port;
    else this.port = port;
    port.addEventListener("close", () => this.close(), { once: true });
    const opened = () => {
      if (this.closed) return;
      if (++this.opened === 2) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      if (resource) this.resolveResources(port);
      else this.resolve(port);
    };
    channel.onOpen(opened);
    if (channel.isOpen()) opened();
  }
  receiveSignal(input: unknown) {
    if (this.closed) throw Error("联机连接已关闭");
    const signal = signalSchema.parse(input);
    if (signal.kind === "description") {
      if (this.described) throw Error("不接受重复握手");
      this.peer.setRemoteDescription(signal.sdp, signal.type);
      this.described = true;
      for (const entry of this.candidates) this.peer.addRemoteCandidate(entry.candidate, entry.mid);
      this.candidates = [];
    } else if (this.described) {
      this.peer.addRemoteCandidate(signal.candidate, signal.mid);
    } else {
      if (this.candidates.length >= 128) throw Error("远端候选数量超限");
      this.candidates.push(signal);
    }
  }
  identityBinding() {
    const identity = (sdp: string | undefined) => {
      const fingerprint = sdp?.match(/^a=fingerprint:([^\r\n]+)$/m)?.[1];
      const ice = sdp?.match(/^a=ice-ufrag:([^\r\n]+)$/m)?.[1];
      if (!fingerprint || !ice) throw Error("加密通道身份不可用");
      return [fingerprint, ice];
    };
    if (this.closed) throw Error("加密通道已关闭");
    const endpoints = [
      identity(this.peer.localDescription()?.sdp),
      identity(this.peer.remoteDescription()?.sdp),
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return createHash("sha256").update(JSON.stringify(endpoints)).digest("hex");
  }
  selectedCandidatePair() {
    return this.peer.getSelectedCandidatePair();
  }
  close(error = Error("联机连接已关闭")) {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.candidates = [];
    this.reject(error);
    this.rejectResources(error);
    this.port?.close(error);
    this.resourcePort?.close(error);
    this.peer.close();
    this.dispatchEvent(new Event("close"));
    // 不在单个玩家离线时调用全局 cleanup，其他房间连接仍可能使用原生运行时。
  }
}
