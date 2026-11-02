import { documentIdentity } from "@jointarp/module/document-path";
import type { MapPoint, ModuleMap } from "@jointarp/module/map";
import {
  explorationGrid,
  firstBlocked,
  footprintPixels,
  isExplored,
  measurePath,
  pointAtDistance,
  pointInPolygon,
  round,
  snapToGrid,
  toUnits,
  wallSegments,
  type Point,
} from "@jointarp/module/map-geometry";
import { z } from "zod";

import { messageSchema } from "../../shared/game";
import type { SessionDatabase } from "../storage/session-database";
import { assertGameWritable } from "./adventure-status";
import { frozenModule } from "./frozen-module";
import { listGameFileRecords } from "./game-file-index";
import { tokenNames } from "./map-description";
import {
  analyzeRoute,
  explorationBits,
  exploreAlong,
  exploreCurrentVision,
  findPath,
  isParty,
  mapSides,
  movementBlockers,
  partyIndex,
  partyVision,
  regionLabel,
  regionsAt,
  resolveAnchor,
  tokensOn,
  visibleTokens,
  type MapAnchor,
} from "./map-space";
import { readMapState, writeMapState, type MapState, type MapTokenState } from "./map-state";
import { gameDirectoryForDatabase } from "./session-paths";
import { withStateLock } from "./state-lock";

const id = z.string().trim().min(1).max(200);
const side = z.enum(mapSides as [string, ...string[]]);
export const mapAnchorSchema = z.union([
  z.strictObject({ start: id }),
  z.strictObject({ region: id, side: side.optional() }),
  z.strictObject({ near: id, side: side.optional() }),
  z.strictObject({ x: z.number().finite(), y: z.number().finite() }),
]);
type AnchorInput = z.infer<typeof mapAnchorSchema>;

export const mapMoveSchema = z
  .strictObject({
    token: id.optional(),
    intent: z.string().uuid().optional(),
    to: mapAnchorSchema.optional(),
    until: z.number().nonnegative().optional(),
  })
  .refine((input) => Boolean(input.intent) !== Boolean(input.to), {
    message: "intent 与 to 必须且只能提供一个",
  })
  .refine((input) => input.intent || input.token, { message: "使用 to 时必须提供 token" });

const flags = {
  hidden: z.boolean().optional(),
  blocksVision: z.boolean().optional(),
  blocksMovement: z.boolean().optional(),
  vision: z.number().positive().nullable().optional(),
  size: z.number().positive().max(20).optional(),
  label: z.string().trim().min(1).max(100).optional(),
};
export const mapUpdateSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("place"),
    map: id,
    at: mapAnchorSchema,
    token: id.optional(),
    document: z.string().trim().min(1).max(1000).optional(),
    ...flags,
  }),
  z.strictObject({ action: z.literal("remove"), token: id }),
  z.strictObject({ action: z.literal("set"), token: id, ...flags }),
  z.strictObject({ action: z.literal("door"), map: id, door: id, open: z.boolean() }),
  z.strictObject({ action: z.literal("reveal"), map: id, door: id }),
  z.strictObject({ action: z.literal("conceal"), map: id, door: id }),
  z.strictObject({ action: z.literal("known"), map: id, known: z.boolean() }),
]);

function findMap(db: SessionDatabase, mapId: string): ModuleMap {
  const map = frozenModule(db).maps.find((item) => item.id === mapId || item.config.name === mapId);
  if (!map) throw new Error(`地图不存在：${mapId}`);
  return map;
}

function anchor(input: AnchorInput): MapAnchor {
  return "x" in input ? { point: [input.x, input.y] } : (input as MapAnchor);
}

function units(map: ModuleMap, point: Point) {
  return toUnits(map.config.grid, point);
}

function explorationShare(map: ModuleMap, state: MapState, points: readonly Point[]): number {
  const room = state.maps[map.id]!;
  const grid = explorationGrid(map.config);
  const bits = explorationBits(map, room);
  let total = 0;
  let explored = 0;
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      const center: Point = [(column + 0.5) * grid.cell, (row + 0.5) * grid.cell];
      if (!pointInPolygon(center, points)) continue;
      total++;
      if (isExplored(bits, grid, center)) explored++;
    }
  return total ? round(explored / total, 2) : 0;
}

