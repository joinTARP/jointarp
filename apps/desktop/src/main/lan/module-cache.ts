import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { join, posix } from "node:path";

import { withFileMutation } from "@jointarp/core/node/storage/file-queue";
import { isInsideDirectory } from "@jointarp/core/node/storage/path";
import { writeFileAtomic } from "@jointarp/core/node/storage/write-file-atomic";
import type { SessionModuleResources } from "@jointarp/core/shared/room-state";
import { stableJson } from "@jointarp/core/shared/room-state-schema";
import { gameRoomSchema, type GameRoom } from "@jointarp/core/shared/session";
import { z } from "zod";

const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCES = 32 * 1024 * 1024;
const MAX_MANIFEST = 8 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const blobSchema = z.object({ hash: hashSchema, size: z.number().int().min(0).max(MAX_FILE) });
const manifestSchema = z.object({
  roomId: z.string().uuid(),
  room: gameRoomSchema,
  version: hashSchema,
  resources: blobSchema.extend({ size: z.number().int().min(0).max(MAX_RESOURCES) }),
  files: z.array(blobSchema.extend({ path: z.string().min(1).max(2048) })).max(10_000),
});
export type ModuleManifest = z.infer<typeof manifestSchema>;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const textFile = /\.(json|md|markdown|txt|toml|yaml|yml|csv|html|css|js|ts|xml|svg)$/i;

function parseManifest(value: unknown): ModuleManifest {
  const manifest = manifestSchema.parse(value);
  if (manifest.room.id !== manifest.roomId) throw new Error("模组清单房间信息不一致");
  const paths = new Set<string>();
  let total = manifest.resources.size;
  const version = createHash("sha256");
  for (const file of manifest.files) {
    if (
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      paths.has(file.path)
    )
      throw new Error("模组缓存清单路径无效");
    paths.add(file.path);
    total += file.size;
    if (total > MAX_TOTAL) throw new Error("模组超过同步容量（2 GiB）");
    version.update(stableJson([file.path, file.hash]));
  }
  if (version.digest("hex") !== manifest.version) throw new Error("模组清单校验失败");
  return manifest;
}

function fileStamp(stat: Awaited<ReturnType<typeof lstat>>) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/** 每次仍检查文件元数据；内容未变时复用已校验哈希，不重复读取整个文件。 */
class FileDigests {
  private verified = new Map<string, { stamp: string; hash: string; size: number }>();
  async read(path: string) {
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_FILE) throw new Error("模组包含无效或过大的文件");
    const stamp = fileStamp(before);
    const cached = this.verified.get(path);
    if (cached?.stamp === stamp) return { hash: cached.hash, size: cached.size };
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || fileStamp(opened) !== stamp)
        throw new Error("模组文件在同步时发生变化");
      const digest = createHash("sha256");
      let size = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > MAX_FILE) throw new Error("模组文件超过同步容量");
        digest.update(chunk);
      }
      if (fileStamp(await file.stat()) !== stamp || size !== before.size)
        throw new Error("模组文件在同步时发生变化");
      const value = { hash: digest.digest("hex"), size };
      if (this.verified.size >= 10_001) this.verified.clear();
      this.verified.set(path, { stamp, ...value });
      return value;
    } finally {
      await file.close();
    }
  }
}

async function regularFile(root: string, path: string) {
  const target = join(root, path);
  const resolved = await realpath(target);
  if (!isInsideDirectory(root, resolved) || resolved !== target || !(await lstat(target)).isFile())
    throw new Error("模组包含符号链接或非法文件");
  return target;
}

function responseBody(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  compressed: boolean,
  headers: HeadersInit = {},
) {
  return new Response(compressed ? body.pipeThrough(new CompressionStream("gzip")) : body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
      ...(compressed ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
    },
  });
}

