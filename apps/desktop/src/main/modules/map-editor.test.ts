import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openMapEdit, saveMapEdit } from "./map-editor";
for (const ext of ["json", "toml"])
  test(ext + " 地图只改指定坐标并拒绝覆盖外部修改", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-edit-"));
    try {
      const path = "maps/test." + ext,
        file = join(root, path);
      const source =
        ext === "json"
          ? '{"name":"测试","width":100,"height":100,"image":"a.png","grid":{"type":"none","unit":"米","pixelsPerUnit":1},"walls":[{"points":[[1,2], [3, 4], [5,6]]}],"doors":[{"id":"门","from":[1,2],"to":[3, 4]}]}'
          : 'name="测试"\nwidth=100\nheight=100\nimage="a.png"\ngrid={type="none",unit="米",pixelsPerUnit=1}\n[[walls]]\npoints=[[1,2], [3, 4], [5,6]] # 墙\n[[doors]]\nid="门"\nfrom=[1,2]\nto=[3, 4] # 门\n';
      await mkdir(join(root, "maps"));
      await writeFile(file, source);
      const { revision } = openMapEdit(root, path);
      saveMapEdit(root, path, revision, [
        { layer: "walls", index: 0, vertex: 1, at: [8, 9] },
        { layer: "doors", index: 0, vertex: 1, at: [8, 9] },
      ]);
      expect(await readFile(file, "utf8")).toBe(source.replaceAll("3, 4", "8, 9"));
      const reopened = openMapEdit(root, path);
      expect(reopened.config.doors[0].to).toEqual([8, 9]);
      await writeFile(file, source + "\n");
      expect(() => saveMapEdit(root, path, reopened.revision, [])).toThrow("外部修改");
      expect(await readFile(file, "utf8")).toBe(source + "\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

import { firstBlocked, pointInPolygon, wallSegments } from "@jointarp/module/map-geometry";

import { previewSight } from "../../renderer/src/features/modules/map-inspector-sight";
for (const ext of ["toml", "json"])
  test(ext + " 空地图建两室，切门保存后开门通行并恢复视线", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-room-"));
    try {
      const path = "maps/test." + ext,
        file = join(root, path);
      await mkdir(join(root, "maps"));
      await writeFile(
        file,
        ext === "toml"
          ? 'name="两室"\nwidth=100\nheight=100\nimage="a.png"\ngrid={type="none",unit="米",pixelsPerUnit=1}\n# 保留说明\n'
          : JSON.stringify({
              name: "两室",
              width: 100,
              height: 100,
              image: "a.png",
              grid: { type: "none", unit: "米", pixelsPerUnit: 1 },
            }),
      );
      saveMapEdit(root, path, openMapEdit(root, path).revision, [
        {
          kind: "wall",
          points: [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
            [0, 0],
          ],
        },
        {
          kind: "wall",
          points: [
            [50, 0],
            [50, 100],
          ],
        },
        { kind: "door", wall: 1, segment: 0, start: 0.4, end: 0.6 },
      ]);
      const { config, revision } = openMapEdit(root, path);
      const door = config.doors[0];
      expect(config.walls.length).toBe(3);
      const route = [
        [25, 50],
        [75, 50],
      ] as const;
      for (const open of [false, true]) {
        door.open = open;
        const blockers = wallSegments(config);
        if (!open) blockers.push({ a: door.from, b: door.to });
        expect(!!firstBlocked(route, blockers)).toBe(!open);
        expect(pointInPolygon(route[1], previewSight(config, [25, 50]))).toBe(open);
      }
      saveMapEdit(root, path, revision, [
        { kind: "delete", layer: "doors", index: 0 },
        { kind: "delete", layer: "walls", index: 2 },
      ]);
      expect(openMapEdit(root, path).config.doors).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const ext of ["json", "toml"])
  test(ext + " 设置及移除上级，拒绝保存循环", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-parent-"));
    try {
      const path = "maps/旅馆." + ext;
      const town = "maps/城镇.JSON";
      const config = {
        name: "旅馆",
        width: 100,
        height: 100,
        image: "a.png",
        grid: { type: "none", unit: "米", pixelsPerUnit: 1 },
      };
      await mkdir(join(root, "maps"));
      await writeFile(join(root, town), JSON.stringify(config));
      await writeFile(
        join(root, path),
        ext === "json"
          ? JSON.stringify(config)
          : 'name="旅馆"\nwidth=100\nheight=100\nimage="a.png"\n[grid]\ntype="none"\nunit="米"\npixelsPerUnit=1\n',
      );
      const parent = (file: string, value: string | null) =>
        saveMapEdit(root, file, openMapEdit(root, file).revision, [
          { kind: "parent", parent: value },
        ]);
      parent(path, "城镇");
      expect(openMapEdit(root, path).config.parent).toBe("城镇");
      expect(() => parent(town, "旅馆")).toThrow("循环");
      expect(() => parent(path, "缺失")).toThrow("不存在");
      parent(path, null);
      expect(openMapEdit(root, path).config.parent).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const ext of ["json", "toml"])
  test(ext + " 画布新增起点并配对，重新加载、取消配对和目标缺失", async () => {
    const root = await mkdtemp(join(tmpdir(), "map-links-"));
    try {
      await mkdir(join(root, "maps"));
      const file = "maps/楼上." + ext;
      const base = {
        name: "测试",
        image: "a.png",
        width: 100,
        height: 100,
        grid: { type: "none", pixelsPerUnit: 1, unit: "米" },
      };
      const target = "maps/楼下.json";
      await writeFile(
        join(root, file),
        ext === "toml"
          ? 'name="测试"\nimage="a.png"\nwidth=100\nheight=100\n[grid]\ntype="none"\npixelsPerUnit=1\nunit="米"\n'
          : JSON.stringify(base),
      );
      await writeFile(
        join(root, target),
        JSON.stringify({ ...base, starts: [{ id: "楼梯", name: "楼梯", at: [10, 20] }] }),
      );
      const link = { from: "东楼梯", map: "楼下", to: "楼梯", oneWay: false };
      saveMapEdit(root, file, openMapEdit(root, file).revision, [
        { kind: "start", start: { id: "东楼梯", name: "东楼梯", at: [30, 40] } },
        { kind: "connect", link },
      ]);
      const saved = openMapEdit(root, file);
      expect(saved.config.connections).toEqual([link]);
      expect(() =>
        saveMapEdit(root, file, saved.revision, [
          { kind: "connect", link: { ...link, to: "不存在" } },
        ]),
      ).toThrow("目标地图或起点");
      expect(openMapEdit(root, file).revision).toBe(saved.revision);
      saveMapEdit(root, file, saved.revision, [{ kind: "disconnect", index: 0 }]);
      expect(openMapEdit(root, file).config.connections).toEqual([]);
      expect(openMapEdit(root, file).config.starts[0].at).toEqual([30, 40]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
