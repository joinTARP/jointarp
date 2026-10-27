import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { Electroview } from "electrobun/view";

import { NativeMessagePort } from "../../src/shared/native-bridge";
import type { router } from "./main";
import type { ProbeBridge, ProbeResult, Signal } from "./shared";
const id = Number(location.hash.slice(1));
let pc: RTCPeerConnection;
let channel: RTCDataChannel;
let total = 0;
let binaryDone: () => void;
let port: NativeMessagePort;
const result: ProbeResult = {
  scope: "单机双 WebView，非跨机器验收",
  origin: location.origin,
  secure: isSecureContext,
  peer: typeof RTCPeerConnection,
  checks: [],
};
const rpc = Electroview.defineRPC<ProbeBridge>({
  handlers: {
    requests: {},
    messages: {
      start: () => void start().catch(fail),
      signal: (data: Signal) => void signal(data).catch(fail),
      orpc: (packet) => channel.send(JSON.stringify(packet)),
    },
  },
});
new Electroview({ rpc });
try {
  const config = await rpc.request.config();
  result.scope = ["listen", "join"].includes(config.mode)
    ? "双机模式（需确认实际运行在两台机器）"
    : "单机双 WebView，非跨机器验收";
  document.body.textContent = "等待对端连接…";
  pc = new RTCPeerConnection({ iceServers: config.iceServers });
} catch (error) {
  await rpc.request.report({ ...result, error: String(error), stage: "constructor" });
  throw error;
}
pc.onconnectionstatechange = () => rpc.send.log({ connection: pc.connectionState });
pc.onicegatheringstatechange = () => rpc.send.log({ gathering: pc.iceGatheringState });
async function fail(error: unknown) {
  await rpc.request.report({ ...result, error: String(error) });
}
const candidates: RTCIceCandidateInit[] = [];
pc.onicecandidate = (e) => {
  if (e.candidate) rpc.send.signal({ candidate: e.candidate.toJSON() });
};
async function signal(data: Signal) {
  if (data.description) {
    await pc.setRemoteDescription(data.description);
    for (const c of candidates.splice(0)) await pc.addIceCandidate(c);
    if (data.description.type === "offer") {
      await pc.setLocalDescription(await pc.createAnswer());
      rpc.send.signal({ description: pc.localDescription!.toJSON() });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
    else candidates.push(data.candidate);
  }
}
function setup(dc: RTCDataChannel) {
  channel = dc;
  dc.binaryType = "arraybuffer";
  port = new NativeMessagePort((packet) => dc.send(JSON.stringify(packet)));
  dc.onmessage = (e) => {
    if (typeof e.data === "string") {
      if (e.data === "binary-ok") {
        binaryDone();
        return;
      }
      const packet = JSON.parse(e.data);
      if (id === 0) port.receive(packet);
      else rpc.send.orpc(packet);
    } else {
      const bytes = new Uint8Array(e.data);
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== (total + i) % 251) {
          void fail("二进制校验失败");
          return;
        }
      }
      total += bytes.length;
      if (total === 10 * 1024 * 1024) dc.send("binary-ok");
    }
  };
  dc.onopen = () => {
    document.body.textContent = "数据通道已连接";
    if (id === 0) void verify().catch(fail);
  };
}
pc.ondatachannel = (e) => setup(e.channel);
async function start() {
  setup(pc.createDataChannel("probe", { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  rpc.send.signal({ description: pc.localDescription!.toJSON() });
}
async function verify() {
  const client = createORPCClient<RouterClient<typeof router>>(new RPCLink({ port }));
  const text = "TARP 中文 RPC 验证";
  if ((await client.echo(text)) !== text) throw Error("RPC 返回不一致");
  result.checks.push("WebView→DataChannel→WebView→原生桥→Bun RPC 往返");
  const values = [];
  for await (const value of await client.stream()) values.push(value);
  if (JSON.stringify(values) !== "[0,1,2]") throw Error("订阅次序错误");
  result.checks.push("oRPC 三条订阅事件有序到达");
  const done = new Promise<void>((resolve) => (binaryDone = resolve));
  const started = performance.now();
  for (let offset = 0; offset < 10 * 1024 * 1024; offset += 16384) {
    while (channel.bufferedAmount > 256 * 1024) await new Promise((r) => setTimeout(r, 5));
    const chunk = new Uint8Array(16384);
    for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) % 251;
    channel.send(chunk);
  }
  await done;
  result.checks.push("10 MiB 二进制分块逐字节校验通过");
  result.binaryMs = Math.round(performance.now() - started);
  const stats = await pc.getStats();
  const pairs: NonNullable<ProbeResult["pairs"]> = [];
  stats.forEach((s: any) => {
    if (s.type === "candidate-pair" && s.state === "succeeded")
      pairs.push({
        state: s.state,
        nominated: s.nominated,
        localType: stats.get(s.localCandidateId)?.candidateType,
        remoteType: stats.get(s.remoteCandidateId)?.candidateType,
      });
  });
  result.pairs = pairs;
  result.state = pc.connectionState;
  await rpc.request.report(result);
  pc.close();
}
window.addEventListener("unhandledrejection", (event) => void fail(event.reason));
await rpc.request.ready();
