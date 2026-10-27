import { join } from "node:path";

import { createPeer, connect } from "./peer";

export async function startSession() {
  const peer = await createPeer();
  const remoteDir = process.env.TARP_P2P_PROBE_REMOTE_DIR;
  const remoteAddress = process.env.TARP_P2P_PROBE_REMOTE_IP;
  const sshAlias = process.env.TARP_P2P_PROBE_SSH;
  if (
    remoteDir &&
    (!sshAlias ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshAlias) ||
      !/^\/tmp\/tarp-p2p-probe\.[a-zA-Z0-9]+$/.test(remoteDir) ||
      !remoteAddress ||
      !/^\d{1,3}(\.\d{1,3}){3}$/.test(remoteAddress))
  ) {
    await peer.stop();
    throw Error("非法远程实验配置");
  }
  const hostFile = join(import.meta.dirname, "host.js");
  const host = Bun.spawn(
    remoteDir
      ? [
          "ssh",
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          sshAlias!,
          `exec env TARP_P2P_PROBE_LISTEN=0.0.0.0 ${remoteDir}/host ${peer.peerId}`,
        ]
      : [
          process.execPath,
          (await Bun.file(hostFile).exists()) ? hostFile : join(import.meta.dirname, "host.ts"),
          peer.peerId.toString(),
        ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    host.stdin.end();
    // EOF 应让宿主自行清理；异常情况下终止 SSH/本地子进程。
    const timer = setTimeout(() => host.kill(), 2_000);
    await Promise.allSettled([host.exited, peer.stop()]);
    clearTimeout(timer);
  };
  try {
    const reader = host.stdout.getReader();
    const decoder = new TextDecoder();
    let line = "";
    const timer = setTimeout(() => host.kill(), 15_000);
    try {
      while (!line.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw Error("房主子进程未返回地址就退出");
        line += decoder.decode(chunk.value, { stream: true });
        if (line.length > 8192) throw Error("房主返回的地址信息过长");
      }
    } finally {
      reader.releaseLock();
      clearTimeout(timer);
    }
    const info = JSON.parse(line.split("\n")[0]);
    if (typeof info.address !== "string" || typeof info.pid !== "number")
      throw Error("房主地址无效");
    if (!remoteDir && info.pid === process.pid) throw Error("房主没有运行于独立进程");
    const address = remoteDir
      ? info.address.replace(/^\/ip4\/[^/]+\//, `/ip4/${remoteAddress}/`)
      : info.address;
    const connection = await connect(peer, address);
    return { ...connection, host, peer, stop, remote: Boolean(remoteDir) };
  } catch (error) {
    await stop();
    throw error;
  }
}
