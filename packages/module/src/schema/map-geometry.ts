import type { MapConfig, MapGrid, MapPoint } from "./map";

export type Point = readonly [number, number];
export interface Segment {
  readonly a: Point;
  readonly b: Point;
}

const epsilon = 1e-6;

/** 每个距离单位对应的底图像素数。 */
export function pixelsPerUnit(grid: MapGrid): number {
  return grid.type === "square" ? grid.size / grid.distance : grid.pixelsPerUnit;
}

/** 占地边长（格数或距离单位）对应的像素边长。 */
export function footprintPixels(grid: MapGrid, size: number): number {
  return grid.type === "square" ? grid.size * size : grid.pixelsPerUnit * size;
}

export function toUnits(grid: MapGrid, point: Point): [number, number] {
  const scale = pixelsPerUnit(grid);
  return [round(point[0] / scale), round(point[1] / scale)];
}

export function fromUnits(grid: MapGrid, point: Point): MapPoint {
  const scale = pixelsPerUnit(grid);
  return [point[0] * scale, point[1] * scale];
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 方格地图把标记中心对齐到格心；占地为偶数格时对齐到格线交点。 */
export function snapToGrid(grid: MapGrid, point: Point, size = 1): MapPoint {
  if (grid.type !== "square") return [point[0], point[1]];
  const even = Math.round(size) % 2 === 0;
  const snap = (value: number, offset: number) => {
    const cell = (value - offset) / grid.size;
    return (even ? Math.round(cell) : Math.floor(cell) + 0.5) * grid.size + offset;
  };
  return [snap(point[0], grid.offset[0]), snap(point[1], grid.offset[1])];
}

export function polylineSegments(points: readonly Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index++)
    segments.push({ a: points[index - 1]!, b: points[index]! });
  return segments;
}

export function wallSegments(config: Pick<MapConfig, "walls">): Segment[] {
  return config.walls.flatMap((wall) => polylineSegments(wall.points));
}

/** 正方形占地的四条边，用于明确设置遮挡的物件。 */
export function squareSegments(center: Point, side: number): Segment[] {
  const half = side / 2;
  const [x, y] = center;
  const corners: Point[] = [
    [x - half, y - half],
    [x + half, y - half],
    [x + half, y + half],
    [x - half, y + half],
    [x - half, y - half],
  ];
  return polylineSegments(corners);
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pointSegmentDistance(point: Point, segment: Segment): number {
  const { a, b } = segment;
  const length = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  if (length < epsilon) return distance(point, a);
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / length),
  );
  return distance(point, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

/** 两条线段相交时返回第一条线段上的参数 t。 */
export function segmentIntersection(first: Segment, second: Segment): number | undefined {
  const r = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
  const s = [second.b[0] - second.a[0], second.b[1] - second.a[1]];
  const denominator = r[0]! * s[1]! - r[1]! * s[0]!;
  const qp = [second.a[0] - first.a[0], second.a[1] - first.a[1]];
  if (Math.abs(denominator) < epsilon) {
    if (Math.abs(cross(first.a, first.b, second.a)) > epsilon) return undefined;
    // 共线时按重叠区间的起点处理。
    const length = r[0]! ** 2 + r[1]! ** 2;
    if (length < epsilon) return undefined;
    const t0 = (qp[0]! * r[0]! + qp[1]! * r[1]!) / length;
    const t1 = t0 + (s[0]! * r[0]! + s[1]! * r[1]!) / length;
    const start = Math.max(0, Math.min(t0, t1));
    return start <= Math.min(1, Math.max(t0, t1)) ? start : undefined;
  }
  const t = (qp[0]! * s[1]! - qp[1]! * s[0]!) / denominator;
  const u = (qp[0]! * r[1]! - qp[1]! * r[0]!) / denominator;
  return t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon
    ? Math.max(0, Math.min(1, t))
    : undefined;
}

/** 路线中第一处碰到阻挡线段的位置；擦过墙角同样视为阻挡。 */
export function firstBlocked(
  path: readonly Point[],
  blockers: readonly Segment[],
): { readonly segment: number; readonly t: number } | undefined {
  for (let index = 1; index < path.length; index++) {
    const move = { a: path[index - 1]!, b: path[index]! };
    let hit: number | undefined;
    for (const blocker of blockers) {
      const t = segmentIntersection(move, blocker);
      if (t === undefined || (index === 1 && t < epsilon)) continue;
      if (hit === undefined || t < hit) hit = t;
    }
    if (hit !== undefined) return { segment: index - 1, t: hit };
  }
  return undefined;
}

export interface PathMeasure {
  /** 各路线点处的累计距离，按距离单位计。 */
  readonly cumulative: readonly number[];
  readonly total: number;
}

/** 按地图计距方式测量路线；交替斜向计距在整条路线上连续计数。 */
export function measurePath(grid: MapGrid, path: readonly Point[]): PathMeasure {
  const cumulative = [0];
  let total = 0;
  let diagonals = 0;
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1]!;
    const b = path[index]!;
    let cost: number;
    if (grid.type === "none") {
      cost = distance(a, b) / grid.pixelsPerUnit;
    } else {
      const dx = Math.abs(b[0] - a[0]) / grid.size;
      const dy = Math.abs(b[1] - a[1]) / grid.size;
      const diagonal = Math.min(dx, dy);
      const straight = Math.max(dx, dy) - diagonal;
      if (grid.diagonal === "euclidean") cost = Math.hypot(dx, dy);
      else if (grid.diagonal === "equal") cost = straight + diagonal;
      else {
        const extra = Math.floor((diagonals + diagonal) / 2) - Math.floor(diagonals / 2);
        diagonals += diagonal;
        cost = straight + diagonal + extra;
      }
      cost *= grid.distance;
    }
    total += cost;
    cumulative.push(total);
  }
  return { cumulative, total };
}