/** 只发布冻结模组目录与客户端所需资料，存档的其他文件不进入清单。 */
export class ModulePublisher {
  private digests = new FileDigests();
  private snapshot?: {
    manifest: ModuleManifest;
    tag: string;
    serialized: string;
    resources: Uint8Array<ArrayBuffer>;
    filesByHash: Map<string, ModuleManifest["files"][number]>;
  };
  private refreshing?: Promise<NonNullable<ModulePublisher["snapshot"]>>;
  constructor(
    private root: string,
    private resources: () => Promise<SessionModuleResources>,
    private room: () => Promise<GameRoom>,
  ) {}
  private async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const root = await realpath(this.root);
      const digests = this.digests;
      const files: ModuleManifest["files"] = [];
      let total = 0;
      async function walk(prefix: string) {
        const entries = (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );
        for (const entry of entries) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) throw new Error("冻结模组不允许符号链接");
          if (entry.isDirectory()) {
            if ((await realpath(join(root, path))) !== join(root, path))
              throw new Error("冻结模组目录已变化");
            await walk(path);
          } else if (entry.isFile()) {
            const digest = await digests.read(await regularFile(root, path));
            files.push({ path, ...digest });
            total += digest.size;
            if (files.length > 10_000 || total > MAX_TOTAL) throw new Error("模组超过同步容量");
          } else throw new Error("冻结模组包含特殊文件");
        }
      }
      await walk("");
      const versionHash = createHash("sha256");
      for (const file of files) versionHash.update(stableJson([file.path, file.hash]));
      const version = versionHash.digest("hex");
      let bytes = this.snapshot?.resources;
      let resourceDigest = this.snapshot?.manifest.resources;
      let room: GameRoom;
      if (!this.snapshot || this.snapshot.manifest.version !== version) {
        const { room: currentRoom, ...resources } = await this.resources();
        if (resources.baseline.version !== version) throw new Error("模组文件在同步时发生变化");
        room = currentRoom;
        // 房间信息和基线版本放在小清单中，避免图片更新或房间改名重传整份资料。
        bytes = new TextEncoder().encode(
          JSON.stringify({ ...resources, baseline: { entities: resources.baseline.entities } }),
        );
        resourceDigest = { hash: hash(bytes), size: bytes.length };
      } else room = await this.room();
      const manifest = parseManifest({
        roomId: room.id,
        room,
        version,
        resources: resourceDigest,
        files,
      });
      const serialized = JSON.stringify(manifest);
      if (Buffer.byteLength(serialized) > MAX_MANIFEST) throw new Error("模组清单超过同步容量");
      const tag = hash(serialized);
      const filesByHash =
        this.snapshot?.manifest.version === version
          ? this.snapshot.filesByHash
          : new Map(files.map((file) => [file.hash, file]));
      const snapshot = { manifest, tag, serialized, resources: bytes!, filesByHash };
      this.snapshot = snapshot;
      return snapshot;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const gzip = /\bgzip\b/.test(request.headers.get("Accept-Encoding") ?? "");
    if (url.pathname === "/module/manifest") {
      const snapshot = await this.refresh();
      const etag = `"${snapshot.tag}"`;
      if (request.headers.get("If-None-Match") === etag)
        return new Response(null, { status: 304, headers: { ETag: etag } });
      return responseBody(new Blob([snapshot.serialized]).stream(), gzip, {
        ETag: etag,
      });
    }
    const match = /^\/module\/blob\/([a-f0-9]{64})$/.exec(url.pathname);
    const snapshot = this.snapshot;
    if (!match || !snapshot) return new Response(null, { status: 404 });
    if (url.searchParams.get("version") !== snapshot.manifest.version)
      return new Response(null, { status: 409 });
    if (match[1] === snapshot.manifest.resources.hash)
      return responseBody(new Blob([snapshot.resources]).stream(), gzip);
    const file = snapshot.filesByHash.get(match[1]!);
    if (!file) return new Response(null, { status: 404 });
    const root = await realpath(this.root);
    const target = await regularFile(root, file.path);
    const current = await this.digests.read(target);
    if (current.hash !== file.hash || current.size !== file.size)
      return new Response(null, { status: 409 });
    return responseBody(
      Bun.file(target).stream(),
      gzip && file.size >= 1024 && textFile.test(file.path),
    );
  }
  async imageHash(path: string) {
    const root = await realpath(this.root);
    if (!isInsideDirectory(root, path)) return undefined;
    return (await this.digests.read(path)).hash;
  }
}

async function boundedBytes(response: Response, max: number) {
  if (!response.body) throw new Error("同步响应没有内容");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) throw new Error("同步响应超过容量");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

