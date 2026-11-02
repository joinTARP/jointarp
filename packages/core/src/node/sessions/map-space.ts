import { documentIdentity } from "@jointarp/module/document-path";
import type { MapPoint, MapRegionConfig, ModuleMap } from "@jointarp/module/map";
import {
  decodeExploration,
  distance,
  encodeExploration,
  explorationGrid,
  firstBlocked,
  footprintPixels,
  fromUnits,
  isExplored,
  markExplored,
  measurePath,
  pixelsPerUnit,
  pointInPolygon,
  pointSegmentDistance,
  polylineSegments,
  segmentIntersection,
  snapToGrid,
  squareSegments,
  visibilityPolygon,
  wallSegments,
  type Point,
  type Segment,
} from "@jointarp/module/map-geometry";

import type { SessionDatabase } from "../storage/session-database";
import { readAdventureState } from "./adventure-state";
import type { MapRoomState, MapState, MapTokenState } from "./map-state";

/** 队伍角色：文档标识到控制者身份。 */
export function partyIndex(db: SessionDatabase): Map<string, string> {
  const party = new Map<string, string>();
  for (const character of readAdventureState(db).party.characters)
    if (character.playerId && !character.retired && character.sourcePath)
      party.set(documentIdentity(character.sourcePath), character.playerId);
  return party;
}

export function isParty(token: MapTokenState, party: ReadonlyMap<string, string>): boolean {
  return Boolean(token.document && party.has(token.document));
}

export function tokensOn(state: MapState, mapId: string): [string, MapTokenState][] {
  return Object.entries(state.tokens).filter(([, token]) => token.map === mapId);
}

export function regionLabel(region: MapRegionConfig): string {
  return region.name ?? region.id;
}

export function regionsAt(map: ModuleMap, point: Point): MapRegionConfig[] {
  return map.config.regions.filter((region) => pointInPolygon(point, region.points));
}

export function footprint(map: ModuleMap, token: Pick<MapTokenState, "size">): number {
  return footprintPixels(map.config.grid, token.size);
}

export function movementBlockers(map: ModuleMap, room: MapRoomState): Segment[] {
  return [
    ...wallSegments(map.config),
    ...map.config.doors
      .filter((door) => !room.doors[door.id]?.open)
      .map((door) => ({ a: door.from, b: door.to })),
  ];
}

function visionBlockers(
  map: ModuleMap,
  room: MapRoomState,
  state: MapState,
  party: ReadonlyMap<string, string>,
): Segment[] {
  return [
    ...movementBlockers(map, room),
    ...tokensOn(state, map.id)
      .filter(([, token]) => token.blocksVision && !isParty(token, party))
      .flatMap(([, token]) => squareSegments(token.at, footprint(map, token))),
  ];
}

export function visionRadius(map: ModuleMap, token: MapTokenState): number | undefined {
  const units = token.vision === undefined ? map.config.vision : (token.vision ?? undefined);
  return units === undefined ? undefined : units * pixelsPerUnit(map.config.grid);
}

/** 同图队伍角色各自的可见范围，全队共享。 */
export function partyVision(
  map: ModuleMap,
  room: MapRoomState,
  state: MapState,
  party: ReadonlyMap<string, string>,
): { readonly token: string; readonly polygon: MapPoint[] }[] {
  const blockers = visionBlockers(map, room, state, party);
  return tokensOn(state, map.id)
    .filter(([, token]) => isParty(token, party))
    .map(([id, token]) => ({
      token: id,
      polygon: visibilityPolygon(token.at, blockers, map.config, visionRadius(map, token)),
    }));
}

function samplePoints(map: ModuleMap, token: MapTokenState): Point[] {
  const [x, y] = token.at;
  // 遮挡视线的物件自身挡住中心，改为检查各边外侧。
  const half = token.blocksVision ? footprint(map, token) / 2 + 2 : footprint(map, token) / 2.5;
  return [
    ...(token.blocksVision ? [] : [[x, y] as Point]),
    [x - half, y],
    [x + half, y],
    [x, y - half],
    [x, y + half],
  ];
}

