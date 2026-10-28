import { documentIdentity } from "@jointarp/module/document-path";

import { chatText, publicAssistantText, visibleAgentMessages } from "../../shared/agent-message";
import { companionSchema, type Companion } from "../../shared/companion";
import { messageSchema } from "../../shared/game";
import type { Player } from "../../shared/game";
import { HOST_MENTION_ID, type Mention, type MentionTarget } from "../../shared/mentions";
import { parseNarrative } from "../../shared/narrative";
import { readAdventureState } from "../sessions/adventure-state";
import { readCharacters } from "../sessions/character-db";
import { isPlayableCharacter, selectionOwner } from "../sessions/character-ownership";
import { moduleCompanionPrompt } from "../sessions/companion-selection";
import { readGameDocumentView, materializeCharacter } from "../sessions/game-state";
import { gameDirectoryForDatabase } from "../sessions/session-store";
import { chatField, type SessionDatabase } from "../storage/session-database";

export { moduleCompanionPrompt } from "../sessions/companion-selection";

export function readCompanions(db: SessionDatabase): Companion[] {
  const party = readAdventureState(db).party;
  const seats = party.companions.filter((seat) => seat.status === "active");
  if (!seats.length) return [];
  const characters = readCharacters(db);
  return seats.map((seat) => {
    const character = characters.find((item) => item.id === seat.characterId);
    const relay = party.members.some((member) => member.id === seat.id && member.relay);
    const personality =
      character &&
      (moduleCompanionPrompt(db, character) ??
        (relay
          ? `你正在临时接力扮演玩家角色「${character.name}」。依据角色资料和此前公开交流延续其性格、目标与行动；不替离线玩家作出不可逆的重大决定。\n${character.description ?? ""}\n${character.body ?? ""}`
          : undefined));
    if (!personality) throw new Error("队友角色缺少模组预设提示词");
    return companionSchema.parse({
      id: seat.id,
      characterId: seat.characterId,
      joinedSequence: seat.joinedSequence,
      personality,
      initiative: seat.initiative,
      documentAccess: seat.documentAccess,
      model: seat.model ?? undefined,
      voice: seat.voice ?? undefined,
    });
  });
}

export async function companionCharacters(db: SessionDatabase, requestedIds?: readonly string[]) {
  const root = gameDirectoryForDatabase(db);
  const characters = readCharacters(db).filter(
    (character) => !character.retired && (!requestedIds || requestedIds.includes(character.id)),
  );
  for (const character of characters)
    if (!character.sourcePath) await materializeCharacter(db, root, character);
  const current = new Map(readCharacters(db).map((character) => [character.id, character]));
  const views = await Promise.all(
    characters.map(async (selected) => {
      const character = current.get(selected.id)!;
      const document = character.sourcePath
        ? await readGameDocumentView(db, root, character.sourcePath)
        : undefined;
      if (!document?.valid) return undefined;
      return {
        id: character.id,
        controllerId: character.playerId,
        reservedBy: selectionOwner(db, character.id),
        playable: isPlayableCharacter(db, character),
        aiConfigured:
          Boolean(moduleCompanionPrompt(db, character)) ||
          readAdventureState(db).party.members.some(
            (member) => member.id === character.playerId && member.relay,
          ),
        name: document.title,
        description: document.description ?? "",
        body: document.body ?? "",
        image: document.image,
        avatar: document.avatar,
        values: document.values ?? {},
      };
    }),
  );
  return views.filter((view) => view !== undefined);
}

/** 公开身份唯一来源；不读取未受玩家控制的角色卡或幕后人物目录。 */
export async function publicMentionTargets(
  db: SessionDatabase,
  online: readonly Player[] = [],
): Promise<MentionTarget[]> {
  const players = new Map<string, Player>();
  const ready = db.sqlite
    .prepare(
      "SELECT data FROM chat_messages WHERE json_extract(data,'$.card.type')='ready' ORDER BY sequence DESC LIMIT 1",
    )
    .get() as { data: string } | undefined;
  if (ready) {
    const card = messageSchema.parse(JSON.parse(ready.data));
    if (card.kind === "card" && card.card.type === "ready")
      for (const player of card.card.players) players.set(player.id, player);
  }
  const rows = db.sqlite
    .prepare(
      "SELECT data FROM chat_messages WHERE sequence IN (SELECT max(sequence) FROM chat_messages WHERE json_extract(data,'$.kind')='player' GROUP BY json_extract(data,'$.senderId'))",
    )
    .all() as { data: string }[];
  for (const row of rows) {
    const message = messageSchema.parse(JSON.parse(row.data));
    players.set(message.senderId, { id: message.senderId, nickname: message.nickname });
  }
  for (const member of readAdventureState(db).party.members) players.set(member.id, member);
  for (const player of online) players.set(player.id, player);
  const companions = readCompanions(db);
  const companionIds = new Set(companions.map((companion) => companion.id));
  const owned = readCharacters(db).filter((character) => character.playerId && !character.retired);
  const views = await companionCharacters(
    db,
    owned.map((character) => character.id),
  );
  for (const character of owned)
    if (!companionIds.has(character.playerId!) && !players.has(character.playerId!))
      players.set(character.playerId!, { id: character.playerId!, nickname: "玩家" });
  const targets = [
    ...[...players.values()].filter((player) => !companionIds.has(player.id)),
    ...companions.map((companion) => ({
      id: companion.id,
      nickname: views.find((view) => view.id === companion.characterId)?.name ?? "AI 队友",
    })),
  ].flatMap((player): MentionTarget[] => {
    const companion = companions.find((item) => item.id === player.id);
    const character = views.find((view) => view.controllerId === player.id);
    if (companion && (!character || !character.aiConfigured)) return [];
    const name = character?.name;
    return [
      {
        id: player.id,
        kind: companion ? "companion" : "player",
        nickname: player.nickname,
        characterId: character?.id,
        characterName: name,
        label:
          name && name !== player.nickname
            ? `${name}（${player.nickname}）`
            : (name ?? player.nickname),
        path: owned.find((item) => item.id === character?.id)?.sourcePath ?? undefined,
        image: character?.image,
        avatar: character?.avatar,
      },
    ];
  });
  return [{ id: HOST_MENTION_ID, kind: "host", nickname: "主持人", label: "主持人" }, ...targets];
}

