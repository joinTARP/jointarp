import type { ProbeByteStream } from "../p2p-probe/stream-port";

// 两种实现仅适配数据通道的最小能力，分帧和限额沿用同一条路径。
export interface ReliableChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(): void;
  onMessage: { subscribe(listener: (data: string | Buffer) => void): unknown };
  stateChange: { subscribe(listener: (state: string) => void): unknown };
  error: { subscribe(listener: (error: Error) => void): unknown };
}

/** 可靠有序 DataChannel 的消息按顺序视为字节流；复用现有实验的有界分帧。 */
export class ChannelStream extends EventTarget implements ProbeByteStream {
  maxReadBufferLength = 2 * 1024 * 1024;
  maxWriteBufferLength = 1024 * 1024;
  private queue: Buffer[] = [];
  private buffered = 0;
  private closed = false;
  private wake?: () => void;
  constructor(private readonly channel: ReliableChannel) {
    super();
    channel.onMessage.subscribe((data) => {
      if (this.closed) return;
      if (typeof data === "string" || this.buffered + data.length > this.maxReadBufferLength) {
        this.abort(Error("WebRTC 实验接收缓冲或数据类型非法"));
        return;
      }
      this.queue.push(data);
      this.buffered += data.length;
      this.wake?.();
    });
    channel.stateChange.subscribe((state) => {
      if (state === "closed") this.abort(Error("数据通道关闭"));
    });
    channel.error.subscribe((error) => this.abort(error));
  }
  send(data: Uint8Array) {
    if (this.closed || this.channel.readyState !== "open") throw Error("WebRTC 通道不可用");
    if (this.channel.bufferedAmount + data.byteLength > this.maxWriteBufferLength)
      throw Error("WebRTC 实验发送缓冲超限");
    this.channel.send(Buffer.from(data));
    return this.channel.bufferedAmount < 256 * 1024;
  }
  async onDrain({ signal }: { signal: AbortSignal }) {
    while (this.channel.bufferedAmount >= 256 * 1024) {
      signal.throwIfAborted();
      if (this.closed) throw Error("等待发送时数据通道关闭");
      await Bun.sleep(5);
    }
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      const next = this.queue.shift();
      if (next) {
        this.buffered -= next.length;
        yield next;
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