export function visibleTokens(
  map: ModuleMap,
  state: MapState,
  party: ReadonlyMap<string, string>,
  polygons: readonly (readonly Point[])[],
): Set<string> {
  const visible = new Set<string>();
  for (const [id, token] of tokensOn(state, map.id)) {
    if (isParty(token, party)) visible.add(id);
    else if (
      !token.hidden &&
      samplePoints(map, token).some((point) =>
        polygons.some((polygon) => pointInPolygon(point, polygon)),
      )
    )
      visible.add(id);
  }
  return visible;
}

export function explorationBits(map: ModuleMap, room: MapRoomState): Uint8Array {
  return decodeExploration(room.explored, explorationGrid(map.config));
}

/** 按队伍角色当前视野补充探索记录。 */
export function exploreCurrentVision(
  map: ModuleMap,
  state: MapState,
  party: ReadonlyMap<string, string>,
): void {
  const room = state.maps[map.id]!;
  const grid = explorationGrid(map.config);
  const bits = explorationBits(map, room);
  let changed = false;
  for (const { polygon } of partyVision(map, room, state, party))
    changed = markExplored(bits, grid, polygon) || changed;
  if (changed) room.explored = encodeExploration(bits);
}

/** 沿实际走过的路线揭示沿途视野，不揭示尚未抵达的部分。 */
export function exploreAlong(
  map: ModuleMap,
  state: MapState,
  party: ReadonlyMap<string, string>,
  tokenId: string,
  path: readonly Point[],
): void {
  const token = state.tokens[tokenId]!;
  if (!isParty(token, party)) return;
  const room = state.maps[map.id]!;
  const grid = explorationGrid(map.config);
  const bits = explorationBits(map, room);
  const blockers = visionBlockers(map, room, state, party);
  const radius = visionRadius(map, token);
  const step = Math.max(grid.cell * 2, footprint(map, token) / 2);
  const points = path.length === 1 ? [path[0]!, path[0]!] : path;
  let changed = false;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const count = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let sample = 0; sample <= count; sample++) {
      const t = sample / count;
      const origin: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      changed =
        markExplored(bits, grid, visibilityPolygon(origin, blockers, map.config, radius)) ||
        changed;
    }
  }
  if (changed) room.explored = encodeExploration(bits);
}

export type MapSide =
  | "center"
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest";

const sideVectors: Record<MapSide, Point> = {
  center: [0, 0],
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
  northeast: [1, -1],
  northwest: [-1, -1],
  southeast: [1, 1],
  southwest: [-1, 1],
};
export const mapSides = Object.keys(sideVectors) as MapSide[];

export type MapAnchor =
  | { readonly start: string }
  | { readonly region: string; readonly side?: MapSide }
  | { readonly near: string; readonly side?: MapSide }
  | { readonly point: Point };

function findRegion(map: ModuleMap, name: string): MapRegionConfig {
  const region = map.config.regions.find((item) => item.id === name || item.name === name);
  if (!region) throw new Error(`地图「${map.config.name}」没有区域「${name}」`);
  return region;
}

export { findRegion };

function regionPoint(map: ModuleMap, region: MapRegionConfig, side: MapSide, size: number): Point {
  const xs = region.points.map((point) => point[0]);
  const ys = region.points.map((point) => point[1]);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const center: Point = [(minX + maxX) / 2, (minY + maxY) / 2];
  const inset = footprintPixels(map.config.grid, size) / 2;
  const vector = sideVectors[side];
  const target: Point = [
    center[0] + vector[0] * Math.max(0, (maxX - minX) / 2 - inset),
    center[1] + vector[1] * Math.max(0, (maxY - minY) / 2 - inset),
  ];
  // 凹多边形的方位点可能落在区域外，沿中心连线收回到区域内。
  for (let step = 0; step <= 20; step++) {
    const t = 1 - step / 20;
    const point: Point = [
      center[0] + t * (target[0] - center[0]),
      center[1] + t * (target[1] - center[1]),
    ];
    if (pointInPolygon(point, region.points)) return point;
  }
  // 中心也在区域外（如 L 形），取区域内离目标最近、能容下占地的采样点。
  const step = Math.max((maxX - minX) / 64, (maxY - minY) / 64, 1);
  const edges = regionSegments(region);
  let best: { point: Point; roomy: boolean; gap: number } | undefined;
  for (let x = minX + step / 2; x < maxX; x += step)
    for (let y = minY + step / 2; y < maxY; y += step) {
      const point: Point = [x, y];
      if (!pointInPolygon(point, region.points)) continue;
      const roomy = edges.every((edge) => pointSegmentDistance(point, edge) >= inset);
      const gap = distance(point, target);
      if (!best || (roomy && !best.roomy) || (roomy === best.roomy && gap < best.gap))
        best = { point, roomy, gap };
    }
  return best?.point ?? region.points[0]!;
}