/** 主持读取地图：区域、门、起点、全部标记与队伍视野，坐标使用距离单位。 */
export function readMap(db: SessionDatabase, mapId?: string) {
  const maps = frozenModule(db).maps;
  const state = readMapState(db);
  const party = partyIndex(db);
  if (!mapId)
    return {
      maps: maps.map((map) => ({
        id: map.id,
        name: map.config.name,
        known: state.maps[map.id]?.known ?? false,
        party: tokensOn(state, map.id)
          .filter(([, token]) => isParty(token, party))
          .map(([id]) => id),
      })),
    };
  const map = findMap(db, mapId);
  const room = state.maps[map.id]!;
  const names = tokenNames(db, state);
  const visible = visibleTokens(
    map,
    state,
    party,
    partyVision(map, room, state, party).map(({ polygon }) => polygon),
  );
  const regionNames = (point: Point) => regionsAt(map, point).map(regionLabel);
  const grid = map.config.grid;
  return {
    id: map.id,
    name: map.config.name,
    ...(map.config.description ? { description: map.config.description } : {}),
    known: room.known,
    scale:
      grid.type === "square"
        ? { grid: "square", cell: grid.distance, unit: grid.unit, diagonal: grid.diagonal }
        : { grid: "none", unit: grid.unit },
    size: units(map, [map.config.width, map.config.height]),
    regions: map.config.regions.map((region) => ({
      id: region.id,
      ...(region.name ? { name: region.name } : {}),
      ...(region.document ? { document: region.document } : {}),
      ...(region.secret ? { secret: true } : {}),
      ...(region.note ? { note: region.note } : {}),
      points: region.points.map((point) => units(map, point)),
      explored: explorationShare(map, state, region.points),
    })),
    doors: map.config.doors.map((door) => {
      const middle: Point = [(door.from[0] + door.to[0]) / 2, (door.from[1] + door.to[1]) / 2];
      const normal = [door.to[1] - door.from[1], door.from[0] - door.to[0]];
      const length = Math.hypot(normal[0]!, normal[1]!) || 1;
      const offset = footprintPixels(grid, 0.5);
      const sides = [1, -1].map((sign) =>
        regionNames([
          middle[0] + (sign * normal[0]! * offset) / length,
          middle[1] + (sign * normal[1]! * offset) / length,
        ]).join("/"),
      );
      const doorState = room.doors[door.id]!;
      return {
        id: door.id,
        at: units(map, middle),
        between: sides.map((item) => item || "区域外"),
        open: doorState.open,
        ...(door.secret ? { secret: true, revealed: doorState.revealed } : {}),
      };
    }),
    starts: map.config.starts.map((start) => ({
      id: start.id,
      name: start.name,
      at: units(map, start.at),
      regions: regionNames(start.at),
    })),
    tokens: tokensOn(state, map.id).map(([id, token]) => ({
      id,
      name: names.get(id),
      ...(token.document ? { document: token.document } : {}),
      at: units(map, token.at),
      regions: regionNames(token.at),
      size: token.size,
      ...(isParty(token, party) ? { party: true } : { visible: visible.has(id) }),
      ...(token.hidden ? { hidden: true } : {}),
      ...(token.blocksVision ? { blocksVision: true } : {}),
      ...(token.blocksMovement ? { blocksMovement: true } : {}),
      ...(token.vision !== undefined ? { vision: token.vision } : {}),
    })),
  };
}

async function mutate<T>(
  db: SessionDatabase,
  signal: AbortSignal | undefined,
  change: (state: MapState, party: ReadonlyMap<string, string>) => T,
): Promise<T> {
  return withStateLock(gameDirectoryForDatabase(db), async () => {
    signal?.throwIfAborted();
    assertGameWritable(db);
    const state = readMapState(db);
    const result = change(state, partyIndex(db));
    writeMapState(db, state);
    return result;
  });
}

function visibleSet(map: ModuleMap, state: MapState, party: ReadonlyMap<string, string>) {
  const room = state.maps[map.id]!;
  return visibleTokens(
    map,
    state,
    party,
    partyVision(map, room, state, party).map(({ polygon }) => polygon),
  );
}

