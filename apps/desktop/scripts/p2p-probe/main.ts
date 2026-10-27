import { RPCHandler } from "@orpc/server/message-port";
import { BrowserWindow, BrowserView, Utils } from "electrobun/main";

import { NativeMessagePort } from "../../src/shared/native-bridge";
import { createProbeRouter } from "./router";
import { startSession } from "./session";
import type { ProbeBridge, ProbeResult } from "./shared";

let finished = false;
let session: Awaited<ReturnType<typeof startSession>> | undefined;
let port: NativeMessagePort | undefined;
async function finish(result: ProbeResult) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log(
    "P2P_RPC_RESULT",
    JSON.stringify({
      scope: session?.remote
        ? "macOS 系统 WebView→本机 Bun→公网 TCP/libp2p→Linux Bun；非 NAT 打洞"
        : "单机系统 WebView→玩家 Bun→回环 TCP/libp2p→独立房主 Bun 进程",
      ...result,
    }),
  );
  port?.close();
  session?.port.close();
  await session?.stop();
  Utils.quit(result.error ? 1 : 0);
}
const timer = setTimeout(() => void finish({ checks: [], error: "桌面 RPC 实验超时" }), 45_000);
try {
  session = await startSession();
  const remote = session;
  const rpc = BrowserView.defineRPC<ProbeBridge>({
    handlers: {
      requests: {
        report: (result) => {
          // 给页面的报告应答留出时间，再关闭宿主。
          setTimeout(() => void finish(result), 100);
          return true;
        },
      },
      messages: { orpc: (packet) => port!.receive(packet) },
    },
  });
  port = new NativeMessagePort((packet) => rpc.send.orpc(packet));
  // 复用现有本地 RPC → 远端 RPC 的结构，取消信号与订阅游标一并转发。
  new RPCHandler(createProbeRouter(), {
    clientInterceptors: [
      ({ path, input, signal, lastEventId }) =>
        remote.link.call(path, input, { context: {}, signal, lastEventId }),
    ],
  }).upgrade(port);
  const window = new BrowserWindow({
    title: "TARP Bun P2P RPC 验证",
    renderer: "native",
    url: "views://main/index.html",
    rpc,
    frame: { x: 160, y: 160, width: 680, height: 360 },
    allowedProtocols: { views: true, appData: false },
  });
  window.on("close", () => void finish({ checks: [], error: "实验窗口已关闭" }));
} catch (error) {
  await finish({ checks: [], error: String(error) });
}
