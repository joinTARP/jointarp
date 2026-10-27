// 只依赖有界字节流能力，可用于 libp2p 或 Bun WebRTC 数据通道。
export interface ByteStream extends AsyncIterable<Uint8Array | { subarray(): Uint8Array }> {
  maxReadBufferLength: number;
  maxWriteBufferLength?: number;
  send(data: Uint8Array): boolean;
  onDrain(options: { signal: AbortSignal }): Promise<void>;
  abort(error: Error): void;
  addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
}

// 传输协议：4 字节长度 + 1 字节类型 + 正文。长度包含类型，单帧最多 16 MiB，覆盖 10 MiB 状态帧编码后的载荷。
export const MAX_FRAME = 16 * 1024 * 1024;
const MAX_QUEUE = 2 * MAX_FRAME;
export class StreamPort extends EventTarget {
  private closed = false;
  private queue: Buffer[] = [];
  private queued = 0;
  private sending = false;
  constructor(private readonly stream: ByteStream) {
    super();
    stream.maxReadBufferLength = 2 * MAX_FRAME;
    stream.maxWriteBufferLength = MAX_FRAME;
    stream.addEventListener("close", () => this.close(), { once: true });
    // 接收在微任务中开始，允许调用方先安装 oRPC 的监听器。
    queueMicrotask(() => void this.receive().catch((error) => this.close(error)));
  }
  postMessage(data: string | Uint8Array) {
    if (this.closed) throw Error("P2P 数据流已关闭");
    const bytes = Buffer.from(data);
    if (bytes.length + 1 > MAX_FRAME || this.queued + bytes.length + 5 > MAX_QUEUE) {
      const error = Error("联机数据帧或发送队列超过上限");
      this.close(error);
      throw error;
    }
    const frame = Buffer.allocUnsafe(bytes.length + 5);
    frame.writeUInt32BE(bytes.length + 1);
    frame[4] = typeof data === "string" ? 0 : 1;
    bytes.copy(frame, 5);
    this.queue.push(frame);
    this.queued += frame.length;
    void this.flush().catch((error) => this.close(error));
  }
  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (!this.closed && this.queue.length) {
        const frame = this.queue[0];
        for (let offset = 0; offset < frame.length; offset += 16 * 1024) {
          if (this.closed) return;
          if (!this.stream.send(frame.subarray(offset, offset + 16 * 1024)))
            await this.stream.onDrain({ signal: AbortSignal.timeout(5_000) });
        }
        this.queue.shift();
        this.queued -= frame.length;
      }
    } finally {
      this.sending = false;
    }
  }
  private async receive() {
    const header = Buffer.alloc(4);
    let headerBytes = 0;
    let frame: Buffer | undefined;
    let frameBytes = 0;
    for await (const chunk of this.stream) {
      if (this.closed) return;
      const data = chunk.subarray();
      let offset = 0;
      while (offset < data.length && !this.closed) {
        if (!frame) {
          const count = Math.min(4 - headerBytes, data.length - offset);
          header.set(data.subarray(offset, offset + count), headerBytes);
          headerBytes += count;
          offset += count;
          if (headerBytes < 4) continue;
          const size = header.readUInt32BE(0);
          if (size < 1 || size > MAX_FRAME) throw Error("非法联机帧长度");
          frame = Buffer.allocUnsafe(size);
          frameBytes = 0;
          headerBytes = 0;
        }
        const count = Math.min(frame.length - frameBytes, data.length - offset);
        frame.set(data.subarray(offset, offset + count), frameBytes);
        frameBytes += count;
        offset += count;
        if (frameBytes === frame.length) {
          const kind = frame[0];
          if (kind !== 0 && kind !== 1) throw Error("非法联机帧类型");
          const bytes = frame.subarray(1);
          const message = kind === 0 ? bytes.toString("utf8") : new Uint8Array(bytes);
          frame = undefined;
          this.dispatchEvent(new MessageEvent("message", { data: message }));
        }
      }
    }
    if (headerBytes || frame) throw Error("联机数据帧被截断");
    this.close();
  }
  close(reason: unknown = Error("联机数据流关闭")) {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.queued = 0;
    this.stream.abort(reason instanceof Error ? reason : Error(String(reason)));
    this.dispatchEvent(new Event("close"));
  }
}
