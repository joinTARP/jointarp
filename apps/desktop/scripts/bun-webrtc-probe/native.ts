import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import native, { type DataChannel } from "node-datachannel";

import { createProbeRouter, type ProbeRouter } from "../p2p-probe/router";
import { StreamPort } from "../p2p-probe/stream-port";
import { verify } from "../p2p-probe/verify";
import { ChannelStream, type ReliableChannel } from "./channel-stream";

function adapt(channel: DataChannel): ReliableChannel {
  let closed = false;
  return {
    get readyState() {
      return closed ? "closed" : channel.isOpen() ? "open" : "connecting";
    },
    get bufferedAmount() {
      return channel.bufferedAmount();
    },
    send: (data) => {
      channel.sendMessageBinary(data);
    },
    close: () => channel.close(),
    onMessage: {
      subscribe: (listener) =>
        channel.onMessage((data) =>
          listener(
            typeof data === "string" ? data : Buffer.isBuffer(data) ? data : Buffer.from(data),
          ),
        ),
    },
    stateChange: {
      subscribe: (listener) =>
        channel.onClosed(() => {
          closed = true;
          listener("closed");
        }),
    },
    error: { subscribe: (listener) => channel.onError((message) => listener(Error(message))) },
  };
}
const a = new native.PeerConnection("player", { iceServers: [] });
const b = new native.PeerConnection("host", { iceServers: [] });
const ports: StreamPort[] = [];
const timer = setTimeout(() => {
  console.error("原生 WebRTC 实验超时");
  process.exit(1);
}, 15_000);
try {
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type));
  b.onLocalDescription((sdp, type) => a.setRemoteDescription(sdp, type));
  a.onLocalCandidate((candidate, mid) => b.addRemoteCandidate(candidate, mid));
  b.onLocalCandidate((candidate, mid) => a.addRemoteCandidate(candidate, mid));
  b.onDataChannel((channel) => {
    const port = new StreamPort(new ChannelStream(adapt(channel)));
    ports.push(port);
    new RPCHandler(createProbeRouter()).upgrade(port);
  });
  const channel = a.createDataChannel("rpc");
  while (!channel.isOpen()) await Bun.sleep(10);
  const port = new StreamPort(new ChannelStream(adapt(channel)));
  ports.push(port);
  const client = createORPCClient<RouterClient<ProbeRouter>>(new RPCLink({ port }));
  const checks = await verify(client);
  const pair = a.getSelectedCandidatePair();
  if (!pair || pair.local.type !== "host" || pair.remote.type !== "host")
    throw Error("本机路径不符");
  console.log(
    "NATIVE_WEBRTC_RESULT",
    JSON.stringify({
      runtime: Bun.version,
      library: native.getLibraryVersion(),
      scope: "本机两个原生 WebRTC 端点，无 STUN/TURN，非 NAT 测试",
      checks,
    }),
  );
} finally {
  clearTimeout(timer);
  for (const port of ports) port.close();
  a.close();
  b.close();
  native.cleanup();
}
