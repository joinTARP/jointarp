import type { DesktopAction } from "./desktop-events";

export interface BridgePacket {
  binary: boolean;
  data: string;
}

export type NativeBridge = {
  bun: {
    requests: {
      bootstrap: { params: undefined; response: { mediaBase: string } };
      claimStartupAnimation: { params: undefined; response: boolean };
      openExternal: { params: { url: string }; response: boolean };
      setGamePage: { params: { active: boolean }; response: void };
      windowAction: { params: { action: DesktopAction }; response: boolean };
    };
    messages: { orpc: BridgePacket };
  };
  webview: {
    requests: {};
    messages: {
      orpc: BridgePacket;
      desktop: { name: "open-settings" | "request-leave-room" };
    };
  };
};

/** oRPC 的字符串和二进制帧通过原生 JSON RPC 保持原有顺序与取消协议。 */
export class NativeMessagePort extends EventTarget {
  private closed = false;
  constructor(private send: (packet: BridgePacket) => void) {
    super();
  }
  postMessage(data: string | Uint8Array): void {
    if (this.closed) throw new Error("桌面连接已关闭");
    if (typeof data === "string") this.send({ binary: false, data });
    else {
      let binary = "";
      for (let start = 0; start < data.length; start += 8192)
        binary += String.fromCharCode(...data.subarray(start, start + 8192));
      this.send({ binary: true, data: btoa(binary) });
    }
  }
  receive(packet: BridgePacket): void {
    if (this.closed) return;
    const data = packet.binary
      ? Uint8Array.from(atob(packet.data), (value) => value.charCodeAt(0))
      : packet.data;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}
