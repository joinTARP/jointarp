import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import type { RTCDataChannel } from "werift";

import type { ProbeRouter } from "../p2p-probe/router";
import { StreamPort } from "../p2p-probe/stream-port";
import { verify } from "../p2p-probe/verify";
import { ChannelStream } from "./channel-stream";
import { createPeer, summary, waitOpen } from "./peer";

const mode = process.argv[2] ?? "local";
if (!["local", "stun", "remote"].includes(mode)) throw Error("模式必须为 local、stun 或 remote");
const sshAlias = process.argv[3];
const remote = mode === "remote";
if (remote && (!sshAlias || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshAlias)))
  throw Error("remote 模式需要指定已授权的 SSH 别名");
const output = resolve(import.meta.dirname, "../../out/bun-webrtc-probe");
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).text();
  if (await child.exited) throw Error(`实验命令失败：${args[0]}`);
  return result.trim();
}
// 远程验收只交换 srflx 候选，拒绝退回局域网或云主机私网地址直连。
function description(peer: ReturnType<typeof createPeer>) {
  const local = peer.localDescription!;
  const sdp = remote
    ? local.sdp
        .split("\r\n")
        .filter((line) => !line.startsWith("a=candidate:") || line.includes(" typ srflx "))
        .join("\r\n")
    : local.sdp;
  if (remote && !sdp.includes(" typ srflx ")) throw Error("本端未取得 STUN srflx 候选");
  return { type: local.type, sdp };
}
let remoteDir: string | undefined;
let host: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">> | undefined;
const peer = createPeer(mode !== "local");
let port: StreamPort | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
try {
  if (remote) {
    await mkdir(output, { recursive: true });
    console.log("编译 Linux Bun WebRTC 独立程序…");
    await command([
      process.execPath,
      "build",
      "--compile",
      "--target=bun-linux-x64-baseline",
      join(import.meta.dirname, "host.ts"),
      "--outfile",
      join(output, "host-linux"),
    ]);
    remoteDir = await command([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshAlias!,
      "mktemp -d /tmp/tarp-rtc-probe.XXXXXXXXXX",
    ]);
    if (!/^\/tmp\/tarp-rtc-probe\.[a-zA-Z0-9]+$/.test(remoteDir)) throw Error("远端临时目录无效");
    await command(["scp", "-q", join(output, "host-linux"), `${sshAlias}:${remoteDir}/host`]);
  }
  host = Bun.spawn(
    remote
      ? [
          "ssh",
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          sshAlias!,
          `exec ${remoteDir}/host stun srflx`,
        ]
      : [process.execPath, join(import.meta.dirname, "host.ts"), mode],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  deadline = setTimeout(() => {
    console.error(
      "BUN_WEBRTC_RESULT",
      JSON.stringify({ error: "WebRTC 实验超过 35 秒", summary: summary(peer) }),
    );
    // 让现有进程清理路径继续执行，不留下远端常驻进程。
    host?.kill();
    void peer.close();
  }, 35_000);
  const channel = peer.createDataChannel("rpc", { ordered: true });
  const binary = peer.createDataChannel("binary", { ordered: true });
  await peer.setLocalDescription(await peer.createOffer());
  console.log("阶段：已完成本端 ICE 收集", JSON.stringify(summary(peer)));
  host.stdin.write(JSON.stringify(description(peer)) + "\n");
  const reader = host.stdout.getReader();
  let line = "";
  const decoder = new TextDecoder();
  try {
    while (!line.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw Error("远端未返回 SDP 就退出");
      line += decoder.decode(next.value, { stream: true });
      if (line.length > 96 * 1024) throw Error("远端信令超限");
    }
  } finally {
    reader.releaseLock();
  }
  const reply = JSON.parse(line.split("\n")[0]);
  if (reply.description?.type !== "answer" || typeof reply.description.sdp !== "string")
    throw Error("远端 SDP 无效");
  console.log("阶段：收到远端 ICE 摘要", JSON.stringify(reply.summary));
  await peer.setRemoteDescription(reply.description);
  host.stdin.end();
  await Promise.all([waitOpen(channel), waitOpen(binary)]);
  port = new StreamPort(new ChannelStream(channel));
  const client = createORPCClient<RouterClient<ProbeRouter>>(new RPCLink({ port }));
  const checks = await verify(client);
  await verifyBinary(binary);
  checks.push("独立数据通道 2 MiB 二进制分块逐字节校验通过");
  const path = summary(peer);
  if (
    !path.pairs.length ||
    path.pairs.some(
      (p) => !p || p.protocol !== "udp" || p.localType === "relay" || p.remoteType === "relay",
    )
  )
    throw Error("没有确认可用的非中继 ICE 路径");
  console.log(
    "BUN_WEBRTC_RESULT",
    JSON.stringify({
      implementation: "werift",
      runtime: Bun.version,
      scope: remote
        ? "Mac Bun ↔ Linux Bun，SDP 仅交换 STUN srflx，UDP 直连，无 TURN"
        : "本机两个独立 Bun 进程，非 NAT 穿透验收",
      checks,
      path,
    }),
  );
} finally {
  if (deadline) clearTimeout(deadline);
  port?.close();
  await peer.close();
  if (host) {
    host.stdin.end();
    const timer = setTimeout(() => host?.kill(), 2_000);
    await host.exited;
    clearTimeout(timer);
  }
  if (remoteDir && /^\/tmp\/tarp-rtc-probe\.[a-zA-Z0-9]+$/.test(remoteDir)) {
    await command([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshAlias!,
      `python3 -c 'import os; os.unlink("${remoteDir}/host"); os.rmdir("${remoteDir}")'`,
    ]);
    console.log("远端 WebRTC 实验文件已清理");
  }
}

async function verifyBinary(channel: RTCDataChannel) {
  const result = new Promise<void>((resolve, reject) => {
    channel.onMessage.subscribe((message) => {
      if (message === "binary-ok") resolve();
      else reject(Error("远端二进制校验失败"));
    });
    channel.stateChange.subscribe((state) => {
      if (state === "closed") reject(Error("二进制校验前数据通道关闭"));
    });
  });
  const sender = (async () => {
    for (let offset = 0; offset < 2 * 1024 * 1024; offset += 16 * 1024) {
      while (channel.bufferedAmount > 256 * 1024) {
        if (channel.readyState !== "open") throw Error("二进制发送时通道断开");
        await Bun.sleep(5);
      }
      const chunk = Buffer.alloc(16 * 1024);
      for (let i = 0; i < chunk.length; i++) chunk[i] = (offset + i) % 251;
      channel.send(chunk);
    }
  })();
  await Promise.all([sender, result]);
}
