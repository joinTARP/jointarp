import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { rendererCsp } from "../renderer-csp";

const mode = process.argv[2] ?? "local";
if (!["local", "remote", "remote-headless"].includes(mode))
  throw Error("模式必须为 local、remote 或 remote-headless");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("此启动器目前只支持 macOS ARM64");
const desktop = resolve(import.meta.dirname, "../..");
const output = join(desktop, "out/p2p-probe");
await mkdir(output, { recursive: true });
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const result = await new Response(child.stdout).text();
  if (await child.exited) throw Error(`实验命令失败：${args[0]}`);
  return result.trim();
}
const remote = mode !== "local";
const sshAlias = process.argv[3];
if (remote && (!sshAlias || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(sshAlias)))
  throw Error("远程模式需要指定已配置的 SSH 别名");
let remoteDir: string | undefined;
const env = { ...process.env };
try {
  if (remote) {
    const config = await command(["ssh", "-G", sshAlias!]);
    const ip = config.match(/^hostname (.+)$/m)?.[1];
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw Error("SSH 别名需要明确的 IPv4 地址");
    console.log("编译 Linux x64 独立实验程序…");
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
      "mktemp -d /tmp/tarp-p2p-probe.XXXXXXXXXX",
    ]);
    if (!/^\/tmp\/tarp-p2p-probe\.[a-zA-Z0-9]+$/.test(remoteDir)) throw Error("远端临时目录无效");
    await command(["scp", "-q", join(output, "host-linux"), `${sshAlias}:${remoteDir}/host`]);
    env.TARP_P2P_PROBE_SSH = sshAlias;
    env.TARP_P2P_PROBE_REMOTE_DIR = remoteDir;
    env.TARP_P2P_PROBE_REMOTE_IP = ip;
  }
  let args: string[];
  if (mode === "remote-headless") {
    args = [process.execPath, join(import.meta.dirname, "headless.ts")];
  } else {
    const source = join(desktop, "out/desktop/dev-macos-arm64/TARP-dev.app");
    const destination = join(output, "Probe.app");
    await cp(source, destination, {
      recursive: true,
      filter: (path) => !path.startsWith(join(source, "Contents/Resources/app")),
    });
    const resources = join(destination, "Contents/Resources");
    await mkdir(join(resources, "app/views/main"), { recursive: true });
    const aliases: Record<string, string> = {
      "electrobun/main": join(desktop, ".hutch/devkit/api/sdks/main/index.ts"),
      "electrobun/view": join(desktop, ".hutch/devkit/api/browser/index.ts"),
    };
    for (const [file, target, folder, name] of [
      ["main.ts", "bun", "app/bun", "index.js"],
      ["host.ts", "bun", "app/bun", "host.js"],
      ["view.ts", "browser", "app/views/main", "view.js"],
    ] as const) {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dirname, file)],
        target,
        plugins: [
          {
            name: "electrobun-sdk",
            setup(build) {
              build.onResolve({ filter: /^electrobun\/(main|view)$/ }, ({ path }) => ({
                path: aliases[path],
              }));
            },
          },
        ],
        outdir: join(resources, folder),
        naming: name,
      });
      if (!result.success) throw new AggregateError(result.logs);
    }
    const html =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><script type="module" src="./view.js"></script></head><body></body></html>';
    await Bun.write(
      join(resources, "app/views/main/index.html"),
      html.replace(
        '<meta charset="utf-8">',
        `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${rendererCsp(html)}">`,
      ),
    );
    const version = await Bun.file(join(resources, "version.json")).json();
    await Bun.write(
      join(resources, "version.json"),
      JSON.stringify({
        ...version,
        name: "TARP-P2P-Probe",
        identifier: "party.jointarp.p2p-probe",
      }),
    );
    args = [join(destination, "Contents/MacOS/launcher")];
  }
  const child = Bun.spawn(args, {
    cwd: mode === "remote-headless" ? desktop : join(output, "Probe.app/Contents/MacOS"),
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await child.exited;
} finally {
  if (remoteDir && /^\/tmp\/tarp-p2p-probe\.[a-zA-Z0-9]+$/.test(remoteDir)) {
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
    console.log("远程实验文件已清理");
  }
}
