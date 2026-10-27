import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSession,
  readRoomState,
  setSessionStatus,
} from "@jointarp/core/node/sessions/session-store";
import { writeTestFile } from "@jointarp/module/testing/files";

import { loadLocalSessionModuleResources } from "../sessions/local-room-resources";
import { ModuleCache, ModulePublisher, type ModuleManifest } from "./module-cache";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-module-cache-"));
  const source = join(root, "source"),
    sessions = join(root, "sessions");
  await writeTestFile(
    join(source, "module.json"),
    JSON.stringify({ name: "缓存测试", description: "完整模组" }),
  );
  await writeTestFile(join(source, ".types", "规则.fields.json"), "{}");
  await writeTestFile(join(source, "规则", "开始.md"), "需要重复压缩的规则文字。".repeat(3000));
  await writeTestFile(join(source, "hidden.txt"), "模组内的隐藏剧情也完整同步");
  await writeTestFile(join(source, "cover.webp"), "已经压缩的图片测试内容");
  const room = await createSession(sessions, source, "房间");
  await writeTestFile(join(sessions, room.id, "host-private.txt"), "房主私有数据不应传输");
  const module = join(sessions, room.id, "module");
  const publisher = new ModulePublisher(
    module,
    () => loadLocalSessionModuleResources(sessions, room.id),
    async () => (await readRoomState(sessions, room.id)).state.room,
  );
  const requests: { path: string; status: number }[] = [];
  let bodyBytes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await publisher.handle(request);
      bodyBytes += (await response.clone().arrayBuffer()).byteLength;
      requests.push({ path: new URL(request.url).pathname, status: response.status });
      return response;
    },
  });
  const cacheRoot = join(root, "cache");
  const cache = new ModuleCache(cacheRoot);
  const request = (path: string, headers?: Record<string, string>) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      headers: { "Accept-Encoding": "gzip", ...headers },
      signal: AbortSignal.timeout(5000),
    });
  const manifest = async () =>
    JSON.parse(
      await readFile(join(cacheRoot, "rooms", `${room.id}.json`), "utf8"),
    ) as ModuleManifest;
  return {
    root,
    bodyBytes: () => bodyBytes,
    module,
    source,
    sessions,
    room,
    publisher,
    requests,
    cacheRoot,
    cache,
    request,
    manifest,
    async close() {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("完整模组持久缓存：首次压缩、重启命中、文件增删差量、跨房复用和图片", async () => {
  const f = await fixture();
  try {
    const resources = await f.cache.sync(f.room.id, f.request);
    const initial = await f.manifest();
    const firstBytes = f.bodyBytes();
    assert(firstBytes > 0);
    assert.equal(initial.version, resources.baseline.version);
    assert(initial.files.some((file) => file.path === "hidden.txt"));
    assert(!initial.files.some((file) => file.path.includes("host-private")));
    for (const file of initial.files)
      assert.deepEqual(
        await readFile(join(f.cacheRoot, "blobs", file.hash)),
        await readFile(join(f.module, file.path)),
      );
    const markdown = initial.files.find((file) => file.path.endsWith("开始.json"))!;
    const tag = initial.version;
    const compressed = await f.publisher.handle(
      new Request(`http://local/module/blob/${markdown.hash}?version=${tag}`, {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );
    assert.equal(compressed.headers.get("Content-Encoding"), "gzip");
    const zipped = new Uint8Array(await compressed.arrayBuffer());
    assert(zipped.length < markdown.size / 4);
    assert.deepEqual(
      Buffer.from(Bun.gunzipSync(zipped)),
      await readFile(join(f.module, markdown.path)),
    );
    const picture = initial.files.find((file) => file.path === "cover.webp")!;
    const imageResponse = await f.publisher.handle(
      new Request(`http://local/module/blob/${picture.hash}?version=${tag}`, {
        headers: { "Accept-Encoding": "gzip" },
      }),
    );
    assert.equal(imageResponse.headers.get("Content-Encoding"), null);

    assert.deepEqual(
      await f.cache.imageCandidate(f.room.id, new URL("http://local/?path=&image=cover.webp")),
      { hash: picture.hash, file: join(f.cacheRoot, "blobs", picture.hash) },
    );
    f.requests.length = 0;
    const restored = new ModuleCache(f.cacheRoot);
    await restored.sync(f.room.id, f.request);
    assert.deepEqual(f.requests, [{ path: "/module/manifest", status: 304 }]);
    assert.equal(f.bodyBytes(), firstBytes, "重连不传响应正文（仍有 HTTP 头）");
    await setSessionStatus(f.sessions, f.room.id, "ended");
    f.requests.length = 0;
    assert.equal((await restored.sync(f.room.id, f.request)).room.status, "ended");
    assert.deepEqual(f.requests, [{ path: "/module/manifest", status: 200 }]);
    await setSessionStatus(f.sessions, f.room.id, "active");
    await chmod(join(f.module, markdown.path), 0o600);
    await writeFile(
      join(f.module, markdown.path),
      JSON.stringify({ body: "更新后的规则".repeat(2000) }),
    );
    await writeFile(join(f.module, "new.txt"), "新增资料");
    await rm(join(f.module, "hidden.txt"));
    f.requests.length = 0;
    await restored.sync(f.room.id, f.request);
    const changed = await f.manifest();
    assert.notEqual(changed.version, initial.version);
    assert(!changed.files.some((file) => file.path === "hidden.txt"));
    const missing = new Set(
      [...changed.files, changed.resources]
        .filter(
          (file) => ![...initial.files, initial.resources].some((old) => old.hash === file.hash),
        )
        .map((file) => `/module/blob/${file.hash}`),
    );
    assert.deepEqual(
      new Set(
        f.requests
          .filter((request) => request.path.includes("/blob/"))
          .map((request) => request.path),
      ),
      missing,
    );
    const second = await createSession(f.sessions, f.source, "第二个房间");
    const publisher = new ModulePublisher(
      join(f.sessions, second.id, "module"),
      () => loadLocalSessionModuleResources(f.sessions, second.id),
      async () => (await readRoomState(f.sessions, second.id)).state.room,
    );
    const transferred: string[] = [];
    await restored.sync(second.id, async (path, headers) => {
      transferred.push(path);
      return publisher.handle(new Request(`http://local${path}`, { headers }));
    });
    assert.equal(
      transferred.filter((path) => path.includes("/blob/")).length,
      0,
      "同模组不同房间复用全部静态资料，只传清单",
    );
  } finally {
    await f.close();
  }
});

test("缓存损坏会重下，下载被篡改或中断不发布半份清单，恢复后复用已验证文件", async () => {
  const f = await fixture();
  try {
    await f.cache.sync(f.room.id, f.request);
    const before = await f.manifest();
    const corrupt = before.files[0]!;
    await writeFile(join(f.cacheRoot, "blobs", corrupt.hash), "损坏");
    f.requests.length = 0;
    await f.cache.sync(f.room.id, f.request);
    assert.equal(f.requests.filter((request) => request.path.includes("/blob/")).length, 1);
    const pointer = await readFile(join(f.cacheRoot, "rooms", `${f.room.id}.json`), "utf8");
    await writeFile(join(f.module, "a-new.txt"), "第一个新增文件");
    await writeFile(join(f.module, "b-new.txt"), "第二个新增文件");
    let downloads = 0;
    await assert.rejects(
      f.cache.sync(f.room.id, async (path, headers) => {
        if (path.includes("/blob/") && ++downloads === 2) return new Response("伪造内容");
        return f.request(path, headers);
      }),
      /校验失败/,
    );
    assert.equal(await readFile(join(f.cacheRoot, "rooms", `${f.room.id}.json`), "utf8"), pointer);
    assert(!(await readdir(join(f.cacheRoot, "blobs"))).some((path) => path.endsWith(".tmp")));
    f.requests.length = 0;
    await new ModuleCache(f.cacheRoot).sync(f.room.id, f.request);
    assert.equal(
      f.requests.filter((request) => request.path.includes("/blob/")).length,
      1,
      "只补齐第二个新文件，静态资料不受附件变化影响",
    );
    const published = await readFile(join(f.cacheRoot, "rooms", `${f.room.id}.json`), "utf8");
    await writeFile(join(f.module, "cancelled.txt"), "取消传输");
    const controller = new AbortController();
    await assert.rejects(
      f.cache.sync(
        f.room.id,
        async (path, headers) => {
          const response = await f.request(path, headers);
          if (path.includes("/blob/")) controller.abort();
          return response;
        },
        controller.signal,
      ),
    );
    assert.equal(
      await readFile(join(f.cacheRoot, "rooms", `${f.room.id}.json`), "utf8"),
      published,
    );
  } finally {
    await f.close();
  }
});

test("清单校验与发布边界：拒绝跨房、越界、伪造版本、符号链接和超过声明大小的数据", async () => {
  const f = await fixture();
  try {
    await f.cache.sync(f.room.id, f.request);
    const manifest = await f.manifest();
    for (const altered of [
      { ...manifest, roomId: randomUUID() },
      { ...manifest, version: "0".repeat(64) },
      { ...manifest, files: [{ ...manifest.files[0], path: "../../secret" }] },
    ])
      await assert.rejects(f.cache.sync(f.room.id, async () => Response.json(altered)));
    const blob = manifest.files[0]!;
    await rm(join(f.cacheRoot, "blobs", blob.hash));
    await assert.rejects(
      f.cache.sync(f.room.id, async (path, headers) =>
        path.includes("/blob/")
          ? new Response(new Uint8Array(blob.size + 1))
          : f.request(path, headers),
      ),
      /超过清单大小/,
    );
    assert(!(await readdir(join(f.cacheRoot, "blobs"))).some((path) => path.endsWith(".tmp")));
    await writeFile(join(f.root, "outside.txt"), "外部秘密");
    await symlink(join(f.root, "outside.txt"), join(f.module, "escape.txt"));
    await assert.rejects(
      f.publisher.handle(new Request("http://local/module/manifest")),
      /符号链接|不允许|无效/,
    );
  } finally {
    await f.close();
  }
});

test("房间信息刷新不打断进行中的下载，模组版本变化仍拒绝旧请求", async () => {
  const f = await fixture();
  try {
    let refreshed = false;
    await f.cache.sync(f.room.id, async (path, headers) => {
      if (!refreshed && path.includes("/blob/")) {
        refreshed = true;
        await setSessionStatus(f.sessions, f.room.id, "ended");
        await f.request("/module/manifest");
      }
      return f.request(path, headers);
    });
    assert(refreshed);
    assert.equal((await f.cache.sync(f.room.id, f.request)).room.status, "ended");
    const before = await f.manifest();
    const picture = before.files.find((file) => file.path === "cover.webp")!;
    const source = new URL("http://local/?path=&image=cover.webp");
    assert.equal((await f.cache.imageCandidate(f.room.id, source))?.hash, picture.hash);
    await chmod(join(f.module, "cover.webp"), 0o600);
    await writeFile(join(f.module, "cover.webp"), "新图片");
    await f.cache.sync(f.room.id, f.request);
    const updated = await f.cache.imageCandidate(f.room.id, source);
    assert(updated);
    assert.notEqual(updated.hash, picture.hash);
    assert.equal(await readFile(updated.file, "utf8"), "新图片");
    const stale = await f.request(`/module/blob/${picture.hash}?version=${before.version}`);
    assert.equal(stale.status, 409);
    await rm(join(f.module, "cover.webp"));
    await f.cache.sync(f.room.id, f.request);
    assert.equal(await f.cache.imageCandidate(f.room.id, source), undefined);
    await rm(join(f.cacheRoot, "rooms", `${f.room.id}.json`));
    assert.equal(await f.cache.imageCandidate(f.room.id, source), undefined);
  } finally {
    await f.close();
  }
});