function intentOf(db: SessionDatabase, messageId: string) {
  const row = db.get(
    db.query.selectFrom("chat_messages").select("data").where("id", "=", messageId),
  );
  const message = row ? messageSchema.parse(JSON.parse(String(row.data))) : undefined;
  if (message?.kind !== "player" || !message.movement) throw new Error("该消息没有移动意图");
  return message.movement;
}

/** 按意图路线或寻路移动标记；路线遇到墙或关闭的门时停在阻挡前。 */
export async function moveToken(db: SessionDatabase, raw: unknown, signal?: AbortSignal) {
  const input = mapMoveSchema.parse(raw);
  const intent = input.intent ? intentOf(db, input.intent) : undefined;
  const tokenId = intent?.token ?? input.token!;
  if (intent && input.token && input.token !== intent.token)
    throw new Error(`该意图属于标记 ${intent.token}`);
  return mutate(db, signal, (state, party) => {
    const token = state.tokens[tokenId];
    if (!token) throw new Error(`标记不存在：${tokenId}`);
    if (intent && token.map !== intent.map) throw new Error("标记已不在意图所在的地图上");
    const map = findMap(db, token.map);
    const room = state.maps[map.id]!;
    let path: MapPoint[];
    if (intent) path = [token.at, ...intent.waypoints];
    else {
      const target = resolveAnchor(map, room, state, anchor(input.to!), token.size, tokenId);
      const found = findPath(map, room, token.at, target);
      if (!found) throw new Error("无法到达：路线被墙或关闭的门隔断");
      path = found;
    }
    const grid = map.config.grid;
    const measure = measurePath(grid, path);
    let stop = input.until !== undefined ? Math.min(input.until, measure.total) : measure.total;
    let stoppedBy: string | undefined;
    const distanceAt = (hit: { segment: number; t: number }) =>
      measure.cumulative[hit.segment]! +
      hit.t * (measure.cumulative[hit.segment + 1]! - measure.cumulative[hit.segment]!);
    const half = (grid.type === "square" ? token.size * grid.distance : token.size) / 2;
    const blockers = [
      ...map.config.doors
        .filter((door) => !room.doors[door.id]?.open)
        .map((door) => ({ label: `门 ${door.id} 关闭`, segment: { a: door.from, b: door.to } })),
      ...wallSegments(map.config).map((segment) => ({ label: "墙", segment })),
    ];
    for (const blocker of blockers) {
      const hit = firstBlocked(path, [blocker.segment]);
      if (!hit) continue;
      const before = Math.max(0, distanceAt(hit) - half);
      if (before < stop) {
        stop = before;
        stoppedBy = blocker.label;
      }
    }
    const end = pointAtDistance(path, measure, stop);
    const walked: MapPoint[] = [...path.slice(0, end.segment + 1), end.point];
    if (stop < measure.total) {
      const snapped = snapToGrid(grid, end.point, token.size);
      if (!firstBlocked([end.point, snapped], movementBlockers(map, room))) walked.push(snapped);
    }
    const destination = path.at(-1)!;
    const route = analyzeRoute(map, state, tokenId, walked);
    const before = visibleSet(map, state, party);
    const final = walked.at(-1)!;
    token.at = [round(final[0], 2), round(final[1], 2)];
    exploreAlong(map, state, party, tokenId, walked);
    if (input.intent)
      state.intents[input.intent] = {
        progress: round((state.intents[input.intent]?.progress ?? 0) + stop),
      };
    const after = visibleSet(map, state, party);
    const names = tokenNames(db, state);
    return {
      token: tokenId,
      at: units(map, token.at),
      regions: regionsAt(map, token.at).map(regionLabel),
      moved: round(stop),
      remaining: round(measure.total - stop),
      ...(stoppedBy ? { stoppedBy } : {}),
      ...(stop < measure.total ? { destination: units(map, destination) } : {}),
      entered: route.events
        .filter((event) => event.kind === "enter")
        .map((event) => (event.kind === "enter" ? regionLabel(event.region) : "")),
      ...(route.endOverlap.length
        ? { overlapping: route.endOverlap.map((id) => `${names.get(id)}[${id}]`) }
        : {}),
      newlyVisible: [...after]
        .filter((id) => !before.has(id) && !isParty(state.tokens[id]!, party))
        .map((id) => `${names.get(id)}[${id}]`),
    };
  });
}