/** 把主持指定的位置解析为像素坐标，方格地图对齐格心。 */
export function resolveAnchor(
  map: ModuleMap,
  room: MapRoomState,
  state: MapState,
  anchor: MapAnchor,
  size: number,
  self?: string,
): MapPoint {
  const grid = map.config.grid;
  const snapInside = (point: Point, polygon?: readonly Point[]) => {
    const snapped = snapToGrid(grid, point, size);
    return !polygon || pointInPolygon(snapped, polygon)
      ? snapped
      : ([point[0], point[1]] as MapPoint);
  };
  if ("start" in anchor) {
    const start = map.config.starts.find(
      (item) => item.id === anchor.start || item.name === anchor.start,
    );
    if (!start) throw new Error(`地图「${map.config.name}」没有起点「${anchor.start}」`);
    return snapInside(start.at);
  }
  if ("point" in anchor) return snapInside(fromUnits(grid, anchor.point));
  if ("region" in anchor) {
    const region = findRegion(map, anchor.region);
    return snapInside(regionPoint(map, region, anchor.side ?? "center", size), region.points);
  }
  const target = state.tokens[anchor.near];
  if (!target || target.map !== map.id)
    throw new Error(`地图「${map.config.name}」上没有标记「${anchor.near}」`);
  const gap = (footprint(map, target) + footprintPixels(grid, size)) / 2;
  const blockers = movementBlockers(map, room);
  const candidates = (
    anchor.side
      ? [anchor.side]
      : ([
          "east",
          "west",
          "south",
          "north",
          "southeast",
          "southwest",
          "northeast",
          "northwest",
        ] as const)
  ).map((side) => {
    const vector = sideVectors[side];
    const length = Math.hypot(vector[0], vector[1]) || 1;
    return snapInside([
      target.at[0] + (vector[0] / length) * gap * (side.length > 5 ? Math.SQRT2 : 1),
      target.at[1] + (vector[1] / length) * gap * (side.length > 5 ? Math.SQRT2 : 1),
    ]);
  });
  const free = candidates.find(
    (point) =>
      !firstBlocked([target.at, point], blockers) &&
      point[0] >= 0 &&
      point[1] >= 0 &&
      point[0] <= map.config.width &&
      point[1] <= map.config.height &&
      !overlapping(map, state, point, size, self).length,
  );
  return free ?? candidates[0]!;
}

/** 占地与给定位置重叠的其他标记。 */
export function overlapping(
  map: ModuleMap,
  state: MapState,
  point: Point,
  size: number,
  self?: string,
): string[] {
  const own = footprintPixels(map.config.grid, size);
  return tokensOn(state, map.id)
    .filter(
      ([id, token]) =>
        id !== self && distance(token.at, point) < ((footprint(map, token) + own) / 2) * 0.9,
    )
    .map(([id]) => id);
}

class SegmentIndex {
  private readonly buckets = new Map<string, Segment[]>();
  constructor(
    segments: readonly Segment[],
    private readonly size: number,
  ) {
    for (const segment of segments)
      for (const key of this.keys(segment.a, segment.b)) {
        let bucket = this.buckets.get(key);
        if (!bucket) this.buckets.set(key, (bucket = []));
        bucket.push(segment);
      }
  }
  private keys(a: Point, b: Point): string[] {
    const keys: string[] = [];
    const [x0, x1] = [
      Math.floor(Math.min(a[0], b[0]) / this.size),
      Math.floor(Math.max(a[0], b[0]) / this.size),
    ];
    const [y0, y1] = [
      Math.floor(Math.min(a[1], b[1]) / this.size),
      Math.floor(Math.max(a[1], b[1]) / this.size),
    ];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
    return keys;
  }
  blocked(a: Point, b: Point): boolean {
    const seen = new Set<Segment>();
    const candidates: Segment[] = [];
    for (const key of this.keys(a, b))
      for (const segment of this.buckets.get(key) ?? [])
        if (!seen.has(segment)) {
          seen.add(segment);
          candidates.push(segment);
        }
    return Boolean(firstBlocked([a, b], candidates));
  }
}

