import { join } from "node:path";

import { characterDraftSchema } from "@jointarp/module/character";
import { z } from "zod";

import { companionModelSchema } from "../../shared/companion";
import { companionInitiativeSchema } from "../../shared/companion-initiative";
import { contextSubscriptionListSchema } from "../../shared/context-subscriptions";
import { launchProgressSchema, launchRoomSchema } from "../../shared/launch";
import { gameRoomSchema, type GameRoom } from "../../shared/session";
import { ttsVoiceOverrideSchema } from "../../shared/voice";
import { assertRegularFile } from "../storage/regular-file";
import { structuredFile } from "../storage/structured-file";

const idSchema = z.string().min(1);
const characterIdentitySchema = z.strictObject({
  id: idSchema,
  typeId: idSchema,
  playerId: idSchema.nullable(),
  retired: z.boolean(),
});
/** 文档角色只保存索引；新建角色在落为游戏文档前保留待发布内容。 */
const storedCharacterSchema = z.union([
  characterIdentitySchema.extend({ sourcePath: z.string().min(1) }),
  characterIdentitySchema.extend({
    sourcePath: z.null(),
    draft: characterDraftSchema.omit({ typeId: true }).extend({ body: z.string().optional() }),
  }),
]);
export type StoredCharacter = z.infer<typeof storedCharacterSchema>;

/** 队友的身份、状态和专属设置共同保存；提示词仍从冻结模组读取。 */
const companionSeatSchema = z.discriminatedUnion("status", [
  z.strictObject({ id: idSchema, status: z.literal("empty") }),
  z.strictObject({ id: idSchema, status: z.literal("reserved"), characterId: idSchema }),
  z.strictObject({
    id: idSchema,
    status: z.literal("active"),
    characterId: idSchema,
    joinedSequence: z.number().int().nonnegative(),
    model: companionModelSchema.nullable().default(null),
    initiative: companionInitiativeSchema.strict().prefault({}),
    documentAccess: z.boolean().default(false),
    voice: ttsVoiceOverrideSchema.nullable().default(null),
    defaultVoice: ttsVoiceOverrideSchema.nullable().default(null),
  }),
]);
export type CompanionSeat = z.infer<typeof companionSeatSchema>;

export const roomMemberSchema = z.object({
  id: idSchema,
  nickname: z.string(),
  relay: z.boolean().default(false),
});

const adventureSchema = z.strictObject({
  contextSubscriptions: z.record(idSchema, contextSubscriptionListSchema).default({}),
  room: gameRoomSchema,
  notes: z.record(idSchema, z.string()),
  launch: z.strictObject({
    state: launchRoomSchema.nullable(),
    players: z.record(idSchema, launchProgressSchema),
  }),
  party: z.strictObject({
    members: z.array(roomMemberSchema).default([]),
    characters: z.array(storedCharacterSchema),
    companions: z.array(companionSeatSchema),
  }),
});
export type StoredAdventure = z.infer<typeof adventureSchema>;

function adventureFile(directory: string) {
  return structuredFile(join(directory, "adventure.json"), {
    validate: (value) => adventureSchema.parse(value),
    fileMode: 0o600,
  });
}

/** 仅在尚未发布的冒险 staging 目录初始化。 */
export function initializeAdventure(directory: string, room: GameRoom): void {
  adventureFile(directory).writeSync({
    contextSubscriptions: {},
    room,
    notes: {},
    launch: { state: null, players: {} },
    party: { members: [], characters: [], companions: [] },
  });
}

export function readAdventure(directory: string): StoredAdventure {
  assertRegularFile(join(directory, "adventure.json"));
  return adventureFile(directory).readSync();
}

/** 同步读改写和原子替换，提交时保留其他分组的最新内容。 */
export function updateAdventure(
  directory: string,
  change: (current: StoredAdventure) => StoredAdventure,
): StoredAdventure {
  assertRegularFile(join(directory, "adventure.json"));
  const file = adventureFile(directory);
  const current = file.readSync();
  const before = JSON.stringify(current);
  const next = change(current);
  return JSON.stringify(next) === before ? next : file.writeSync(next);
}
