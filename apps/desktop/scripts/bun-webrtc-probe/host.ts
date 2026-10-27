import { createInterface } from "node:readline";

import { RPCHandler } from "@orpc/server/message-port";

import { createProbeRouter } from "../p2p-probe/router";
import { StreamPort } from "../p2p-probe/stream-port";
import { ChannelStream } from "./channel-stream";
import { createPeer, summary } from "./peer";

const peer = createPeer(process.argv[2] === "stun");
let port: StreamPort | undefined;
const timer = setTimeout(() => void stop(), 60_000);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  port?.close();
  await peer.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
peer.onDataChannel.subscribe((channel) => {
  if (channel.label === "binary") {
    let total = 0;
    channel.onMessage.subscribe((data) => {
      if (typeof data === "string" || total + data.length > 2 * 1024 * 1024) {
        channel.send("binary-error");
        return;
      }
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== (total + i) % 251) {
          channel.send("binary-error");
          return;
        }
      }
      total += data.length;
      if (total === 2 * 1024 * 1024) channel.send("binary-ok");
    });
    return;
  }
  if (channel.label !== "rpc") {
    channel.close();
    return;
  }
  port = new StreamPort(new ChannelStream(channel));
  new RPCHandler(createProbeRouter()).upgrade(port);
  channel.stateChange.subscribe((state) => {
    if (state === "closed") void stop();
  });
});
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.length > 64 * 1024) throw Error("SDP 超限");
  const offer = JSON.parse(line);
  if (offer.type !== "offer" || typeof offer.sdp !== "string") throw Error("非法 SDP");
  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  const local = peer.localDescription!;
  const sdp =
    process.argv[3] === "srflx"
      ? local.sdp
          .split("\r\n")
          .filter((line) => !line.startsWith("a=candidate:") || line.includes(" typ srflx "))
          .join("\r\n")
      : local.sdp;
  if (process.argv[3] === "srflx" && !sdp.includes(" typ srflx "))
    throw Error("远端没有 STUN srflx 候选");
  console.log(JSON.stringify({ description: { type: local.type, sdp }, summary: summary(peer) }));
  lines.close();
  break;
}
// SDP 交换结束后不再读取 SSH 输入；数据与连接保活只能走 WebRTC。