const maxExpansions = 200_000;

/** 在不穿墙与关闭门的前提下寻找路线，并拉直为尽量少的转折点。 */
export function findPath(
  map: ModuleMap,
  room: MapRoomState,
  from: Point,
  to: Point,
): MapPoint[] | undefined {
  const blockers = movementBlockers(map, room);
  const grid = explorationGrid(map.config);
  const index = new SegmentIndex(blockers, grid.cell * 4);
  if (!index.blocked(from, to))
    return [
      [from[0], from[1]],
      [to[0], to[1]],
    ];
  const cellOf = (point: Point) =>
    [
      Math.min(grid.columns - 1, Math.max(0, Math.floor(point[0] / grid.cell))),
      Math.min(grid.rows - 1, Math.max(0, Math.floor(point[1] / grid.cell))),
    ] as const;
  const centerOf = (column: number, row: number): Point => [
    (column + 0.5) * grid.cell,
    (row + 0.5) * grid.cell,
  ];
  const [startColumn, startRow] = cellOf(from);
  const [goalColumn, goalRow] = cellOf(to);
  const key = (column: number, row: number) => row * grid.columns + column;
  const goal = key(goalColumn, goalRow);
  const cost = new Map<number, number>([[key(startColumn, startRow), 0]]);
  const parent = new Map<number, number>();
  const open: { key: number; score: number }[] = [{ key: key(startColumn, startRow), score: 0 }];
  const closed = new Set<number>();
  const position = (value: number): Point =>
    value === key(startColumn, startRow)
      ? from
      : centerOf(value % grid.columns, Math.floor(value / grid.columns));
  let expansions = 0;
  while (open.length && expansions++ < maxExpansions) {
    let best = 0;
    for (let item = 1; item < open.length; item++)
      if (open[item]!.score < open[best]!.score) best = item;
    const current = open.splice(best, 1)[0]!.key;
    if (closed.has(current)) continue;
    closed.add(current);
    if (current === goal) break;
    const column = current % grid.columns;
    const row = Math.floor(current / grid.columns);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nextColumn = column + dx;
        const nextRow = row + dy;
        if (nextColumn < 0 || nextRow < 0 || nextColumn >= grid.columns || nextRow >= grid.rows)
          continue;
        const next = key(nextColumn, nextRow);
        if (closed.has(next)) continue;
        const a = position(current);
        const b = next === goal ? to : centerOf(nextColumn, nextRow);
        if (index.blocked(a, b)) continue;
        const tentative = cost.get(current)! + distance(a, b);
        if (tentative >= (cost.get(next) ?? Number.POSITIVE_INFINITY)) continue;
        cost.set(next, tentative);
        parent.set(next, current);
        open.push({ key: next, score: tentative + distance(b, to) });
      }
  }
  if (!closed.has(goal)) return undefined;
  const raw: Point[] = [to];
  for (let current = goal; parent.has(current);) {
    current = parent.get(current)!;
    raw.unshift(position(current));
  }
  if (raw[0] !== from) raw.unshift(from);
  const smooth: MapPoint[] = [[from[0], from[1]]];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let next = raw.length - 1;
    while (next > anchor + 1 && index.blocked(raw[anchor]!, raw[next]!)) next--;
    smooth.push([raw[next]![0], raw[next]![1]]);
    anchor = next;
  }
  return smooth;
}

export type RouteEvent =
  | { readonly kind: "enter" | "leave"; readonly at: number; readonly region: MapRegionConfig }
  | {
      readonly kind: "door";
      readonly at: number;
      readonly door: string;
      readonly open: boolean;
      readonly narrow: boolean;
    }
  | { readonly kind: "unexplored"; readonly at: number }
  | { readonly kind: "blocked"; readonly at: number }
  | {
      readonly kind: "obstacle";
      readonly at: number;
      readonly token: string;
      readonly blocking: boolean;
    };