/** 路线上累计距离达到指定值的位置。 */
export function pointAtDistance(
  path: readonly Point[],
  measure: PathMeasure,
  target: number,
): { readonly point: MapPoint; readonly segment: number } {
  const clamped = Math.max(0, Math.min(measure.total, target));
  for (let index = 1; index < path.length; index++) {
    const start = measure.cumulative[index - 1]!;
    const end = measure.cumulative[index]!;
    if (clamped <= end + epsilon || index === path.length - 1) {
      const t = end - start < epsilon ? 1 : Math.min(1, (clamped - start) / (end - start));
      const a = path[index - 1]!;
      const b = path[index]!;
      return { point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], segment: index - 1 };
    }
  }
  const first = path[0]!;
  return { point: [first[0], first[1]], segment: 0 };
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

const circleRays = 72;

/** 从视点出发、被线段遮挡的可见多边形；radius 省略时只受底图边界限制。 */
export function visibilityPolygon(
  origin: Point,
  blockers: readonly Segment[],
  bounds: { readonly width: number; readonly height: number },
  radius?: number,
): MapPoint[] {
  const { width, height } = bounds;
  const edges = polylineSegments([
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
    [0, 0],
  ]);
  const segments = [
    ...(radius === undefined
      ? blockers
      : blockers.filter((segment) => pointSegmentDistance(origin, segment) <= radius)),
    ...edges,
  ];
  const angles: number[] = [];
  for (const segment of segments)
    for (const point of [segment.a, segment.b]) {
      const angle = Math.atan2(point[1] - origin[1], point[0] - origin[0]);
      angles.push(angle - 1e-4, angle, angle + 1e-4);
    }
  if (radius !== undefined)
    for (let index = 0; index < circleRays; index++)
      angles.push(-Math.PI + (index * 2 * Math.PI) / circleRays);
  angles.sort((a, b) => a - b);
  const polygon: MapPoint[] = [];
  let previous = Number.NaN;
  for (const angle of angles) {
    if (Math.abs(angle - previous) < 1e-9) continue;
    previous = angle;
    const direction: Point = [Math.cos(angle), Math.sin(angle)];
    let nearest = Number.POSITIVE_INFINITY;
    for (const segment of segments) {
      const hit = rayHit(origin, direction, segment);
      if (hit !== undefined && hit < nearest) nearest = hit;
    }
    if (radius !== undefined) nearest = Math.min(nearest, radius);
    if (!Number.isFinite(nearest)) continue;
    polygon.push([origin[0] + direction[0] * nearest, origin[1] + direction[1] * nearest]);
  }
  return polygon;
}