function newTokenId(state: MapState, base: string) {
  if (!state.tokens[base]) return base;
  for (let index = 2; ; index++) if (!state.tokens[`${base}-${index}`]) return `${base}-${index}`;
}

/** 主持维护标记、门与地图可见性；队伍角色放入地图后该地图对玩家可见。 */
export async function updateMap(db: SessionDatabase, raw: unknown, signal?: AbortSignal) {
  const input = mapUpdateSchema.parse(raw);
  return mutate(db, signal, (state, party) => {
    const refresh = (map: ModuleMap) => exploreCurrentVision(map, state, party);
    switch (input.action) {
      case "place": {
        const map = findMap(db, input.map);
        const document = input.document
          ? documentIdentity(input.document.replace(/^\//u, ""))
          : undefined;
        if (
          document &&
          !listGameFileRecords(db).some((record) => documentIdentity(record.path) === document)
        )
          throw new Error(`文档不存在：${input.document}`);
        // 未指定标识时，同一文档的标记直接移动；需要多个副本时显式指定新的 token。
        const tokenId =
          input.token ?? document ?? (input.label ? newTokenId(state, input.label) : undefined);
        if (!tokenId) throw new Error("新标记需要 token、document 或 label");
        const existing = state.tokens[tokenId];
        if (!existing && !document && !input.label) throw new Error("新标记需要 document 或 label");
        const base: MapTokenState = existing ?? {
          map: map.id,
          at: [0, 0],
          size: 1,
          hidden: false,
          blocksVision: false,
          blocksMovement: false,
          ...(document ? { document } : {}),
        };
        const previousMap = existing?.map;
        const token: MapTokenState = {
          ...base,
          map: map.id,
          ...(document ? { document } : {}),
          ...pickFlags(input),
        };
        if (input.label) token.label = input.label;
        token.at = resolveAnchor(
          map,
          state.maps[map.id]!,
          state,
          anchor(input.at),
          token.size,
          tokenId,
        );
        state.tokens[tokenId] = token;
        if (isParty(token, party)) state.maps[map.id]!.known = true;
        refresh(map);
        if (previousMap && previousMap !== map.id) refresh(findMap(db, previousMap));
        return {
          token: tokenId,
          map: map.id,
          at: units(map, token.at),
          regions: regionsAt(map, token.at).map(regionLabel),
        };
      }
      case "remove": {
        if (!state.tokens[input.token]) throw new Error(`标记不存在：${input.token}`);
        delete state.tokens[input.token];
        return { removed: input.token };
      }
      case "set": {
        const token = state.tokens[input.token];
        if (!token) throw new Error(`标记不存在：${input.token}`);
        Object.assign(token, pickFlags(input));
        if (input.label) token.label = input.label;
        refresh(findMap(db, token.map));
        return { token: input.token };
      }
      case "door":
      case "reveal":
      case "conceal": {
        const map = findMap(db, input.map);
        const door = state.maps[map.id]!.doors[input.door];
        const config = map.config.doors.find((item) => item.id === input.door);
        if (!door || !config) throw new Error(`地图「${map.config.name}」没有门 ${input.door}`);
        if (input.action === "door") {
          door.open = input.open;
          if (input.open) door.revealed = true;
        } else if (!config.secret) throw new Error(`门 ${input.door} 不是秘门`);
        else if (input.action === "reveal") door.revealed = true;
        else {
          door.revealed = false;
          door.open = false;
        }
        refresh(map);
        return { door: input.door, open: door.open, revealed: door.revealed };
      }
      case "known": {
        const map = findMap(db, input.map);
        state.maps[map.id]!.known = input.known;
        return { map: map.id, known: input.known };
      }
    }
  });
}

function pickFlags(input: {
  hidden?: boolean;
  blocksVision?: boolean;
  blocksMovement?: boolean;
  vision?: number | null;
  size?: number;
}): Partial<MapTokenState> {
  const flags: Partial<MapTokenState> = {};
  if (input.hidden !== undefined) flags.hidden = input.hidden;
  if (input.blocksVision !== undefined) flags.blocksVision = input.blocksVision;
  if (input.blocksMovement !== undefined) flags.blocksMovement = input.blocksMovement;
  if (input.vision !== undefined) flags.vision = input.vision;
  if (input.size !== undefined) flags.size = input.size;
  return flags;
}