export interface RouteAnalysis {
  readonly length: number;
  readonly cumulative: readonly number[];
  readonly events: readonly RouteEvent[];
  readonly startRegions: readonly MapRegionConfig[];
  readonly endRegions: readonly MapRegionConfig[];
  readonly endOverlap: readonly string[];
}

/** 把路线翻译为区域进出、门、未探索区域与经过的标记，距离按地图单位计。 */
export function analyzeRoute(
  map: ModuleMap,
  state: MapState,
  tokenId: string,
  path: readonly Point[],
): RouteAnalysis {
  const room = state.maps[map.id]!;
  const token = state.tokens[tokenId]!;
  const grid = map.config.grid;
  const { cumulative, total } = measurePath(grid, path);
  const own = footprint(map, token);
  const bits = explorationBits(map, room);
  const exploration = explorationGrid(map.config);
  const events: RouteEvent[] = [];
  const at = (segment: number, t: number) =>
    cumulative[segment]! + t * (cumulative[segment + 1]! - cumulative[segment]!);
  const blocked = firstBlocked(path, wallSegments(map.config));
  if (blocked) events.push({ kind: "blocked", at: at(blocked.segment, blocked.t) });
  const others = tokensOn(state, map.id).filter(([id]) => id !== tokenId);
  const reported = new Set<string>();
  for (let index = 1; index < path.length; index++) {
    const move: Segment = { a: path[index - 1]!, b: path[index]! };
    for (const door of map.config.doors) {
      const t = segmentIntersection(move, { a: door.from, b: door.to });
      if (t === undefined) continue;
      events.push({
        kind: "door",
        at: at(index - 1, t),
        door: door.id,
        open: Boolean(room.doors[door.id]?.open),
        narrow: distance(door.from, door.to) < own * 0.95,
      });
    }
    for (const [id, other] of others) {
      if (reported.has(id)) continue;
      if (pointSegmentDistance(other.at, move) >= ((footprint(map, other) + own) / 2) * 0.9)
        continue;
      if (distance(other.at, path[path.length - 1]!) < ((footprint(map, other) + own) / 2) * 0.9)
        continue;
      reported.add(id);
      const length = distance(move.a, move.b) || 1;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((other.at[0] - move.a[0]) * (move.b[0] - move.a[0]) +
            (other.at[1] - move.a[1]) * (move.b[1] - move.a[1])) /
            length ** 2,
        ),
      );
      events.push({
        kind: "obstacle",
        at: at(index - 1, t),
        token: id,
        blocking: other.blocksMovement,
      });
    }
  }
  const step = pixelsPerUnit(grid) * 0.1;
  let inside = new Set(regionsAt(map, path[0]!).map((region) => region.id));
  let unknown = !isExplored(bits, exploration, path[0]!);
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1]!;
    const b = path[index]!;
    const count = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let sample = 1; sample <= count; sample++) {
      const t = sample / count;
      const point: Point = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      const here = regionsAt(map, point);
      const ids = new Set(here.map((region) => region.id));
      for (const region of map.config.regions) {
        if (ids.has(region.id) && !inside.has(region.id))
          events.push({ kind: "enter", at: at(index - 1, t), region });
        if (!ids.has(region.id) && inside.has(region.id))
          events.push({ kind: "leave", at: at(index - 1, t), region });
      }
      inside = ids;
      if (!unknown && !isExplored(bits, exploration, point)) {
        unknown = true;
        events.push({ kind: "unexplored", at: at(index - 1, t) });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  const end = path[path.length - 1]!;
  return {
    length: total,
    cumulative,
    events,
    startRegions: regionsAt(map, path[0]!),
    endRegions: regionsAt(map, end),
    endOverlap: overlapping(map, state, end, token.size, tokenId),
  };
}

export function doorSegments(map: ModuleMap): Segment[] {
  return map.config.doors.map((door) => ({ a: door.from, b: door.to }));
}

export function regionSegments(region: MapRegionConfig): Segment[] {
  return polylineSegments([...region.points, region.points[0]!]);
}
