import { test } from "bun:test";
import { strict as assert } from "node:assert";

import type { MapGrid } from "./map";
import {
  createExploration,
  decodeExploration,
  encodeExploration,
  explorationGrid,
  firstBlocked,
  isExplored,
  markExplored,
  measurePath,
  pointAtDistance,
  pointInPolygon,
  snapToGrid,
  visibilityPolygon,
} from "./map-geometry";

const square = (diagonal: "equal" | "alternate" | "euclidean"): MapGrid => ({
  type: "square",
  size: 100,
  distance: 5,
  unit: "尺",
  diagonal,
  offset: [0, 0],
});

test("地图几何按计距规则测量、对齐格心并判断墙体阻挡与视野", () => {
  const diagonal = [
    [50, 50],
    [250, 250],
    [350, 350],
  ] as const;
  assert.equal(measurePath(square("equal"), diagonal).total, 15);
  // 交替斜向在整条路线上连续计数：第二格斜向记两格。
  assert.equal(measurePath(square("alternate"), diagonal).total, 20);
  assert.ok(
    Math.abs(
      measurePath(square("euclidean"), [
        [0, 0],
        [300, 400],
      ]).total - 25,
    ) < 1e-9,
  );
  assert.equal(
    measurePath({ type: "none", pixelsPerUnit: 50, unit: "米" }, [
      [0, 0],
      [100, 0],
    ]).total,
    2,
  );
  const line = [
    [0, 0],
    [200, 0],
    [200, 200],
  ] as const;
  assert.deepEqual(pointAtDistance(line, measurePath(square("equal"), line), 15).point, [200, 100]);

  assert.deepEqual(snapToGrid(square("equal"), [130, 270]), [150, 250]);
  assert.deepEqual(snapToGrid(square("equal"), [130, 270], 2), [100, 300]);

  const wall = { a: [500, 0] as const, b: [500, 600] as const };
  assert.deepEqual(
    firstBlocked(
      [
        [100, 300],
        [900, 300],
      ],
      [wall],
    ),
    { segment: 0, t: 0.5 },
  );
  assert.equal(
    firstBlocked(
      [
        [100, 300],
        [400, 300],
      ],
      [wall],
    ),
    undefined,
  );
  // 紧贴墙体出发不算阻挡，擦过墙端点算阻挡。
  assert.equal(
    firstBlocked(
      [
        [500, 300],
        [100, 300],
      ],
      [wall],
    ),
    undefined,
  );
  assert.ok(
    firstBlocked(
      [
        [400, -100],
        [600, 100],
      ],
      [wall],
    ),
  );

  const bounds = { width: 1000, height: 600 };
  const visible = visibilityPolygon([100, 300], [wall], bounds);
  assert.ok(pointInPolygon([450, 100], visible));
  assert.ok(!pointInPolygon([700, 300], visible));
  const limited = visibilityPolygon([100, 300], [], bounds, 200);
  assert.ok(pointInPolygon([250, 300], limited));
  assert.ok(!pointInPolygon([350, 300], limited));
});

test("探索记录按格心标记并可编码往返", () => {
  const config = { grid: square("equal"), width: 1000, height: 600 };
  const grid = explorationGrid(config);
  assert.deepEqual(grid, { cell: 50, columns: 20, rows: 12 });
  const bits = createExploration(grid);
  const room = [
    [0, 0],
    [500, 0],
    [500, 600],
    [0, 600],
  ] as const;
  assert.equal(markExplored(bits, grid, room), true);
  assert.equal(markExplored(bits, grid, room), false);
  const decoded = decodeExploration(encodeExploration(bits), grid);
  assert.ok(isExplored(decoded, grid, [480, 580]));
  assert.ok(!isExplored(decoded, grid, [520, 20]));
  assert.throws(() => decodeExploration(btoa("x"), grid), /尺寸不一致/);
  // 超大底图限制总格数。
  const huge = explorationGrid({ grid: square("equal"), width: 20000, height: 20000 });
  assert.ok(huge.columns * huge.rows <= 512 * 512 + 2 * 512 + 1);
});
