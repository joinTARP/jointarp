import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  resolveModuleDocuments,
  type ParsedModuleDocument,
} from "@jointarp/module/document-evaluator";
import { documentIdentity } from "@jointarp/module/document-path";
import { validateDocumentValues } from "@jointarp/module/document-type";
import { validateAnswer } from "@jointarp/module/flow";
import { stringifyDocumentContent } from "@jointarp/module/node/document-codec";
import { validateInitialGameState } from "@jointarp/module/node/game-state-validation";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { forgetRoomProjection, projectEntities } from "../game/room-state-projection";
import { assertRegularFile } from "../storage/regular-file";
import { SessionDatabase } from "../storage/session-database";
import { structuredFile } from "../storage/structured-file";
import { writeFileAtomicSync } from "../storage/write-file-atomic";
import { initializeCharacters, readCharacters } from "./character-db";
import { validateCharacterDraft } from "./character-store";
import { compileModule } from "./compile-module";
import {
  forgetFrozenModule,
  loadFrozenModule,
  refreshFrozenModule,
  setFrozenModule,
  type FrozenModule,
} from "./frozen-module";
import { readGameDocuments } from "./game-document-source";
import { forgetGameDocumentViews, readGameDocumentSnapshot } from "./game-document-views";
import { listGameFileRecords } from "./game-file-index";
import { layerPath, readOverlayDocument } from "./game-overlay";
import { readMapStateFile, reconcileMapState, writeMapStateFile } from "./map-state";
import { copyModule, directoryExists } from "./module-copy";
import { moduleSyncDirectory, moduleSyncJournal, recoverModuleSync } from "./module-sync-recovery";
import { readAdventure } from "./room-storage";
import { associateSessionDirectory } from "./session-paths";
import { readRoomState } from "./session-store";
import { withStateLock } from "./state-lock";
import { bumpFileRevisions, forgetStateVersions } from "./state-version";

const sourceSchema = z.strictObject({ path: z.string().min(1).refine(isAbsolute) });
const existsSync = (path: string) => Boolean(lstatSync(path, { throwIfNoEntry: false }));
function sourceFile(directory: string) {
  const path = join(directory, "module-source.json");
  if (existsSync(path)) assertRegularFile(path);
  return structuredFile(path, { validate: (value) => sourceSchema.parse(value), fileMode: 0o600 });
}

export async function saveModuleSource(directory: string, path: string): Promise<void> {
  await sourceFile(directory).write({ path });
}
export async function readModuleSource(root: string, roomId: string): Promise<string | null> {
  const { directory } = await readRoomState(root, roomId);
  if (!existsSync(join(directory, "module-source.json"))) return null;
  return (await sourceFile(directory).read()).path;
}
export async function bindModuleSource(
  root: string,
  roomId: string,
  path: string,
): Promise<string> {
  const { directory, state } = await readRoomState(root, roomId);
  assertActive(state.room.status);
  await loadModuleMetadata(path);
  await withStateLock(join(directory, "game"), () => saveModuleSource(directory, path));
  return path;
}
function assertActive(status: string) {
  if (status !== "active") throw new Error("请先重新开启冒险，再同步模组");
}

