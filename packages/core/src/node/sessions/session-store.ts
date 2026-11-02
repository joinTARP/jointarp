import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { publicDocumentType } from "@jointarp/module/character";
import { launchConfigSchema, validateLaunch } from "@jointarp/module/flow";
import type { ModulePageDocument } from "@jointarp/module/module-document";
import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { validateInitialGameState } from "@jointarp/module/node/game-state-validation";
import { loadModuleDocuments } from "@jointarp/module/node/module-documents";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { loadModulePages } from "@jointarp/module/node/module-pages";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";

import type { gameDefaultsSchema } from "../../shared/game-defaults";
import type { SessionModuleResources } from "../../shared/room-state";
import type { GameRoom, GameRoomSummary, GameSession, SessionModule } from "../../shared/session";
import { projectRoomBaseline, publicLaunchConfig } from "../game/room-state-projection";
import { isInsideDirectory } from "../storage/path";
import { SessionDatabase } from "../storage/session-database";
import { beginAdventureEdit, commitAdventureEdit } from "./adventure-state";
import { initializeCharacters } from "./character-db";
import { compileModule } from "./compile-module";
import {
  forgetFrozenModule,
  frozenModule,
  loadFrozenModule,
  loadValidatedMaps,
  setFrozenModule,
} from "./frozen-module";
import { resolveGameDocumentPath } from "./game-document-path";
import { gameDocumentViews, readGameDocumentSnapshot } from "./game-state";
import { initializeLaunch } from "./launch-db";
import { copyModule, directoryExists } from "./module-copy";
import { saveModuleSource } from "./module-sync";
import { recoverModuleSync, hasModuleSyncJournal } from "./module-sync-recovery";
import { readRoomFile, readRoomFileSync, updateRoomFile } from "./room-file";
import { forgetRoomResources, retainRoomResources } from "./room-resources";
import { readRoomSettings, initializeRoomSettings } from "./room-settings";
import { initializeAdventure } from "./room-storage";
import { associateSessionDirectory, roomDirectoryForDatabase } from "./session-paths";
import { withStateLock } from "./state-lock";

export { gameDirectoryForDatabase, roomDirectoryForDatabase } from "./session-paths";

const roomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readRoomDisplaySettings(db: SessionDatabase) {
  return readRoomSettings(roomDirectoryForDatabase(db)).display;
}

export function roomDirectory(root: string, id: string): string {
  if (!roomIdPattern.test(id)) throw new Error("冒险 ID 无效");
  return join(root, id);
}
async function readRoomDirectory(root: string, id: string): Promise<string> {
  const directory = roomDirectory(await realpath(root), id);
  if (!(await directoryExists(directory, "冒险存档目录"))) throw new Error("冒险不存在");
  return directory;
}

