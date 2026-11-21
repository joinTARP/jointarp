import { expect, test } from "bun:test";

import { mapConfigSchema } from "@jointarp/module/map";
import { pointInPolygon } from "@jointarp/module/map-geometry";

import { previewSight } from "./map-inspector-sight";

test("校对视点在关闭的门前停住，重新读取开启状态后能看过门", () => {
  const map = mapConfigSchema.parse({
    name: "校对测试",
    image: "test.png",
    width: 100,
    height: 100,
    grid: { type: "none", pixelsPerUnit: 1, unit: "米" },
    doors: [{ id: "门", from: [50, 0], to: [50, 100] }],
  });
  expect(pointInPolygon([75, 50], previewSight(map, [25, 50]))).toBe(false);
  map.doors[0]!.open = true;
  expect(pointInPolygon([75, 50], previewSight(map, [25, 50]))).toBe(true);
});
