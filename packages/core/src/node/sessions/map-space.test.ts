import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";

import {
  explorationGrid,
  isExplored,
  decodeExploration,
  pointInPolygon,
} from "@jointarp/module/map-geometry";
import { loadModuleMaps } from "@jointarp/module/node/module-maps";
import { createTestModule } from "@jointarp/module/testing/test-module";

import { mapResources, projectMapSection } from "./map-projection";
import { analyzeRoute, exploreAlong, findPath, resolveAnchor } from "./map-space";
import { initialMapState, readMapState, reconcileMapState, type MapState } from "./map-state";
import { createSession, openSessionDatabase } from "./session-store";

const party = new Map([["角色/旅人", "玩家甲"]]);

async function scene() {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const [map] = await loadModuleMaps(f.modulePath);
  assert.equal(map!.id, "测试场景");
  const state = initialMapState([map!]);
  state.tokens["旅人"] = {
    map: map!.id,
    at: [150, 250],
    size: 1,
    document: "角色/旅人",
    hidden: false,
    blocksVision: false,
    blocksMovement: false,
  };
  return { f, map: map!, state, room: state.maps[map!.id]! };
}

test("创建冒险时按模组地图初始化房间地图状态，玩家资源不含区域、起点与标记", async () => {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const room = await createSession(f.sessions, f.modulePath, "地图状态");
  const db = await openSessionDatabase(f.sessions, room.id);
  onTestFinished(() => db.close());
  const state = readMapState(db);
  assert.deepEqual(state.maps["测试场景"], {
    known: false,
    explored: "",
    doors: { 中门: { open: false, revealed: true }, 暗门: { open: false, revealed: false } },
  });
  assert.equal(state.tokens["守望者"]?.document, "人物/守望者");
  const [resource] = mapResources(await loadModuleMaps(join(f.sessions, room.id, "module")));
  assert.deepEqual(Object.keys(resource!).sort(), [
    "description",
    "grid",
    "height",
    "id",
    "image",
    "name",
    "path",
    "walls",
    "width",
  ]);
});

test("投影只包含已知地图、全队视野内的标记，并把未揭示的秘门当作墙", async () => {
  const { map, state, room } = await scene();
  assert.deepEqual(projectMapSection([map], state, party).maps, []);
  room.known = true;
  let [view] = projectMapSection([map], state, party).maps;
  assert.deepEqual(view!.tokens.map((token) => token.id).sort(), ["旅人", "木箱"]);
  assert.equal(view!.tokens.find((token) => token.id === "旅人")?.playerId, "玩家甲");
  assert.deepEqual(
    view!.doors.map((door) => door.id),
    ["中门"],
  );
  assert.deepEqual(view!.barriers, [
    [
      [800, 400],
      [800, 500],
    ],
  ]);

  room.doors["中门"]!.open = true;
  [view] = projectMapSection([map], state, party).maps;
  assert.ok(view!.tokens.some((token) => token.id === "守望者"));
  state.tokens["守望者"]!.hidden = true;
  [view] = projectMapSection([map], state, party).maps;
  assert.ok(!view!.tokens.some((token) => token.id === "守望者"));

  // 遮挡视线的物件挡住其后方标记。
  state.tokens["木箱"]!.blocksVision = true;
  state.tokens["旅人"]!.at = [50, 150];
  state.tokens["哨兵"] = {
    ...state.tokens["木箱"]!,
    at: [450, 150],
    label: "哨兵",
    blocksVision: false,
  };
  [view] = projectMapSection([map], state, party).maps;
  assert.ok(!view!.tokens.some((token) => token.id === "哨兵"));
  assert.ok(view!.tokens.some((token) => token.id === "木箱"));
});

