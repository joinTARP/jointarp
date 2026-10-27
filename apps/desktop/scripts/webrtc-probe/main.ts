import dgram from "node:dgram";
import { networkInterfaces } from "node:os";

import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { BrowserWindow, BrowserView, Utils } from "electrobun/main";
import { z } from "zod";

import { NativeMessagePort } from "../../src/shared/native-bridge";
import type { ProbeBridge, ProbeResult, Signal } from "./shared";
import { startSignaling } from "./signaling";
// 本机 STUN 只用于区分宿主传输故障与外部网络故障，不是生产服务。
const mode = process.env.TARP_WEBRTC_PROBE_MODE ?? "host";
let iceServers: { urls: string }[] =
  mode === "cloudflare" ? [{ urls: "stun:stun.cloudflare.com:3478" }] : [];
if (mode === "local" || mode === "listen") {
  const stun = dgram.createSocket("udp4");
  stun.on("message", (packet, remote) => {
    if (packet.length < 20 || packet.readUInt16BE(0) !== 1 || packet.readUInt32BE(4) !== 0x2112a442)
      return;
    const response = Buffer.alloc(32);
    response.writeUInt16BE(0x101, 0);
    response.writeUInt16BE(12, 2);
    packet.copy(response, 4, 4, 20);
    response.writeUInt16BE(0x20, 20);
    response.writeUInt16BE(8, 22);
    response[25] = 1;
    response.writeUInt16BE(remote.port ^ 0x2112, 26);
    const cookie = [0x21, 0x12, 0xa4, 0x42];
    remote.address.split(".").forEach((v, i) => (response[28 + i] = Number(v) ^ cookie[i]));
    stun.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => stun.bind(0, "0.0.0.0", resolve));
  const localAddress = Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === "IPv4" && !a.internal)?.address;
  if (!localAddress) throw Error("没有可用于本机 STUN 对照的 IPv4 地址");
  iceServers = [{ urls: "stun:" + localAddress + ":" + stun.address().port }];
}
export const router = {
  echo: os.input(z.string()).handler(({ input }) => input),
  stream: os.handler(async function* () {
    for (let i = 0; i < 3; i++) yield i;
  }),
};
const network = mode === "listen" || mode === "join";
const peers: ReturnType<typeof BrowserView.defineRPC<ProbeBridge>>[] = [];
let finished = false;
const timer = setTimeout(
  () =>
    finish({
      scope: network ? "双机模式" : "单机",
      origin: "",
      secure: false,
      peer: "",
      checks: [],
      error: "等待连接或验证超时",
    }),
  network ? 180000 : 45000,
);
function finish(result: ProbeResult) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log("PROBE_RESULT", JSON.stringify(result));
  if (mode === "join") remote?.send(JSON.stringify({ kind: "result", data: result }));
  setTimeout(() => {
    signaling?.stop();
    Utils.quit(result.error ? 1 : 0);
  }, 500);
}
let ready = false,
  remoteReady = false;
let signaling: ReturnType<typeof startSignaling> | undefined;
let remote: WebSocket | undefined;
function maybeStart() {
  if (ready && remoteReady) {
    remoteReady = false;
    signaling!.send({ kind: "start" });
  }
}
if (mode === "listen") {
  signaling = startSignaling({
    iceServers,
    onSignal: (data) => peers[1].send.signal(data),
    onReady: () => {
      remoteReady = true;
      maybeStart();
    },
    onResult: finish,
    onClose: () => {
      if (!finished)
        finish({
          scope: "双机模式",
          origin: "",
          secure: false,
          peer: "",
          checks: [],
          error: "信令连接已关闭",
        });
    },
  });
  for (const item of Object.values(networkInterfaces()).flat())
    if (item?.family === "IPv4" && !item.internal)
      console.log(
        "加入地址：ws://" +
          item.address +
          ":" +
          signaling.port +
          "/signal?token=" +
          signaling.token,
      );
  console.log("等待另一台 Mac 加入（3 分钟）");
}
if (mode === "join") {
  const url = new URL(process.env.TARP_WEBRTC_PROBE_URL ?? "");
  if (!["ws:", "wss:"].includes(url.protocol)) throw Error("加入地址必须为 ws:// 或 wss://");
  remote = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    remote!.onerror = () => reject(Error("无法连接房主信令服务"));
    remote!.onclose = () => reject(Error("房主拒绝或关闭连接"));
    remote!.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.kind !== "config") throw Error("缺少连接配置");
        iceServers = z.array(z.object({ urls: z.string() })).parse(data.iceServers);
        resolve();
      } catch (error) {
        reject(error);
      }
    };
  });
  remote.onmessage = (event) => {
    const packet = JSON.parse(String(event.data));
    if (packet.kind === "start") peers[0].send.start({});
    else if (packet.kind === "signal") peers[0].send.signal(packet.data);
  };
  remote.onclose = () => {
    if (!finished)
      finish({
        scope: "双机模式",
        origin: "",
        secure: false,
        peer: "",
        checks: [],
        error: "房主信令连接已关闭",
      });
  };
}
for (const id of network ? [mode === "listen" ? 1 : 0] : [0, 1]) {
  let port: NativeMessagePort;
  const rpc = BrowserView.defineRPC<ProbeBridge>({
    handlers: {
      requests: {
        config: () => ({ iceServers, mode }),
        ready: () => {
          console.log("READY", id);
          if (mode === "listen") {
            ready = true;
            maybeStart();
          } else if (mode === "join") remote!.send(JSON.stringify({ kind: "ready" }));
          else if (ready) peers[0].send.start({});
          else ready = true;
          return id;
        },
        report: (result) => {
          finish(result);
          return true;
        },
      },
      messages: {
        signal: (data: Signal) => {
          if (mode === "listen") signaling!.send({ kind: "signal", data });
          else if (mode === "join") remote!.send(JSON.stringify({ kind: "signal", data }));
          else peers[1 - id].send.signal(data);
        },
        orpc: (packet) => port.receive(packet),
        log: (data) => console.log("TRACE", id, JSON.stringify(data)),
      },
    },
  });
  port = new NativeMessagePort((packet) => rpc.send.orpc(packet));
  new RPCHandler(router).upgrade(port, { context: {} });
  peers[id] = rpc;
  const window = new BrowserWindow({
    title: `TARP WebRTC 验证 ${network ? (id === 1 ? "房主" : "加入者") : id}`,
    renderer: "native",
    url: `views://main/index.html#${id}`,
    rpc,
    frame: { x: 100 + id * 620, y: 100, width: 600, height: 300 },
    allowedProtocols: { views: true, appData: false },
  });
  window.on("close", () => {
    port.close();
    if (!finished) Utils.quit(1);
  });
}
