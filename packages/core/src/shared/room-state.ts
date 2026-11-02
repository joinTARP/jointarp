import type { Character } from "@jointarp/module/character";
import type { LaunchConfig } from "@jointarp/module/flow";
import type { RawModuleDocument } from "@jointarp/module/module-document";
import { z } from "zod";

import { identityIdSchema } from "./identity";
import type { LaunchState } from "./launch";
import type { MapResource, MapSection } from "./map";
import type { GameRoom, GameSession } from "./session";
import type { SessionMetrics } from "./session-metrics";

export const ROOM_PROTOCOL_VERSION = 1;
export const ROOM_SCHEMA_VERSION = "game-document-overlay-v1";
export const ROOM_MAX_ENTITIES = 10_000;
export const ROOM_MAX_DOCUMENT_BYTES = 1024 * 1024;
export const ROOM_MAX_OVERLAY_BYTES = 8 * 1024 * 1024;
export const ROOM_MAX_FRAME_BYTES = 10 * 1024 * 1024;

const frameBase = z.object({
  protocolVersion: z.literal(ROOM_PROTOCOL_VERSION),
  schemaVersion: z.literal(ROOM_SCHEMA_VERSION),
  baselineVersion: z.string().regex(/^[a-f0-9]{64}$/),
  streamId: z.string().uuid(),
  seq: z.number().int().positive().safe(),
  payload: z.string().max(Math.ceil(ROOM_MAX_FRAME_BYTES / 3) * 4),
});
export const roomStateFrameSchema = z.discriminatedUnion("kind", [
  frameBase.extend({ kind: z.literal("snapshot"), seq: z.literal(1) }),
  frameBase.extend({ kind: z.literal("patch"), baseSeq: z.number().int().positive().safe() }),
]);
export type RoomStateFrame = z.infer<typeof roomStateFrameSchema>;

export interface RoomEntity {
  id: string;
  revision: number;
  character?: Pick<Character, "id" | "typeId" | "playerId" | "sourcePath" | "retired" | "version">;
  document: Omit<RawModuleDocument, "id" | "revision"> & {
    readonly name?: string;
    readonly values: Readonly<Record<string, unknown>>;
  };
}
/** 冻结模组的完整原始文档基线，作为资源读取；不属于房间状态帧。 */
export interface RoomBaseline {
  version: string;
  entities: Readonly<Record<string, RoomEntity>>;
}
export interface SessionModuleResources extends GameSession {
  launchConfig?: LaunchConfig;
  maps: MapResource[];
  baseline: RoomBaseline;
}
/** 相对模组基线的累计覆盖；Map 项删除表示恢复基线。 */
export interface RoomEntityOverlay {
  revision?: number;
  /** null 显式解除角色归属；省略则沿用基线。 */
  character?: NonNullable<RoomEntity["character"]> | null;
  fields: Readonly<Record<string, unknown>>;
  removedFields: string[];
  document: Partial<Omit<RoomEntity["document"], "values">>;
  removedDocument: string[];
  created?: boolean;
  deleted?: boolean;
}
export type RoomLaunchState = Omit<
  LaunchState,
  "config" | "types" | "references" | "characters" | "openingMessage"
> & { characterIds: string[] };

const chatResponseActivitySchema = z.object({
  messageId: z.string().uuid(),
  nickname: z.string(),
  companionId: identityIdSchema.optional(),
  chatOnly: z.boolean().optional(),
  internal: z.boolean(),
});
/** 运行和排队控制独立于聊天历史分页，正文仍通过聊天流读取。 */
export const chatActivitySchema = z.object({
  pendingInput: z
    .object({ messageId: z.string().uuid(), batchId: z.string().uuid() })
    .nullable()
    .optional(),
  running: chatResponseActivitySchema.extend({ runId: z.string().uuid() }).nullable(),
  queued: chatResponseActivitySchema.nullable(),
});
export type ChatActivitySnapshot = z.infer<typeof chatActivitySchema>;

export interface RoomSections {
  viewerId: string;
  room: GameRoom;
  launch: RoomLaunchState | null;
  metrics: SessionMetrics;
  chatActivity: ChatActivitySnapshot;
  companionVersion: string;
  map: MapSection;
}
export interface RoomReplica {
  sections: RoomSections;
  documentRevision: number;
  entities: Readonly<Record<string, RoomEntity>>;
}

/** 主机投影始终提供累计覆盖及其版本，编码器只消费这个输入。 */
export interface RoomProjection extends RoomReplica {
  overlayRevision: number;
  overlays: Readonly<Record<string, RoomEntityOverlay>>;
}