test("寻路绕开墙与关闭的门，路线分析给出区域、门、未探索区域与经过的标记", async () => {
  const { map, state, room } = await scene();
  assert.equal(findPath(map, room, [150, 250], [650, 250]), undefined);
  room.doors["中门"]!.open = true;
  const path = findPath(map, room, [150, 100], [650, 500])!;
  assert.ok(path.length >= 3);
  assert.deepEqual(path.at(-1), [650, 500]);

  room.doors["中门"]!.open = false;
  exploreAlong(map, state, party, "旅人", [[150, 250]]);
  const route = analyzeRoute(map, state, "旅人", [
    [150, 250],
    [650, 250],
  ]);
  assert.equal(route.length, 25);
  assert.deepEqual(route.events.map((event) => event.kind).sort(), [
    "door",
    "enter",
    "leave",
    "unexplored",
  ]);
  const door = route.events.find((event) => event.kind === "door");
  assert.equal(door?.kind === "door" && door.open, false);
  assert.deepEqual(
    route.endRegions.map((region) => region.id),
    ["东室"],
  );
  assert.deepEqual(route.endOverlap, ["守望者"]);

  const throughWall = analyzeRoute(map, state, "旅人", [
    [150, 100],
    [650, 100],
  ]);
  assert.deepEqual(throughWall.events.map((event) => event.kind).sort(), [
    "blocked",
    "enter",
    "leave",
    "obstacle",
    "unexplored",
  ]);
});

test("模组同步保留已有地图状态，新地图按初始配置加入，拒绝删除仍有标记的文档", async () => {
  const { map, state, room } = await scene();
  room.known = true;
  room.doors["中门"]!.open = true;
  exploreAlong(map, state, party, "旅人", [[150, 250]]);
  delete state.tokens["木箱"];
  const changed = {
    ...map,
    config: {
      ...map.config,
      width: 900,
      doors: map.config.doors.filter((door) => door.id !== "暗门"),
    },
  };
  const added = { ...map, id: "新场景", config: { ...map.config, tokens: [] } };
  const documents = new Set(["角色/旅人", "人物/守望者"]);
  const next = reconcileMapState(state, [changed, added], documents);
  assert.equal(next.maps["测试场景"]!.known, true);
  assert.deepEqual(next.maps["测试场景"]!.doors, { 中门: { open: true, revealed: true } });
  // 底图尺寸改变后旧探索记录失效。
  assert.equal(next.maps["测试场景"]!.explored, "");
  assert.deepEqual(next.maps["新场景"]!.known, false);
  assert.ok(!next.tokens["木箱"]);
  assert.ok(next.tokens["旅人"]);
  assert.throws(() => reconcileMapState(state, [changed], new Set(["角色/旅人"])), /人物\/守望者/);
});

test("位置锚点解析为格心，沿路线揭示探索记录", async () => {
  const { map, state, room } = await scene();
  assert.deepEqual(resolveAnchor(map, room, state, { start: "西侧入口" }, 1), [150, 250]);
  assert.deepEqual(
    resolveAnchor(map, room, state, { region: "东室", side: "north" }, 1),
    [650, 50],
  );
  assert.deepEqual(
    resolveAnchor(map, room, state, { near: "守望者", side: "west" }, 1),
    [550, 250],
  );
  assert.deepEqual(resolveAnchor(map, room, state, { point: [12, 3] }, 1), [250, 50]);
  assert.throws(() => resolveAnchor(map, room, state, { region: "不存在" }, 1), /没有区域/);
  const bent = structuredClone(map);
  bent.config.regions.push({
    id: "拐角",
    secret: false,
    points: [
      [0, 0],
      [1000, 0],
      [1000, 100],
      [100, 100],
      [100, 600],
      [0, 600],
    ],
  });
  const corner = resolveAnchor(bent, room, state, { region: "拐角" }, 1);
  assert.ok(pointInPolygon(corner, bent.config.regions.at(-1)!.points));

  const before: MapState = structuredClone(state);
  exploreAlong(map, state, party, "旅人", [
    [150, 250],
    [350, 250],
  ]);
  assert.notEqual(state.maps[map.id]!.explored, before.maps[map.id]!.explored);
  const bits = decodeExploration(state.maps[map.id]!.explored, explorationGrid(map.config));
  assert.ok(isExplored(bits, explorationGrid(map.config), [450, 550]));
  assert.ok(!isExplored(bits, explorationGrid(map.config), [650, 250]));
});
