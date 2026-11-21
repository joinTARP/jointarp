import { expect, test } from "bun:test";

import { createExploration, explorationGrid, markExplored } from "@jointarp/module/map-geometry";

import { paintExploration } from "./map-fog";

test("探索遮罩不覆盖相邻未知格，并裁掉底图之外的末行末列", () => {
  const bounds = { width: 105, height: 65 };
  const grid = explorationGrid({
    ...bounds,
    grid: { type: "square", size: 40, distance: 1, unit: "米", diagonal: "equal", offset: [0, 0] },
  });
  const bits = createExploration(grid);
  markExplored(bits, grid, [
    [0, 0],
    [40, 0],
    [40, 40],
    [0, 40],
  ]);
  markExplored(bits, grid, [
    [80, 40],
    [120, 40],
    [120, 80],
    [80, 80],
  ]);
  const rectangles: number[][] = [];
  paintExploration(
    {
      fillRect: (...args) => {
        rectangles.push(args);
      },
    },
    bits,
    grid,
    bounds,
  );
  const painted = (x: number, y: number) =>
    rectangles.some(
      ([left, top, width, height]) =>
        x >= left! && x < left! + width! && y >= top! && y < top! + height!,
    );
  expect(painted(39.99, 10)).toBe(true);
  expect(painted(40.01, 10)).toBe(false);
  expect(painted(79.99, 50)).toBe(false);
  expect(painted(104.99, 64.99)).toBe(true);
  expect(painted(105.01, 50)).toBe(false);
  expect(painted(90, 65.01)).toBe(false);
});
