import { randomInt } from "node:crypto";

import {
  publicDocumentType,
  publicValues,
  type Character,
  type CharacterDraft,
} from "@jointarp/module/character";
import { evaluateCreation, newCreationProgress } from "@jointarp/module/creation-workbench";
import { documentFormat, sameDocumentIdentity } from "@jointarp/module/document-path";
import { advanceFlow, backFlow, currentNode, finishIntroductionRun } from "@jointarp/module/flow";
import type { ModuleDocument } from "@jointarp/module/module-document";

import { messageSchema } from "../../shared/game";
import { launchActionSchema, type LaunchAction, type LaunchState } from "../../shared/launch";
import { createIdentityId } from "../identity";
import type { SessionDatabase } from "../storage/session-database";
import {
  beginAdventureEdit,
  commitAdventureEdit,
  discardAdventureEdit,
  readAdventureState,
  updateAdventureState,
  markStateChanged,
} from "./adventure-state";
import { readCharacters, storedTypes } from "./character-db";
import { characterAvailable, claimCharacter } from "./character-ownership";
import {
  characterSnapshot,
  characterViews,
  validateCharacterDraft,
  withCharacters,
} from "./character-store";
import { hasAvailableCompanion } from "./companion-selection";
import { frozenModule } from "./frozen-module";
import { publicGameDocuments } from "./game-state";
import {
  readLaunchConfig,
  readLaunchProgress,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "./launch-db";
import { allLaunchProgress } from "./launch-db";
import { seatPartyAtStart } from "./map-commands";
import { assertSessionActive } from "./session-store";

function canSelectCharacter(
  db: SessionDatabase,
  playerId: string,
  c: Character,
  start: ReturnType<typeof launchStart> | undefined,
) {
  return (
    !c.playerId &&
    !c.retired &&
    characterAvailable(db, c, playerId) &&
    start?.characterTypeIds.includes(c.typeId) &&
    start.playablePaths.some((path) =>
      c.sourcePath ? sameDocumentIdentity(path, c.sourcePath) : false,
    )
  );
}

export function launchDocuments(db: SessionDatabase): ModuleDocument[] {
  const types = storedTypes(db);
  const characterTypes = new Set(
    types.filter((type) => type.designation === "character").map((type) => type.id),
  );
  return [
    ...frozenModule(db).documents.filter((document) => !characterTypes.has(document.docType ?? "")),
    ...readCharacters(db).map((c) => ({
      path: c.sourcePath ?? `${c.typeId}/${c.id}.json`,
      title: c.name,
      body: c.body,
      docType: c.typeId,
      valid: true,
      contentType: c.sourcePath ? documentFormat(c.sourcePath) : "json",
    })),
  ];
}
export function launchStart(db: SessionDatabase) {
  const start = readLaunchConfig(db)?.gameStarts.find((s) => s.id === readLaunchRoom(db).startId);
  if (!start) throw new Error("请先选择开局方案");
  return start;
}
function creationContext(db: SessionDatabase, playerId: string, typeId: string) {
  const p = readLaunchProgress(db, playerId),
    start = launchStart(db);
  if (
    p.confirmed ||
    !["creation", "review"].includes(p.stage) ||
    p.typeId !== typeId ||
    !start.allowCreate ||
    !start.characterTypeIds.includes(typeId)
  )
    throw new Error("当前流程不允许创建此角色");
  const type = storedTypes(db).find((t) => t.id === typeId)!;
  if (!type.creationFlow) throw new Error("此角色类型没有建卡工作台");
  const view = evaluateCreation(
    type.creationFlow.workbench,
    p.workbench ?? newCreationProgress(),
    launchDocuments(db),
    type,
  );
  if (view.missing.length) throw new Error(`请完成：${view.missing.join("、")}`);
  return { progress: p, type, start };
}
function mergeLaunchDraft(db: SessionDatabase, playerId: string, typeId: string) {
  const { type, progress } = creationContext(db, playerId, typeId);
  return validateCharacterDraft(
    db,
    evaluateCreation(type.creationFlow!.workbench, progress.workbench!, launchDocuments(db), type)
      .draft,
    false,
  );
}
export async function launchState(
  root: string,
  roomId: string,
  playerId: string,
  options: { raw?: boolean } = {},
): Promise<LaunchState | null> {
  return withCharacters(root, roomId, async (db) => {
    const config = readLaunchConfig(db);
    if (!config) return null;
    const room = readLaunchRoom(db),
      types = storedTypes(db);
    const start = config.gameStarts.find((s) => s.id === room.startId);
    const progress = readLaunchProgress(db, playerId);
    const workbenchConfig = types.find((t) => t.id === progress.typeId)?.creationFlow?.workbench;
    const workbench = workbenchConfig
      ? evaluateCreation(
          workbenchConfig,
          progress.workbench ?? newCreationProgress(),
          launchDocuments(db),
          types.find((type) => type.id === progress.typeId)!,
        )
      : undefined;
    let previewDraft = progress.stage === "review" ? progress.draft : undefined;
    if (!previewDraft && workbench && !workbench.missing.length) {
      try {
        previewDraft = validateCharacterDraft(db, workbench.draft, false);
      } catch {
        // 尚未形成合法角色时继续填写；确认操作会返回完整校验错误。
      }
    }
    const { characters: views, documents } = await characterSnapshot(
      db,
      previewDraft
        ? { ...previewDraft, id: "draft", playerId: null, sourcePath: null, version: 1 }
        : undefined,
      options,
    );
    const draftView = views.find((c) => c.id === "draft");
    const characters = views
      .filter(
        (c) =>
          c.id !== "draft" &&
          documents.find((document) => document.path === c.sourcePath)?.visible !== false &&
          (c.playerId === playerId || canSelectCharacter(db, playerId, c, start)),
      )
      .map((c) => ({
        ...c,
        values: publicValues(types.find((t) => t.id === c.typeId)!.fields, c.values),
      }));
    const references = [...(await publicGameDocuments(db, documents))];
    if (workbench) {
      // 执行使用完整资料，选项预览使用同一份公开快照，确保预览遵守内置展示字段的计算与可见性规则。
      for (const item of workbench.items) {
        if (item.kind !== "reference") continue;
        item.options = item.options.flatMap((option) => {
          const document = references.find((reference) =>
            sameDocumentIdentity(reference.path, option.value),
          );
          if (document?.visible === false) return [];
          return [
            {
              value: option.value,
              label: document?.title ?? "资料暂不可用",
              body: document?.body,
            },
          ];
        });
      }
    }
    const message = room.openingMessageId
      ? db.get(
          db.query
            .selectFrom("chat_messages")
            .select("data")
            .where("id", "=", room.openingMessageId),
        )
      : undefined;
    return {
      workbench,
      openingMessage: message ? messageSchema.parse(JSON.parse(String(message.data))) : undefined,
      draftView: draftView
        ? {
            ...draftView,
            values: publicValues(
              types.find((t) => t.id === draftView.typeId)!.fields,
              draftView.values,
            ),
          }
        : undefined,
      config,
      room,
      progress,
      creationTypeIds: types
        .filter((type) => type.designation === "character" && type.creationFlow)
        .map((type) => type.id),
      types: types.map(publicDocumentType),
      characters,
      references,
    };
  });
}
export async function advanceLaunch(root: string, input: LaunchAction, playerId: string) {
  const a = launchActionSchema.parse(input);
  await withCharacters(root, a.roomId, async (db) => {
    assertSessionActive(db);
    const config = readLaunchConfig(db);
    if (!config) throw new Error("此冒险没有开局配置");
    const p = readLaunchProgress(db, playerId),
      room = readLaunchRoom(db);
    if (a.action === "workbench" && a.requestId && p.workbench?.requests.includes(a.requestId))
      return;
    if (p.confirmed && a.action === "confirm") return;
    if (
      a.action === "beginAdventure" &&
      p.confirmed &&
      room.companionSetup?.playerId === playerId &&
      room.companionSetup.stage === "complete"
    )
      return;
    if (p.revision !== a.revision || room.revision !== a.roomRevision)
      throw new Error("开局进度已变化，请刷新后重试");
    const companionAction = a.action === "chooseCompanions" || a.action === "beginAdventure";
    if (p.confirmed && !companionAction) {
      throw new Error("角色已确认");
    }
    const start = config.gameStarts.find((s) => s.id === room.startId);
    const type = storedTypes(db).find((t) => t.id === p.typeId);
    const flow = p.stage === "prelude" ? config.preludeFlow : undefined;
    const run = p.prelude;
    const node = flow && currentNode(flow, run);
    let checked: CharacterDraft | undefined;
    if (companionAction) {
      const setup = room.companionSetup;
      if (
        !p.confirmed ||
        !setup ||
        setup.playerId !== playerId ||
        setup.stage === "complete" ||
        room.opening !== "pending" ||
        room.openingMessageId
      )
        throw new Error("当前不能选择开局队友");
      if (a.action === "chooseCompanions" && setup.stage !== "prompt")
        throw new Error("已进入队友选择");
      if (
        a.action === "beginAdventure" &&
        readAdventureState(db).party.companions.some((seat) => seat.status === "reserved")
      )
        throw new Error("请先完成或取消待入队的角色");
      setup.stage = a.action === "chooseCompanions" ? "select" : "complete";
      room.revision++;
    } else if (a.action === "workbench") {
      if (
        !type?.creationFlow?.workbench ||
        !["creation", "review"].includes(p.stage) ||
        !a.operation ||
        !a.requestId
      )
        throw new Error("当前流程不支持此建卡操作");
      const config = type.creationFlow.workbench;
      const w = (p.workbench ??= newCreationProgress());
      const documents = launchDocuments(db);
      let view = evaluateCreation(config, w, documents, type);
      for (const [key, value] of Object.entries(a.answers ?? {})) {
        const item = view.items.find(
          (i) =>
            i.key === key &&
            i.stage === w.stage &&
            ["input", "choice", "reference", "purchase"].includes(i.kind),
        );
        if (
          !item ||
          (!["input", "purchase"].includes(item.kind) &&
            !item.options.some((o) => o.value === value))
        )
          throw new Error("建卡选择无效");
        w.answers[key] = value;
      }
      if (
        w.stage > 0 &&
        a.operation !== "navigate" &&
        view.stages.slice(0, w.stage).some((s) => !s.complete)
      )
        throw new Error("请先完成前面的阶段");
      if (a.operation === "swap") w.swap = a.swap ?? undefined;
      if (a.operation === "randomReference") {
        const item = view.items.find((i) => i.stage === w.stage && i.kind === "reference");
        if (!item?.options.length) throw new Error("没有可随机选择的文档");
        w.answers[item.key] = item.options[randomInt(item.options.length)].value;
      }
      view = evaluateCreation(
        config,
        w,
        documents,
        type,
        a.operation === "generate"
          ? { stage: w.stage, random: (sides) => randomInt(1, sides + 1) }
          : undefined,
      );
      if (a.operation === "navigate") {
        const next = a.stageIndex ?? w.stage;
        if (
          next >= config.stages.length ||
          next > w.visited + 1 ||
          (next > w.stage && view.stages.slice(0, next).some((s) => !s.complete))
        )
          throw new Error("请先完成前面的阶段");
        w.stage = next;
        w.visited = Math.max(w.visited, next);
        p.stage = "creation";
      }
      p.draft = view.draft;
      if (a.operation === "review") {
        if (view.missing.length) throw new Error(`请完成：${view.missing.join("、")}`);
        p.draft = validateCharacterDraft(db, view.draft, false);
        p.stage = "review";
      }
      w.requests.push(a.requestId);
    } else if (a.action === "start") {
      if (p.stage !== "start" || room.locked) throw new Error("开局方案已锁定或当前步骤不可切换");
      if (!config.gameStarts.some((s) => s.id === a.startId)) throw new Error("请选择有效开局方案");
      room.startId = a.startId;
      room.revision++;
      p.stage = "character";
      delete p.workbench;
      delete p.draft;
      delete p.typeId;
      delete p.characterId;
    } else if (a.action === "select" || a.action === "create") {
      if ((p.stage !== "character" && !(p.stage === "review" && !p.typeId)) || !start)
        throw new Error("请先完成序章并选择开局方案");
      delete p.draft;
      delete p.characterId;
      delete p.typeId;
      delete p.workbench;
      if (a.action === "select") {
        const c = readCharacters(db).find(
          (c) => c.id === a.characterId && canSelectCharacter(db, playerId, c, start),
        );
        if (!c) throw new Error("此角色不可选");
        p.characterId = c.id;
        p.stage = "review";
      } else {
        if (
          !start.allowCreate ||
          !start.characterTypeIds.includes(a.typeId ?? "") ||
          !storedTypes(db).some((candidate) => candidate.id === a.typeId && candidate.creationFlow)
        )
          throw new Error("不能创建此类型角色");
        p.typeId = a.typeId;
        p.stage = "creation";
      }
    } else if (a.action === "next") {
      if (!flow || !node) throw new Error("当前步骤不能继续");
      const documents = launchDocuments(db);
      const next =
        p.stage === "prelude" && node.type === "introduction"
          ? finishIntroductionRun(flow, run, documents)
          : advanceFlow(flow, run, a.answer ?? run.answers[node.id], documents);
      p.prelude = next;
      if (next.done) p.stage = room.locked ? "character" : "start";
    } else if (a.action === "back") {
      if (p.stage === "opening") throw new Error("开場已开始");
      if (p.stage === "review") {
        p.stage = p.typeId ? "creation" : "character";
        if (!p.typeId) delete p.characterId;
      } else if (p.stage === "creation") {
        p.stage = "character";
        delete p.draft;
        delete p.workbench;
      } else if (p.stage === "character") {
        if (room.locked) throw new Error("开局方案已锁定");
        p.stage = "start";
      } else if (p.stage === "start" && config.preludeFlow?.steps.length) {
        p.stage = "prelude";
        p.prelude = backFlow(p.prelude);
      } else if (p.stage === "prelude") p.prelude = backFlow(p.prelude);
    } else if (a.action === "confirm") {
      if (p.stage !== "review") throw new Error("请先检查角色");
      if (p.typeId) {
        const draft = p.draft;
        if (!draft || draft.typeId !== p.typeId) throw new Error("请填写角色资料");
        checked = mergeLaunchDraft(db, playerId, p.typeId);
        await characterViews(db, {
          ...checked,
          id: "draft",
          playerId: null,
          sourcePath: null,
          version: 1,
        });
        p.draft = checked;
      } else if (
        !readCharacters(db).some(
          (c) => c.id === p.characterId && canSelectCharacter(db, playerId, c, start),
        )
      )
        throw new Error("角色已被选择，请返回重选");
      p.stage = "opening";
    }
    db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      beginAdventureEdit(db);
      const previous = readLaunchProgress(db, playerId);
      if (previous.revision !== a.revision || readLaunchRoom(db).revision !== a.roomRevision)
        throw new Error("流程已变化，请刷新重试");
      if (
        a.action === "select" &&
        !readCharacters(db).some(
          (c) => c.id === p.characterId && canSelectCharacter(db, playerId, c, start),
        )
      )
        throw new Error("角色已被占用，请选择其他角色");
      if (a.action === "start") {
        // 房间级选择改变时使其他尚未确认玩家的建卡草稿失效。
        for (const [otherId, other] of allLaunchProgress(db).filter(([id]) => id !== playerId)) {
          other.revision++;
          delete other.draft;
          delete other.typeId;
          delete other.characterId;
          delete other.workbench;
          if (other.stage !== "prelude") other.stage = "character";
          saveLaunchProgress(db, otherId, other);
        }
      }
      if (a.action === "confirm") {
        const characterId = checked
          ? createIdentityId(readCharacters(db).map((character) => character.id))
          : p.characterId!;
        if (readCharacters(db).some((c) => c.playerId === playerId))
          throw new Error("每个玩家只能拥有一个角色");
        if (checked)
          updateAdventureState(db, (selection) => {
            selection.party.characters.push({
              id: characterId,
              typeId: checked.typeId,
              playerId,
              sourcePath: null,
              draft: {
                name: checked.name,
                description: checked.description,
                values: checked.values,
                ...(checked.computed ? { computed: checked.computed } : {}),
              },
              retired: false,
            });
          });
        else claimCharacter(db, p.characterId!, playerId);
        // 身份绑定也会改变公开状态投影，使用相同版本通知客户端。
        markStateChanged(db);
        p.confirmed = true;
        p.characterId = characterId;
        delete p.draft;
        room.locked = true;
        if (!room.characterId && room.opening === "pending" && !room.openingMessageId)
          room.companionSetup = {
            playerId,
            stage: hasAvailableCompanion(db) ? "prompt" : "complete",
          };
        room.characterId ??= characterId;
        room.revision++;
        for (const [otherId, other] of allLaunchProgress(db).filter(([id]) => id !== playerId)) {
          if (other.stage === "start") {
            other.stage = "character";
            other.revision++;
            saveLaunchProgress(db, otherId, other);
          }
        }
      }
      p.revision++;
      saveLaunchProgress(db, playerId, p);
      saveLaunchRoom(db, room);
      if (previous.characterId !== p.characterId || a.action === "start" || companionAction)
        markStateChanged(db);
      db.sqlite.exec("COMMIT");
      commitAdventureEdit(db);
    } catch (error) {
      discardAdventureEdit(db);
      if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
      throw error;
    }
    if (a.action === "confirm") await seatPartyAtStart(db);
  });
  return launchState(root, a.roomId, playerId);
}