type RequestModule = (path: string, headers?: Record<string, string>) => Promise<Response>;
/** 内容按哈希存储；完整清单只在全部文件校验通过后原子发布。 */
export class ModuleCache {
  private digests = new FileDigests();
  private imageIndex?: {
    pointer: string;
    stamp: string;
    files: Map<string, ModuleManifest["files"][number]>;
  };
  constructor(readonly directory: string) {}
  private blob(hash: string) {
    return join(this.directory, "blobs", hashSchema.parse(hash));
  }
  private async valid(blob: { hash: string; size: number }) {
    try {
      const actual = await this.digests.read(this.blob(blob.hash));
      return actual.hash === blob.hash && actual.size === blob.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
      return false;
    }
  }
  private async download(
    blob: { hash: string; size: number },
    version: string,
    request: RequestModule,
    signal?: AbortSignal,
  ) {
    if (await this.valid(blob)) return;
    signal?.throwIfAborted();
    const response = await request(`/module/blob/${blob.hash}?version=${version}`);
    if (!response.ok || !response.body) throw new Error("模组下载失败，请重试同步");
    const target = this.blob(blob.hash),
      temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    const reader = response.body.getReader();
    let size = 0;
    const digest = createHash("sha256");
    try {
      for (;;) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > blob.size) throw new Error("下载文件超过清单大小");
        digest.update(value);
        await file.writeFile(value);
      }
      if (size !== blob.size || digest.digest("hex") !== blob.hash)
        throw new Error("下载文件哈希校验失败");
      signal?.throwIfAborted();
      await file.close();
      await rename(temporary, target);
    } finally {
      await file.close();
      await reader.cancel().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
  async sync(
    roomId: string,
    request: RequestModule,
    signal?: AbortSignal,
  ): Promise<SessionModuleResources> {
    z.string().uuid().parse(roomId);
    const pointer = join(this.directory, "rooms", `${roomId}.json`);
    return withFileMutation(pointer, async () => {
      await mkdir(join(this.directory, "blobs"), { recursive: true, mode: 0o700 });
      await mkdir(join(this.directory, "rooms"), { recursive: true, mode: 0o700 });
      let previous: ModuleManifest | undefined;
      try {
        previous = parseManifest(JSON.parse(await readFile(pointer, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
      }
      const previousTag = previous && hash(JSON.stringify(previous));
      signal?.throwIfAborted();
      const response = await request(
        "/module/manifest",
        previousTag ? { "If-None-Match": `"${previousTag}"` } : {},
      );
      let manifest: ModuleManifest;
      if (response.status === 304 && previous) manifest = previous;
      else {
        if (!response.ok) throw new Error("读取模组清单失败，请重试");
        manifest = parseManifest(
          JSON.parse(new TextDecoder().decode(await boundedBytes(response, MAX_MANIFEST))),
        );
      }
      if (manifest.roomId !== roomId) throw new Error("模组清单不属于当前房间");
      for (const blob of [...manifest.files, manifest.resources])
        await withFileMutation(this.blob(blob.hash), () =>
          this.download(blob, manifest.version, request, signal),
        );
      const resources = JSON.parse(
        await readFile(this.blob(manifest.resources.hash), "utf8"),
      ) as SessionModuleResources;
      if (!resources.baseline?.entities) throw new Error("模组资料无效");
      signal?.throwIfAborted();
      if (response.status !== 304)
        await writeFileAtomic(pointer, JSON.stringify(manifest), { mode: 0o600 });
      return {
        ...resources,
        room: manifest.room,
        baseline: { ...resources.baseline, version: manifest.version },
      };
    });
  }
  async imageCandidate(roomId: string, source: URL) {
    try {
      const image = source.searchParams.get("image");
      const path = source.searchParams.get("path");
      if (!image || path === null || image.includes("\\") || posix.isAbsolute(image))
        return undefined;
      const pointer = join(this.directory, "rooms", `${z.string().uuid().parse(roomId)}.json`);
      const stamp = fileStamp(await lstat(pointer));
      if (this.imageIndex?.pointer !== pointer || this.imageIndex.stamp !== stamp) {
        const manifest = parseManifest(JSON.parse(await readFile(pointer, "utf8")));
        if (manifest.roomId !== roomId) throw new Error("模组清单不属于当前房间");
        this.imageIndex = {
          pointer,
          stamp,
          files: new Map(manifest.files.map((file) => [file.path, file])),
        };
      }
      const files = this.imageIndex.files;
      for (const candidate of [posix.normalize(image), posix.join(posix.dirname(path), image)]) {
        const file = files.get(candidate);
        if (file && (await this.valid(file)))
          return { hash: file.hash, file: this.blob(file.hash) };
      }
    } catch {
      /* 缓存不可用时由房主提供当前图片。 */
    }
    return undefined;
  }
}
