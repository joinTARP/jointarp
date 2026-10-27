import { cp, mkdir, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";

import { rendererCsp } from "../renderer-csp";
const desktop = resolve(import.meta.dirname, "../..");
const source = join(desktop, "out/desktop/dev-macos-arm64/TARP-dev.app");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw Error("此实验启动器目前只支持 macOS ARM64");
const mode = process.argv[2] ?? "host";
if (!["host", "cloudflare", "local", "listen", "join", "package"].includes(mode))
  throw Error("模式必须为 host、cloudflare、local、listen、join 或 package");
const destination = join(desktop, "out/webrtc-probe/Probe.app");
await cp(source, destination, {
  recursive: true,
  filter: (p) => !p.startsWith(join(source, "Contents/Resources/app")),
});
const resources = join(destination, "Contents/Resources");
await mkdir(join(resources, "app/views/main"), { recursive: true });
const alias = {
  "electrobun/main": join(desktop, ".hutch/devkit/api/sdks/main/index.ts"),
  "electrobun/view": join(desktop, ".hutch/devkit/api/browser/index.ts"),
};
for (const [entry, target, outdir, name] of [
  ["main.ts", "bun", "app/bun", "index.js"],
  ["view.ts", "browser", "app/views/main", "view.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dirname, entry)],
    target,
    plugins: [
      {
        name: "electrobun-sdk",
        setup(build) {
          build.onResolve({ filter: /^electrobun\/(main|view)$/ }, (args) => ({
            path: alias[args.path as keyof typeof alias],
          }));
        },
      },
    ],
    outdir: join(resources, outdir),
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
    name: "TARP-WebRTC-Probe",
    identifier: "party.jointarp.webrtc-probe",
  }),
);
await cp(
  join(import.meta.dirname, "启动测试.command"),
  join(desktop, "out/webrtc-probe/启动测试.command"),
);
await chmod(join(desktop, "out/webrtc-probe/启动测试.command"), 0o755);
if (mode === "package") {
  const distribution = join(desktop, "out/webrtc-probe/distribution/TARP-联机验证");
  await mkdir(distribution, { recursive: true });
  await cp(destination, join(distribution, "Probe.app"), { recursive: true });
  await cp(join(import.meta.dirname, "启动测试.command"), join(distribution, "启动测试.command"));
  await chmod(join(distribution, "启动测试.command"), 0o755);
  const sign = Bun.spawn(
    ["codesign", "--force", "--deep", "--sign", "-", join(distribution, "Probe.app")],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await sign.exited) throw Error("实验包临时签名失败");
  const archive = join(desktop, "out/webrtc-probe/TARP-联机验证-mac-arm64.zip");
  const zip = Bun.spawn(
    ["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", distribution, archive],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (await zip.exited) throw Error("实验包压缩失败");
  console.log("测试压缩包：" + archive);
  process.exit(0);
}
const child = Bun.spawn([join(destination, "Contents/MacOS/launcher")], {
  cwd: join(destination, "Contents/MacOS"),
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    TARP_WEBRTC_PROBE_MODE: mode,
    TARP_WEBRTC_PROBE_URL: process.argv[3] ?? "",
  },
});
process.exit(await child.exited);