/** 对编译副本比较实际文件；类型、阅读页及附件均计入，目录顺序不影响结果。 */
export async function moduleFingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(prefix: string): Promise<void> {
    const entries = (await readdir(join(directory, prefix), { withFileTypes: true })).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`模组副本不允许符号链接：${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        hash.update(
          JSON.stringify([
            path,
            createHash("sha256")
              .update(await readFile(join(directory, path)))
              .digest("hex"),
          ]),
        );
      else throw new Error(`无效的模组文件：${path}`);
    }
  }
  await walk("");
  return hash.digest("hex");
}
async function prepareSource(directory: string, destination: string): Promise<void> {
  if (!existsSync(join(directory, "module-source.json"))) throw new Error("请先选择模组来源目录");
  const { path } = await sourceFile(directory).read();
  await mkdir(destination);
  await copyModule(path, destination);
  await compileModule(destination);
}

async function copyGame(source: string, target: string): Promise<void> {
  async function check(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`游戏工作区只允许普通文件和目录：${path}`);
      if (stat.isDirectory()) await check(path);
    }
  }
  await check(source);
  await copyModule(source, target, { writable: true });
}
export async function checkModuleUpdate(root: string, roomId: string) {
  const { directory } = await readRoomState(root, roomId);
  const temp = await mkdtemp(join(directory, ".module-check-"));
  try {
    const candidate = join(temp, "module");
    await prepareSource(directory, candidate);
    const candidateVersion = await moduleFingerprint(candidate);
    const currentVersion = await withStateLock(join(directory, "game"), () =>
      moduleFingerprint(join(directory, "module")),
    );
    return { changed: candidateVersion !== currentVersion, checkedAt: new Date().toISOString() };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function validateProgress(adventure: ReturnType<typeof readAdventure>, module: FrozenModule) {
  if (Boolean(adventure.launch.state) !== Boolean(module.launch))
    throw new Error("新模组的开局配置与已保存的开局状态不兼容");
  const startId = adventure.launch.state?.startId;
  if (startId && !module.launch?.gameStarts.some((start) => start.id === startId))
    throw new Error(`已选择的开局方案不存在：${startId}`);
  const progresses = Object.values(adventure.launch.players);
  for (const progress of progresses) {
    const flowIds = new Set(module.launch?.preludeFlow?.steps.map((step) => step.id));
    for (const id of new Set([...progress.prelude.path, ...Object.keys(progress.prelude.answers)]))
      if (!flowIds.has(id)) throw new Error(`已保存的序章步骤不存在：${id}`);
    for (const [id, answer] of Object.entries(progress.prelude.answers)) {
      const node = module.launch!.preludeFlow!.steps.find((step) => step.id === id)!;
      try {
        validateAnswer(node, answer, module.documents);
      } catch (error) {
        throw new Error(
          `序章回答不兼容：${id}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (
      progress.typeId &&
      !module.types.some((type) => type.id === progress.typeId && type.designation === "character")
    )
      throw new Error(`开局角色类型不存在：${progress.typeId}`);
    if (progress.draft) {
      const type = module.types.find((type) => type.id === progress.draft!.typeId);
      if (!type) throw new Error(`角色草稿类型不存在：${progress.draft.typeId}`);
      validateDocumentValues(type, {
        ...progress.draft.values,
        name: progress.draft.name,
        description: progress.draft.description,
        computed: progress.draft.computed,
      });
    }
    if (progress.workbench && progress.typeId && ["creation", "review"].includes(progress.stage)) {
      const type = module.types.find((type) => type.id === progress.typeId)!;
      // 未完成的建卡任务不能在同步时被替换，否则已保存答案无法可靠继续。
      if (!type.creationFlow) throw new Error(`已保存的建卡工作台不存在：${progress.typeId}`);
    }
  }
  for (const character of adventure.party.characters) {
    const type = module.types.find(
      (type) => type.id === character.typeId && type.designation === "character",
    );
    if (!type) throw new Error(`角色文档类型不存在：${character.typeId}`);
    if (character.sourcePath === null)
      validateDocumentValues(type, {
        ...character.draft.values,
        name: character.draft.name,
        description: character.draft.description,
        body: character.draft.body,
        computed: character.draft.computed,
      });
  }
}

