import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createTestModule } from "@jointarp/module/testing/test-module";

import type { ChatMessage } from "../../shared/game";
import { moveToken, readMap, seatPartyAtStart, updateMap } from "./map-commands";
import { mapPositionPrompt, movementPrompt } from "./map-description";
import { prepareMovement } from "./map-intent";
import { readMapState } from "./map-state";
import { updateAdventure } from "./room-storage";
import { createSession, openSessionDatabase } from "./session-store";

const player = "8d03c680-4f8d-4d9e-ae52-6f95eaee7232";

async function room() {
  const f = await createTestModule();
  onTestFinished(f.cleanup);
  const created = await createSession(f.sessions, f.modulePath, "地图命令");
  updateAdventure(join(f.sessions, created.id), (adventure) => {
    adventure.party.characters.find(
      (character) => character.sourcePath === "角色/旅人.json",
    )!.playerId = player;
    return adventure;
  });
  const db = await openSessionDatabase(f.sessions, created.id);
  onTestFinished(() => db.close());
  return { db, roomId: created.id };
}

test("单起点地图在入队时把队伍角色放到起点", async () => {
  const { db } = await room();
  await seatPartyAtStart(db);
  const state = readMapState(db);
  assert.equal(state.maps["测试场景"]!.known, true);
  assert.deepEqual(state.tokens["角色/旅人"]?.at, [150, 250]);
  const at = state.tokens["角色/旅人"]!.at;
  await seatPartyAtStart(db);
  assert.deepEqual(readMapState(db).tokens["角色/旅人"]?.at, at);
});

test("主持放置队伍角色后地图对玩家可见，读取结果包含区域、门、标记与探索比例", async () => {
  const { db } = await room();
  const placed = await updateMap(db, {
    action: "place",
    map: "测试场景",
    document: "角色/旅人.json",
    at: { start: "入口" },
  });
  assert.deepEqual(placed, {
    token: "角色/旅人",
    map: "测试场景",
    at: [7.5, 12.5],
    regions: ["西室"],
  });
  assert.equal(readMapState(db).maps["测试场景"]!.known, true);
  await assert.rejects(
    updateMap(db, {
      action: "place",
      map: "测试场景",
      document: "不存在/文档",
      at: { x: 1, y: 1 },
    }),
    /文档不存在/,
  );

  const map = readMap(db, "测试场景") as ReturnType<typeof readMap> & Record<string, any>;
  assert.deepEqual(map.scale, { grid: "square", cell: 5, unit: "尺", diagonal: "equal" });
  assert.equal(map.regions.find((region: any) => region.id === "西室").explored, 1);
  assert.equal(map.regions.find((region: any) => region.id === "东室").explored, 0);
  assert.deepEqual(map.doors.find((door: any) => door.id === "中门").between.sort(), [
    "东室",
    "西室",
  ]);
  assert.deepEqual(map.doors.find((door: any) => door.id === "暗门").revealed, false);
  assert.equal(map.tokens.find((token: any) => token.id === "守望者").visible, false);
  assert.equal(map.tokens.find((token: any) => token.id === "角色/旅人").party, true);

  const line = mapPositionPrompt(db);
  assert.match(line, /旅人\[角色\/旅人\] 西室 \(7\.5, 12\.5\)/);
  assert.match(line, /守望者\[守望者\] 东室 \(32\.5, 12\.5\) 视野外/);

  await assert.rejects(
    updateMap(db, { action: "reveal", map: "测试场景", door: "中门" }),
    /不是秘门/,
  );
  await updateMap(db, { action: "door", map: "测试场景", door: "暗门", open: true });
  assert.deepEqual(readMapState(db).maps["测试场景"]!.doors["暗门"], {
    open: true,
    revealed: true,
  });
});

test("移动意图只允许本人角色且不能穿墙，主持说明标注区域、门与终点重叠，执行时停在关闭的门前", async () => {
  const { db, roomId } = await room();
  await updateMap(db, {
    action: "place",
    map: "测试场景",
    document: "角色/旅人",
    at: { start: "入口" },
  });
  const input = {
    token: "角色/旅人",
    map: "测试场景",
    waypoints: [[650, 250]] as [number, number][],
  };
  assert.throws(() => prepareMovement(db, randomUUID(), input), /自己的角色/);
  assert.throws(
    () => prepareMovement(db, player, { ...input, waypoints: [[650, 450]] }),
    /不能穿过墙/,
  );
  assert.throws(
    () => prepareMovement(db, player, { ...input, waypoints: [[900, 450]] }),
    /不能穿过墙/,
  );
  const intent = prepareMovement(db, player, input);
  assert.deepEqual(
    { from: intent.from, length: intent.length, explore: intent.explore, unit: intent.unit },
    { from: [150, 250], length: null, explore: true, unit: "尺" },
  );

  const messageId = randomUUID();
  const message: ChatMessage = {
    id: messageId,
    sequence: 1,
    roomId,
    senderId: player,
    nickname: "玩家",
    createdAt: new Date().toISOString(),
    status: "complete",
    revision: 0,
    kind: "player",
    text: "去看看守望者",
    chatOnly: false,
    movement: intent,
  };
  db.run(
    db.query.insertInto("chat_messages").values({ id: messageId, data: JSON.stringify(message) }),
  );
  const prompt = movementPrompt(db, messageId, intent);
  assert.match(prompt, /经过门 中门（关）/);
  assert.match(prompt, /进入东室/);
  assert.match(prompt, /终点与 守望者\[守望者\] 重叠/);
  assert.match(prompt, /终点在未探索区域/);
  assert.match(prompt, new RegExp(`intent: "${messageId}"`));

  const stopped = await moveToken(db, { intent: messageId });
  assert.equal(stopped.stoppedBy, "门 中门 关闭");
  assert.deepEqual(stopped.at, [22.5, 12.5]);
  assert.equal(readMapState(db).intents[messageId]?.progress, stopped.moved);

  await updateMap(db, { action: "door", map: "测试场景", door: "中门", open: true });
  const moved = await moveToken(db, { token: "角色/旅人", to: { near: "守望者", side: "west" } });
  assert.deepEqual(moved.at, [27.5, 12.5]);
  assert.deepEqual(moved.regions, ["东室"]);
  await assert.rejects(moveToken(db, { token: "角色/旅人", to: { region: "暗室" } }), /无法到达/);
});
