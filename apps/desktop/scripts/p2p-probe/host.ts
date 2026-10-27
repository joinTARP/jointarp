import { RPCHandler } from "@orpc/server/message-port";

import { createPeer, protocol } from "./peer";
import { createProbeRouter } from "./router";
import { StreamPort } from "./stream-port";

const expectedPeer = process.argv[2];
if (!expectedPeer) throw Error("必须指定获准连接的实验玩家 Peer ID");
const hostname = process.env.TARP_P2P_PROBE_LISTEN ?? "127.0.0.1";
if (hostname !== "127.0.0.1" && hostname !== "0.0.0.0") throw Error("非法监听地址");
const peer = await createPeer([`/ip4/${hostname}/tcp/0`], expectedPeer);
const ports = new Set<StreamPort>();
const handler = new RPCHandler(createProbeRouter());
await peer.handle(protocol, (stream, connection) => {
  if (connection.remotePeer.toString() !== expectedPeer) {
    stream.abort(Error("未授权实验节点"));
    return;
  }
  const port = new StreamPort(stream);
  ports.add(port);
  port.addEventListener("close", () => ports.delete(port), { once: true });
  handler.upgrade(port);
});
console.log(JSON.stringify({ address: peer.getMultiaddrs()[0]?.toString(), pid: process.pid }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const port of ports) port.close();
  await peer.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
// SSH 断开或父进程退出后停止，不留下孤立的远程监听。
process.stdin.resume();
process.stdin.on("end", () => void stop());
setTimeout(() => void stop(), 90_000);
