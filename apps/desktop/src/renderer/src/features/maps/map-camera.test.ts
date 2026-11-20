import { expect, test } from "bun:test";

import { cameraFromTransform, cameraTransform, zoomCamera } from "./map-camera";
import { mapUi } from "./map-ui";

test("缩放保持指针下的位置不动，并限制最小和最大缩放", () => {
  const camera = { x: -100, y: 30, scale: 2 };
  const anchor = { x: 240, y: 160 };
  for (const factor of [1.15, 0.001, 1000]) {
    const next = zoomCamera(camera, factor, 1, anchor);
    expect((anchor.x - next.x) / next.scale).toBeCloseTo((anchor.x - camera.x) / camera.scale);
    expect((anchor.y - next.y) / next.scale).toBeCloseTo((anchor.y - camera.y) / camera.scale);
    expect(next.scale).toBeGreaterThanOrEqual(0.6);
    expect(next.scale).toBeLessThanOrEqual(12);
  }
});

test("切图和关闭后保留各自视角与行动草稿，窗口变化保留观察中心", () => {
  const room = "map-camera-test";
  const first = cameraFromTransform({ x: -120, y: 40, scale: 2 }, { width: 800, height: 600 });
  const second = { center: [40, 80] as [number, number], scale: 1 };
  const plan = { map: "first", token: "hero", waypoints: [[100, 100] as [number, number]] };
  mapUi.update(room, (state) => ({ ...state, cameras: { first, second } }));
  mapUi.setPlan(room, plan);
  mapUi.open(room, { mapId: "second", planning: true });
  mapUi.close(room);
  mapUi.open(room, { mapId: "first" });
  expect(mapUi.get(room).plan).toEqual(plan);
  expect(mapUi.get(room).cameras.second).toEqual(second);
  mapUi.open(room, { mapId: "second", center: [70, 90] });
  expect(mapUi.get(room).cameras.second).toEqual({ ...second, center: [70, 90] });
  const size = { width: 1000, height: 500 };
  const restored = cameraTransform(mapUi.get(room).cameras.first!, size);
  expect(cameraFromTransform(restored, size)).toEqual(first);
  expect(restored).toEqual({ x: -20, y: -10, scale: 2 });
});