async function validateCandidate(
  candidate: string,
  previous: FrozenModule,
): Promise<{
  module: FrozenModule;
  characters: ReturnType<typeof readAdventure>["party"]["characters"];
  identities: Set<string>;
}> {
  const module = await loadFrozenModule(join(candidate, "module"));
  if (!module.types.length || !module.documents.length) throw new Error("模组没有可用于游戏的文档");
  const adventure = readAdventure(candidate);
  validateProgress(adventure, module);
  // 存在建卡进度时保持工作台契约，避免把已保存任务应用到另一套规则。
  for (const progress of Object.values(adventure.launch.players))
    if (
      progress.workbench &&
      progress.typeId &&
      ["creation", "review"].includes(progress.stage) &&
      JSON.stringify(previous.types.find((type) => type.id === progress.typeId)?.creationFlow) !==
        JSON.stringify(module.types.find((type) => type.id === progress.typeId)?.creationFlow)
    )
      throw new Error(`正在建卡的工作台已改变：${progress.typeId}`);
  const db = new SessionDatabase(":memory:");
  associateSessionDirectory(db, candidate);
  setFrozenModule(db, module);
  try {
    const oldPaths = new Set(previous.documents.map((document) => document.path));
    const newPaths = new Set(module.documents.map((document) => document.path));
    const game = join(candidate, "game");
    for (const path of oldPaths)
      if (
        !newPaths.has(path) &&
        (layerPath(game, path) ||
          adventure.party.characters.some((character) => character.sourcePath === path))
      )
        throw new Error(`不能删除有本局覆盖或角色记录的文档：${path}`);
    for (const path of newPaths)
      if (!oldPaths.has(path) && layerPath(game, path))
        throw new Error(`新模组文档与本局新增文档冲突：${path}`);
    const records = listGameFileRecords(db);
    // 未注册类型不能被文件扫描静默忽略。
    async function checkGameTypes(prefix = ""): Promise<void> {
      for (const entry of await readdir(join(game, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await checkGameTypes(path);
        else if (
          /\.[^.\/]+\.(json|toml|md)$/iu.test(entry.name) &&
          !records.some((record) => record.path === path)
        )
          throw new Error(`本局文档的类型不存在：${path}`);
      }
    }
    await checkGameTypes();
    const contents = new Map(
      records.map((record) => [
        record.path,
        readOverlayDocument(
          game,
          record.path,
          module.types.find((type) => type.id === record.typeId)!,
        ),
      ]),
    );
    const items: ParsedModuleDocument[] = [...(await readGameDocuments(db, game))];
    const drafts = [
      ...adventure.party.characters.flatMap((character) =>
        character.sourcePath === null ? [{ ...character.draft, typeId: character.typeId }] : [],
      ),
      ...Object.values(adventure.launch.players).flatMap((progress) =>
        progress.draft ? [progress.draft] : [],
      ),
    ];
    for (const draft of drafts) {
      const { body, ...input } = { body: undefined as string | undefined, ...draft };
      const checked = validateCharacterDraft(db, input, false);
      const type = module.types.find((type) => type.id === checked.typeId)!;
      const path = `${type.id}/__sync_drafts/${randomUUID()}.json`;
      contents.set(
        path,
        stringifyDocumentContent(
          {
            ...checked.values,
            name: checked.name,
            description: checked.description,
            body,
            computed: checked.computed,
          },
          path,
        ),
      );
      items.push({
        identity: documentIdentity(path),
        documentType: type,
        values: checked.values,
        computed: checked.computed,
        document: {
          path,
          title: checked.name,
          description: checked.description,
          body,
          docType: type.id,
          contentType: "json",
          valid: true,
        },
      });
    }
    const documents = await resolveModuleDocuments(items, { view: "source" });
    const invalid = documents.find(
      (document) => !document.valid || Object.keys(document.fieldErrors ?? {}).length,
    );
    if (invalid)
      throw new Error(
        `模组与存档不兼容：${invalid.path}：${invalid.error ?? JSON.stringify(invalid.fieldErrors)}`,
      );
    validateInitialGameState(documents, module.types, contents);
    readCharacters(db);
    initializeCharacters(db);
    await readGameDocumentSnapshot(db, game);
    await projectEntities(db);
    return {
      module,
      characters: readAdventure(candidate).party.characters,
      identities: new Set(documents.map((document) => documentIdentity(document.path))),
    };
  } finally {
    db.close();
    forgetFrozenModule(join(candidate, "module"));
    forgetGameDocumentViews(gameDirectory(candidate));
    forgetRoomProjection(candidate);
    forgetStateVersions(candidate);
  }
}
const gameDirectory = (directory: string) => join(directory, "game");

/** 持有工作区锁完成校验和发布；宿主先将运行房间置于维护状态。 */
export async function syncModule(root: string, roomId: string) {
  const { directory } = await readRoomState(root, roomId);
  return withStateLock(gameDirectory(directory), async () => {
    await recoverModuleSync(directory);
    assertActive(readAdventure(directory).room.status);
    const transaction = moduleSyncDirectory(directory);
    if (await directoryExists(transaction)) await rm(transaction, { recursive: true });
    await mkdir(transaction);
    const candidate = join(transaction, "candidate");
    await mkdir(candidate);
    try {
      await prepareSource(directory, join(candidate, "module"));
      if (
        (await moduleFingerprint(join(candidate, "module"))) ===
        (await moduleFingerprint(join(directory, "module")))
      )
        return { changed: false };
      const previous = await loadFrozenModule(join(directory, "module"));
      await mkdir(gameDirectory(candidate));
      await copyGame(gameDirectory(directory), gameDirectory(candidate));
      writeFileSync(
        join(candidate, "adventure.json"),
        readFileSync(join(directory, "adventure.json")),
        { flag: "wx", mode: 0o600 },
      );
      const validated = await validateCandidate(candidate, previous);
      const nextMapState = reconcileMapState(
        readMapStateFile(directory),
        validated.module.maps,
        validated.identities,
      );
      const metadata = await loadModuleMetadata(join(candidate, "module"));
      // 发布阶段同步执行，房间笔记与设置的同步保存不会插入备份和提交之间。
      const adventure = readAdventure(directory);
      assertActive(adventure.room.status);
      const next = {
        ...adventure,
        room: { ...adventure.room, moduleName: metadata.name, updatedAt: new Date().toISOString() },
        party: { ...adventure.party, characters: validated.characters },
      };
      const index = join(directory, "document-references.json");
      const hadIndex = existsSync(index);
      if (hadIndex) assertRegularFile(index);
      writeFileSync(
        join(transaction, "previous-adventure.json"),
        readFileSync(join(directory, "adventure.json")),
        { flag: "wx", mode: 0o600 },
      );
      writeFileSync(
        join(transaction, "previous-map-state.json"),
        readFileSync(join(directory, "map-state.json")),
        { flag: "wx", mode: 0o600 },
      );
      if (hadIndex)
        writeFileSync(join(transaction, "previous-document-references.json"), readFileSync(index), {
          flag: "wx",
          mode: 0o600,
        });
      writeFileSync(join(candidate, "next-adventure.json"), `${JSON.stringify(next, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      writeMapStateFile(candidate, nextMapState);
      const journal = moduleSyncJournal(directory);
      writeFileAtomicSync(journal, JSON.stringify({ phase: "prepared", hadIndex }), {
        mode: 0o600,
      });
      try {
        renameSync(join(directory, "module"), join(transaction, "previous-module"));
        renameSync(join(candidate, "module"), join(directory, "module"));
        renameSync(join(candidate, "next-adventure.json"), join(directory, "adventure.json"));
        renameSync(join(candidate, "map-state.json"), join(directory, "map-state.json"));
        renameSync(join(candidate, "document-references.json"), index);
        writeFileAtomicSync(journal, JSON.stringify({ phase: "committed", hadIndex }), {
          mode: 0o600,
        });
      } catch (error) {
        await recoverModuleSync(directory);
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `模组同步发布失败，已恢复原存档：${error instanceof Error ? error.message : String(error)}`,
        });
      }
      refreshFrozenModule(directory, validated.module);
      forgetGameDocumentViews(gameDirectory(directory));
      forgetRoomProjection(directory);
      // 旧、新文档共同推进版本，保留进程内版本单调性。
      const versions = new SessionDatabase(":memory:");
      associateSessionDirectory(versions, directory);
      try {
        bumpFileRevisions(
          versions,
          [
            ...new Set(
              [...previous.documents, ...validated.module.documents].map(
                (document) => document.path,
              ),
            ),
          ].map((path) => ({ path, created: false })),
        );
      } finally {
        versions.close();
      }
      // 提交已经完成；备份清理失败时保留恢复标记，不把成功同步报告为失败。
      try {
        await recoverModuleSync(directory);
      } catch {
        /* 下次打开继续清理。 */
      }
      return { changed: true };
    } finally {
      forgetFrozenModule(join(candidate, "module"));
      forgetGameDocumentViews(gameDirectory(candidate));
      forgetRoomProjection(candidate);
      forgetStateVersions(candidate);
      // 失败恢复留下标记时保留备份，供下次打开继续恢复。
      if (!existsSync(moduleSyncJournal(directory)))
        await rm(transaction, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
