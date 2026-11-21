import { join } from "node:path";

import type { ModuleMap } from "@jointarp/module/map";
import { mapPointSchema } from "@jointarp/module/map";
import { decodeExploration, explorationGrid } from "@jointarp/module/map-geometry";
import { z } from "zod";

import { assertRegularFile } from "../storage/regular-file";
import type { SessionDatabase } from "../storage/session-database";
import { structuredFile } from "../storage/structured-file";
import { roomDirectoryForDatabase } from "./session-paths";
import { bumpStateRevision } from "./state-version";

const tokenStateSchema = z.strictObject({
  map: z.string().min(1),
  at: mapPointSchema,
  size: z.number().positive(),
  document: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  hidden: z.boolean(),
  blocksVision: z.boolean(),
  blocksMovement: z.boolean(),
  /** 覆盖地图默认视距；null 表示不限距离。 */
  vision: z.number().positive().nullable().optional(),
});
export type MapTokenState = z.infer<typeof tokenStateSchema>;

const mapRoomStateSchema = z.strictObject({
  /** 队伍可以浏览该地图；放入队伍角色或主持揭示后成立。 */
  known: z.boolean(),
  explored: z.string(),
  doors: z.record(z.string(), z.strictObject({ open: z.boolean(), revealed: z.boolean() })),
});
export type MapRoomState = z.infer<typeof mapRoomStateSchema>;

export const mapStateSchema = z.strictObject({
  maps: z.record(z.string(), mapRoomStateSchema),
  tokens: z.record(z.string(), tokenStateSchema),
  /** 主持已确认的意图路线进度，按距离单位计。 */
  intents: z.record(z.string(), z.strictObject({ progress: z.number().nonnegative() })),
});
export type MapState = z.infer<typeof mapStateSchema>;

function mapStateFile(directory: string) {
  return structuredFile(join(directory, "map-state.json"), {
    validate: (value) => mapStateSchema.parse(value),
    fileMode: 0o600,
  });
}

export function initialMapState(maps: readonly ModuleMap[]): MapState {
  const state: MapState = { maps: {}, tokens: {}, intents: {} };
  for (const map of maps) {
    state.maps[map.id] = {
      known: false,
      explored: "",
      doors: Object.fromEntries(
        map.config.doors.map((door) => [door.id, { open: door.open, revealed: !door.secret }]),
      ),
    };
    for (const token of map.config.tokens)
      state.tokens[token.id] = {
        map: map.id,
        at: token.at,
        size: token.size,
        ...(token.document ? { document: token.document } : {}),
        ...(token.label ? { label: token.label } : {}),
        hidden: token.hidden,
        blocksVision: token.blocksVision,
        blocksMovement: token.blocksMovement,
      };
  }
  return state;
}

/** 模组同步后保留仍然存在的地图、门与标记状态，新地图按初始配置加入。 */
export function reconcileMapState(
  previous: MapState,
  maps: readonly ModuleMap[],
  documents: ReadonlySet<string>,
): MapState {
  const initial = initialMapState(maps);
  const next: MapState = { maps: {}, tokens: {}, intents: previous.intents };
  for (const map of maps) {
    const before = previous.maps[map.id];
    const fresh = initial.maps[map.id]!;
    if (!before) {
      next.maps[map.id] = fresh;
      for (const [id, token] of Object.entries(initial.tokens))
        if (token.map === map.id && !previous.tokens[id]) next.tokens[id] = token;
      continue;
    }
    let explored = before.explored;
    try {
      decodeExploration(explored, explorationGrid(map.config));
    } catch {
      explored = "";
    }
    next.maps[map.id] = {
      known: before.known,
      explored,
      doors: Object.fromEntries(
        Object.entries(fresh.doors).map(([id, door]) => [id, before.doors[id] ?? door]),
      ),
    };
  }
  for (const [id, token] of Object.entries(previous.tokens)) {
    const map = maps.find((item) => item.id === token.map);
    if (!map) continue;
    if (token.document && !documents.has(token.document))
      throw new Error(`不能删除地图上仍有标记的文档：${token.document}`);
    next.tokens[id] = {
      ...token,
      at: [
        Math.min(map.config.width, Math.max(0, token.at[0])),
        Math.min(map.config.height, Math.max(0, token.at[1])),
      ],
    };
  }
  return next;
}

export function readMapStateFile(directory: string): MapState {
  assertRegularFile(join(directory, "map-state.json"));
  return mapStateFile(directory).readSync();
}

export function writeMapStateFile(directory: string, state: MapState): void {
  mapStateFile(directory).writeSync(state);
}

/** 仅在尚未发布的冒险 staging 目录初始化。 */
export function initializeMapState(directory: string, maps: readonly ModuleMap[]): void {
  mapStateFile(directory).writeSync(initialMapState(maps));
}

export function readMapState(db: SessionDatabase): MapState {
  return readMapStateFile(roomDirectoryForDatabase(db));
}

/** 调用方持有房间状态锁；提交后推进房间版本以刷新投影。 */
export function writeMapState(db: SessionDatabase, state: MapState): void {
  const directory = roomDirectoryForDatabase(db);
  assertRegularFile(join(directory, "map-state.json"));
  mapStateFile(directory).writeSync(state);
  bumpStateRevision(db);
}