/** 仅向队友提供玩家投影，不传入主持状态、文件目录或原始角色值。 */
export async function companionContext(
  db: SessionDatabase,
  companion: Companion,
  interaction?: {
    targets: readonly MentionTarget[];
    trigger?: {
      id: string;
      authorId: string;
      authorKind?: "host" | "player" | "companion";
      text: string;
      mentions: Mention[];
    };
  },
) {
  const character = (await companionCharacters(db, [companion.characterId])).find(
    (item) => item.id === companion.characterId,
  );
  if (!character || !character.aiConfigured || character.controllerId !== companion.id)
    throw new Error("队友角色已不可用");
  const targets = interaction?.targets ?? (await publicMentionTargets(db));
  // 头像与卡片路径仅供界面定位；文件名可能透露角色未公开身份，不能注入模型。
  const participants = targets.map(
    ({ path: _path, image: _image, avatar: _avatar, ...identity }) => identity,
  );
  const byId = new Map(participants.map((target) => [target.id, target]));
  const pendingRow = db.get(
    db.query
      .selectFrom("chat_messages")
      .select("data")
      .where(chatField("senderId"), "=", companion.id)
      .where(chatField<number>("pendingAgent"), "=", 1)
      .orderBy("sequence", "desc")
      .limit(1),
  );
  const pendingMessage = pendingRow
    ? messageSchema.parse(JSON.parse(String(pendingRow.data)))
    : undefined;
  const byPath = new Map(
    readCharacters(db).flatMap((actor) =>
      actor.sourcePath && actor.playerId
        ? [[documentIdentity(actor.sourcePath), byId.get(actor.playerId)] as const]
        : [],
    ),
  );
  const events = db
    .all(
      db.query
        .selectFrom("chat_messages")
        .select("data")
        .where("sequence", ">", companion.joinedSequence)
        .orderBy("sequence", "desc")
        .limit(80),
    )
    .reverse()
    .map((row) => messageSchema.parse(JSON.parse(String(row.data))))
    .filter(
      (message) =>
        message.status === "complete" &&
        (message.kind !== "assistant" || !message.internal) &&
        message.kind !== "card",
    )
    .map((message) => ({
      id: message.id,
      speaker: message.nickname,
      author:
        message.kind === "player" || (message.kind === "assistant" && message.companionId)
          ? byId.get(message.senderId)
          : message.kind === "scripted" && message.speakerPath
            ? (byPath.get(documentIdentity(message.speakerPath)) ?? {
                kind: "npc",
                name: message.nickname,
              })
            : { kind: "host" },
      text: chatText(message),
      mentions: message.mentions ?? [],
      chatOnly:
        message.kind === "player" || message.kind === "assistant" ? message.chatOnly : undefined,
      pendingAgent: Boolean(message.pendingAgent),
      publicNpcs:
        message.kind === "assistant" && !message.companionId
          ? visibleAgentMessages(message).flatMap((item) =>
              parseNarrative(publicAssistantText(item)).flatMap((part) =>
                part.kind === "npc" ? [{ kind: "npc", name: part.name, text: part.text }] : [],
              ),
            )
          : [],
    }));
  return JSON.stringify({
    character: {
      id: character.id,
      playerId: companion.id,
      name: character.name,
    },
    participants,
    pendingAction: pendingMessage
      ? { id: pendingMessage.id, text: chatText(pendingMessage) }
      : undefined,
    trigger: interaction?.trigger,
    identityGuidance:
      "participants 中 kind=host 是主持人，kind=player 是真人玩家，kind=companion 是独立 AI 玩家；characterId/characterName 是其控制角色。点名在正文写 [@名称](#mention/身份id)，使用 participants 中的 id；普通 @名字、代码或引用中的链接不建立点名。点名主持用于场外聊天，不提交角色行动。NPC 由主持扮演；不要凭名字猜控制身份。",
    knowledgeGuidance:
      "events 是玩家共同可见的公开交流。角色的位置、参与情况和已知信息依据模组资料及主持已裁定的事实判断，不从固定场景结构推断。可以像同桌玩家一样跨场景接话、讨论和声明意图，但玩家读到的其他场景描述不自动成为角色亲历或已获知的信息。角色的行动受实际位置、已知信息和主持裁定约束，不因接话自动移动或远程介入。",
    events,
  });
}
