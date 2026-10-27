import { startSession } from "./session";
import { verify } from "./verify";

const deadline = setTimeout(() => {
  console.error("P2P_RPC_RESULT", JSON.stringify({ error: "无界面 RPC 实验超时" }));
  process.exit(1);
}, 35_000);
let session: Awaited<ReturnType<typeof startSession>> | undefined;
try {
  session = await startSession();
  const checks = await verify(session.client);
  console.log(
    "P2P_RPC_RESULT",
    JSON.stringify({
      scope: session.remote
        ? "macOS Bun→公网 TCP/libp2p→Linux Bun；无界面，非 NAT 打洞"
        : "单机两个独立 Bun 进程；无界面",
      checks,
    }),
  );
} finally {
  session?.port.close();
  await session?.stop();
  clearTimeout(deadline);
}
