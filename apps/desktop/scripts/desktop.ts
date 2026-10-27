import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mode = process.argv[2] ?? "build";
if (!["dev", "build", "package", "dist"].includes(mode)) throw new Error(`未知桌面命令：${mode}`);

async function run(args: string[], env = process.env) {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdout: args[0] === "sips" ? "ignore" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await child.exited;
  if (code) throw new Error(`桌面命令执行失败（${code}）：${args.join(" ")}`);
}

await run(["bun", "run", "prepare:desktop"]);
const runtime = join(root, "out/runtime/node_modules");
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
const copied = new Set<string>();
async function copyDependency(name: string, from: string) {
  if (copied.has(name)) return;
  copied.add(name);
  const require = createRequire(join(from, "package.json"));
  let directory = dirname(require.resolve(name));
  for (;;) {
    const manifest = await readFile(join(directory, "package.json"), "utf8").catch(() => "{}");
    if (JSON.parse(manifest).name === name) break;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`找不到运行依赖：${name}`);
    directory = parent;
  }
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const destination = join(runtime, name);
  await cp(directory, destination, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relative = source.slice(directory.length + 1).replaceAll("\\", "/");
      if (relative === "node_modules" || relative.startsWith("node_modules/")) return false;
      return !/^(src|deps|test|tests|benchmark)(\/|$)/u.test(relative);
    },
  });
  if (name === "node-datachannel") {
    const nativeRequire = createRequire(join(directory, "package.json"));
    const candidates = Object.keys(manifest.optionalDependencies ?? {}).filter((dependency) => {
      try {
        nativeRequire.resolve(dependency);
        return true;
      } catch {
        return false;
      }
    });
    if (candidates.length !== 1)
      throw new Error("需要且只能安装当前平台的 node-datachannel 原生包");
    await copyDependency(candidates[0]!, directory);
  }
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    await copyDependency(dependency, directory);
  }
}
await copyDependency("quickjs-emscripten", root);
await copyDependency("node-datachannel", root);
const smoke = await Bun.build({
  entrypoints: [join(root, "scripts/runtime-smoke.ts")],
  outdir: join(root, "out/runtime"),
  naming: "smoke.js",
  target: "bun",
  external: ["quickjs-emscripten", "node-datachannel"],
});
if (!smoke.success) throw new AggregateError(smoke.logs, "分发运行时验收程序构建失败");

if (process.platform === "darwin") {
  const iconset = join(root, "out/icon.iconset");
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await run([
        "sips",
        "-z",
        String(size * scale),
        String(size * scale),
        "build/icon-mac.png",
        "--out",
        join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      ]);
    }
  }
}
await run(["bun", "../../scripts/tasks.ts", "run", "build:renderer", "--filter=./apps/desktop"]);
if (mode === "dev") {
  // Vite 提供页面热更新；Electrobun 监听主进程并重启。
  const vite = Bun.spawn(["bun", "--bun", "x", "--no-install", "vite"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  try {
    await run(["bun", "--bun", "x", "--no-install", "electrobun", "dev", "--watch"], {
      ...process.env,
      TARP_RENDERER_URL: "http://127.0.0.1:5173/",
    });
  } finally {
    vite.kill();
  }
} else {
  await run(
    [
      "bun",
      "--bun",
      "x",
      "--no-install",
      "electrobun",
      "build",
      `--env=${mode === "dist" ? "stable" : "dev"}`,
    ],
    { ...process.env, TARP_BUILD_CHANNEL: mode === "dist" ? "stable" : "dev" },
  );
}