export async function readRoomState(root: string, id: string) {
  const directory = await readRoomDirectory(root, id);
  if (hasModuleSyncJournal(directory))
    await withStateLock(join(directory, "game"), () => recoverModuleSync(directory));
  const state = await readRoomFile(directory);
  if (state.room.id !== id) throw new Error("冒险资料 ID 无效");
  return { directory, state };
}
function readRoom(db: SessionDatabase): GameRoom {
  return readRoomFileSync(roomDirectoryForDatabase(db)).room;
}
export function assertSessionActive(db: SessionDatabase): void {
  if (!isSessionActive(db)) throw new Error("这段冒险已经结束，不能继续行动");
}
export function isSessionActive(db: SessionDatabase): boolean {
  return readRoom(db).status === "active";
}
/** 打开当前版本存档；返回可写连接，调用方负责 close()。 */
export async function openSessionDatabase(root: string, id: string): Promise<SessionDatabase> {
  const { directory } = await readRoomState(root, id);
  const path = join(directory, "session.sqlite");
  // 不创建缺失存档，也不允许数据库或 SQLite 辅助文件通过链接越界。
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const stat = await lstat(path + suffix);
      if (!stat.isFile()) throw new Error("无效的存档数据库路径");
    } catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  const db = new SessionDatabase(path, { fileMustExist: true });
  try {
    associateSessionDirectory(db, directory);
    retainRoomResources(db, directory);
    await db.migrate();
    if (!(await directoryExists(join(directory, "module"), "房间模组副本目录")))
      throw new Error("冒险缺少只读模组副本");
    if (!(await directoryExists(join(directory, "game"), "游戏工作区目录")))
      throw new Error("冒险缺少 game 工作区");
    await withStateLock(join(directory, "game"), async () => {
      setFrozenModule(db, await loadFrozenModule(join(directory, "module")));
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export async function createSession(
  root: string,
  modulePath: string,
  name: string,
  defaults: z.input<typeof gameDefaultsSchema> = {},
  initialDocuments: readonly { path: string; values: Record<string, unknown> }[] = [],
): Promise<GameRoom> {
  name = name.trim();
  if (!name || name.length > 80) throw new Error("冒险名称须为 1–80 个字符");
  const id = randomUUID();
  const directory = roomDirectory(root, id);
  const staging = join(root, `.${id}.tmp`);
  const now = new Date().toISOString();
  await mkdir(staging, { recursive: true });
  try {
    const moduleCopy = join(staging, "module");
    await mkdir(moduleCopy);
    await copyModule(modulePath, moduleCopy);
    await compileModule(moduleCopy);
    const gameCopy = join(staging, "game");
    await mkdir(gameCopy);
    const metadata = await loadModuleMetadata(moduleCopy);
    const documentTypes = await loadDocumentTypes(moduleCopy);
    // 预演只改尚未发布的模组副本；初始值不受运行期 mutable 限制，随后完整校验。
    const initialized = new Set<string>();
    for (const initial of initialDocuments) {
      const path = resolveGameDocumentPath(moduleCopy, initial.path, documentTypes);
      if (!path) throw new Error(`测试文档不存在：${initial.path}`);
      if (initialized.has(path)) throw new Error(`测试文档重复：${initial.path}`);
      initialized.add(path);
      if (Object.hasOwn(initial.values, "computed")) throw new Error("测试数据不能覆盖公式配置");
      const file = join(moduleCopy, path);
      const original = JSON.parse(await readFile(file, "utf8"));
      await chmod(file, 0o600);
      await writeFile(file, JSON.stringify({ ...original, ...initial.values }));
      await chmod(file, 0o444);
    }
    const documents = await loadModuleDocuments(moduleCopy, documentTypes);
    const launch = metadata.gameStarts
      ? launchConfigSchema.parse({
          preludeFlow: metadata.preludeFlow,
          gameStarts: metadata.gameStarts,
        })
      : undefined;
    if (launch) validateLaunch(launch, documentTypes, documents);
    if (!documentTypes.length || !documents.length) throw new Error("模组没有可用于开局的文档");
    const invalid = documents.find((document) => !document.valid);
    if (invalid) throw new Error(`请先修复模组文档 ${invalid.path}：${invalid.error}`);
    const maps = await loadValidatedMaps(moduleCopy, documents);
    const room: GameRoom = {
      id,
      name,
      moduleName: metadata.name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    initializeAdventure(staging, room);
    initializeRoomSettings(staging, defaults);
    await saveModuleSource(staging, resolve(modulePath));
    const db = new SessionDatabase(join(staging, "session.sqlite"));
    try {
      await db.migrate();
      associateSessionDirectory(db, staging);
      retainRoomResources(db, staging);
      setFrozenModule(db, { types: documentTypes, documents, maps, launch });
      db.sqlite.exec("BEGIN");
      beginAdventureEdit(db);
      initializeCharacters(db);
      initializeLaunch(db, launch);
      const contents = new Map<string, string>();
      for (const document of documents)
        if (document.valid && document.contentType)
          contents.set(document.path, await readFile(join(moduleCopy, document.path), "utf8"));
      validateInitialGameState(documents, documentTypes, contents);
      commitAdventureEdit(db);
      db.sqlite.exec("COMMIT");
      await readGameDocumentSnapshot(db, gameCopy);
    } finally {
      db.close();
    }
    await rename(staging, directory);
    forgetRoomResources(staging);
    return room;
  } catch (error) {
    forgetRoomResources(staging);
    await rm(staging, { recursive: true, force: true });
    throw new Error(`创建冒险失败：${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export async function listSessions(root: string) {
  await mkdir(root, { recursive: true });
  const rooms: GameRoomSummary[] = [];
  const issues: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !roomIdPattern.test(entry.name)) continue;
    try {
      const { directory, state } = await readRoomState(root, entry.name);
      const { cover } = await sessionModule(directory, state.room);
      rooms.push(cover ? { ...state.room, cover } : state.room);
    } catch {
      // 单个存档无法读取时跳过，继续展示其他冒险并保留原文件。
      continue;
    }
  }
  return { rooms: rooms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), issues };
}

export async function loadSession(
  root: string,
  id: string,
  debugOverride?: boolean,
  includeDocuments = true,
): Promise<GameSession> {
  const directory = roomDirectory(root, id);
  const db = await openSessionDatabase(root, id);
  try {
    return await withStateLock(join(directory, "game"), () =>
      sessionView(db, directory, debugOverride, includeDocuments),
    );
  } finally {
    db.close();
  }
}

async function sessionView(
  db: SessionDatabase,
  directory: string,
  debugOverride?: boolean,
  includeDocuments = true,
): Promise<GameSession> {
  const types = frozenModule(db).types;
  const debug = debugOverride ?? readRoomDisplaySettings(db).showAllDocuments;
  const room = readRoom(db);
  return {
    room,
    documentTypes: debug
      ? types.map((type) => ({ ...type, layout: undefined }))
      : types.map(publicDocumentType),
    documents: includeDocuments ? await gameDocumentViews(db, join(directory, "game"), debug) : [],
    module: await sessionModule(directory, room),
    pages: await sessionPages(directory),
  };
}

/** 从房间冻结的模组副本读取玩家阅读页。读不到时不阻断进房。 */
async function sessionPages(directory: string): Promise<ModulePageDocument[]> {
  try {
    const metadata = await loadModuleMetadata(join(directory, "module"));
    return await loadModulePages(join(directory, "module"), metadata.pages ?? []);
  } catch {
    return [];
  }
}

/** 从房间里冻结的模组副本取出封面和简介，供开场画面使用。 */
async function sessionModule(directory: string, room: GameRoom): Promise<SessionModule> {
  const moduleDirectory = join(directory, "module");
  let metadata;
  try {
    if (!(await directoryExists(moduleDirectory, "房间模组副本目录")))
      return { name: room.moduleName };
    metadata = await loadModuleMetadata(moduleDirectory);
  } catch {
    return { name: room.moduleName };
  }
  const brief: SessionModule = { name: metadata.name };
  if (metadata.description) brief.description = metadata.description;
  if (metadata.system) brief.system = metadata.system;
  if (metadata.author) brief.author = metadata.author;
  if (metadata.version) brief.version = metadata.version;
  if (metadata.tags?.length) brief.tags = metadata.tags;
  if (metadata.host?.name) brief.hostName = metadata.host.name;
  if (metadata.host?.avatar) brief.hostAvatar = metadata.host.avatar;
  if (metadata.cover) brief.cover = metadata.cover;
  return brief;
}

/** 结束或重新开启冒险。结束只归档存档，不删除任何内容。 */
export async function setSessionStatus(
  root: string,
  id: string,
  status: GameRoom["status"],
): Promise<GameRoom> {
  const { directory } = await readRoomState(root, id);
  return updateRoomFile(directory, (state) => {
    const current = state.room;
    if (current.status === status) return state;
    const now = new Date().toISOString();
    const next: GameRoom = {
      ...current,
      status,
      updatedAt: now,
      ...(status === "ended" ? { endedAt: now } : { endedAt: undefined }),
    };
    return { ...state, room: next };
  }).room;
}

/** 永久删除一份冒险存档。调用方必须先释放该冒险的数据库连接。 */
export async function deleteSession(root: string, id: string): Promise<void> {
  const canonicalRoot = await realpath(root);
  const directory = roomDirectory(canonicalRoot, id);
  if (!(await directoryExists(directory, "冒险存档目录"))) throw new Error("冒险不存在");
  const canonicalDirectory = await realpath(directory);
  if (!isInsideDirectory(canonicalRoot, canonicalDirectory)) throw new Error("无效的冒险存档路径");
  await withStateLock(join(canonicalDirectory, "game"), () =>
    rm(canonicalDirectory, { recursive: true }),
  );
  forgetRoomResources(canonicalDirectory);
}

/** 读取当前玩家在单个冒险中的纯文本笔记。 */
export async function loadRoomNotes(root: string, id: string, playerId: string): Promise<string> {
  const { state } = await readRoomState(root, id);
  return state.notes[playerId] ?? "";
}

/** 只覆盖当前玩家的笔记，保留房间里其他玩家的内容。 */
export async function saveRoomNotes(
  root: string,
  id: string,
  playerId: string,
  content: string,
): Promise<void> {
  const { directory } = await readRoomState(root, id);
  updateRoomFile(directory, (state) => ({
    ...state,
    notes: { ...state.notes, [playerId]: content },
  }));
}

/** 读取房间的完整冻结模组资源；宿主负责授权，不能作为玩家公共接口直接公开。 */
export async function loadSessionModuleResources(
  root: string,
  roomId: string,
): Promise<SessionModuleResources> {
  try {
    const directory = await readRoomDirectory(root, roomId);
    return await withStateLock(join(directory, "game"), async () => {
      // 资源和基线在同一工作区锁内读取，避免同步时混用两份模组。
      forgetFrozenModule(join(directory, "module"));
      const db = await openSessionDatabase(root, roomId);
      try {
        const session = await sessionView(db, directory, false, false);
        const launch = frozenModule(db).launch;
        const launchConfig = launch ? publicLaunchConfig(launch) : undefined;
        return {
          ...session,
          documentTypes: frozenModule(db).types,
          launchConfig,
          baseline: await projectRoomBaseline(db),
        };
      } finally {
        db.close();
      }
    });
  } catch (cause) {
    throw new ORPCError("NOT_FOUND", {
      message: `冻结模组不可用：${cause instanceof Error ? cause.message : String(cause)}。请恢复 session/module 后重试`,
      cause,
    });
  }
}