function rayHit(origin: Point, direction: Point, segment: Segment): number | undefined {
  const s = [segment.b[0] - segment.a[0], segment.b[1] - segment.a[1]] as const;
  const denominator = direction[0] * s[1] - direction[1] * s[0];
  if (Math.abs(denominator) < epsilon) return undefined;
  const qp = [segment.a[0] - origin[0], segment.a[1] - origin[1]] as const;
  const t = (qp[0] * s[1] - qp[1] * s[0]) / denominator;
  const u = (qp[0] * direction[1] - qp[1] * direction[0]) / denominator;
  return t >= 0 && u >= -epsilon && u <= 1 + epsilon ? t : undefined;
}

/** 探索记录的栅格；格边长随底图比例尺变化，并限制总格数。 */
export interface ExplorationGrid {
  readonly cell: number;
  readonly columns: number;
  readonly rows: number;
}

const maxExplorationCells = 512 * 512;

export function explorationGrid(
  config: Pick<MapConfig, "grid" | "width" | "height">,
): ExplorationGrid {
  let cell = config.grid.type === "square" ? config.grid.size / 2 : config.grid.pixelsPerUnit / 2;
  cell = Math.max(cell, Math.sqrt((config.width * config.height) / maxExplorationCells));
  return {
    cell,
    columns: Math.ceil(config.width / cell),
    rows: Math.ceil(config.height / cell),
  };
}

export function createExploration(grid: ExplorationGrid): Uint8Array {
  return new Uint8Array(Math.ceil((grid.columns * grid.rows) / 8));
}

export function isExplored(bits: Uint8Array, grid: ExplorationGrid, point: Point): boolean {
  const column = Math.floor(point[0] / grid.cell);
  const row = Math.floor(point[1] / grid.cell);
  if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return false;
  const index = row * grid.columns + column;
  return ((bits[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

/** 把格心落在多边形内的格子记为已探索；返回是否有新格子。 */
export function markExplored(
  bits: Uint8Array,
  grid: ExplorationGrid,
  polygon: readonly Point[],
): boolean {
  if (polygon.length < 3) return false;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  let changed = false;
  const firstColumn = Math.max(0, Math.floor(minX / grid.cell));
  const lastColumn = Math.min(grid.columns - 1, Math.floor(maxX / grid.cell));
  const firstRow = Math.max(0, Math.floor(minY / grid.cell));
  const lastRow = Math.min(grid.rows - 1, Math.floor(maxY / grid.cell));
  for (let row = firstRow; row <= lastRow; row++)
    for (let column = firstColumn; column <= lastColumn; column++) {
      const index = row * grid.columns + column;
      const mask = 1 << (index & 7);
      if ((bits[index >> 3]! & mask) !== 0) continue;
      if (!pointInPolygon([(column + 0.5) * grid.cell, (row + 0.5) * grid.cell], polygon)) continue;
      bits[index >> 3]! |= mask;
      changed = true;
    }
  return changed;
}

export function encodeExploration(bits: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bits.length; index += 0x8000)
    binary += String.fromCharCode(...bits.subarray(index, index + 0x8000));
  return btoa(binary);
}

export function decodeExploration(value: string, grid: ExplorationGrid): Uint8Array {
  const bits = createExploration(grid);
  if (!value) return bits;
  const binary = atob(value);
  if (binary.length !== bits.length) throw new Error("探索记录与地图尺寸不一致");
  for (let index = 0; index < binary.length; index++) bits[index] = binary.charCodeAt(index);
  return bits;
}
