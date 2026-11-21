import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { waitFor } from "@jointarp/module/testing/async";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createTestModule } from "@jointarp/module/testing/test-module";

import { updateMap } from "../sessions/map-commands";
import { updateAdventure } from "../sessions/room-storage";
import { createSession, openSessionDatabase } from "../sessions/session-store";
import { ChatService } from "./chat-service";

test("行动消息可只携带移动意图卡，主持输入附带幕后路线说明，聊天消息不能携带意图", async () => {
  const data = await createTestModule();
  const path = join(data.modulePath, "module.json");
  const {
    gameStarts: _starts,
    preludeFlow: _prelude,
    ...module
  } = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify(module));
  const room = await createSession(data.sessions, data.modulePath, "地图行动");
  const player = { id: randomUUID(), nickname: "玩家" };
  updateAdventure(join(data.sessions, room.id), (adventure) => {
    adventure.party.characters.find(
      (character) => character.sourcePath === "角色/旅人.json",
    )!.playerId = player.id;
    return adventure;
  });
  const db = await openSessionDatabase(data.sessions, room.id);
  await updateMap(db, {
    action: "place",
    map: "测试场景",
    document: "角色/旅人",
    at: { start: "入口" },
  });
  const prompts: string[] = [];
  const chat = new ChatService(
    data.sessions,
    { run: async (args) => void prompts.push(args.text) },
    async () => ({ config: { provider: "test", model: "test" } }),
  );
  onTestFinished(async () => {
    await chat.close();
    db.close();
    await data.cleanup();
  });
  const movement = {
    token: "角色/旅人",
    map: "测试场景",
    waypoints: [[350, 250]] as [number, number][],
  };

  await assert.rejects(
    chat.send(
      {
        roomId: room.id,
        clientMessageId: randomUUID(),
        text: "随便聊聊",
        chatOnly: true,
        movement,
      },
      player,
    ),
    /只能随行动消息提交/,
  );
  await assert.rejects(
    chat.send(
      {
        roomId: room.id,
        clientMessageId: randomUUID(),
        text: "",
        chatOnly: false,
        movement: { ...movement, token: "守望者" },
      },
      player,
    ),
    /自己的角色/,
  );
  const sent = await chat.send(
    { roomId: room.id, clientMessageId: randomUUID(), text: "", chatOnly: false, movement },
    player,
  );
  assert.equal(sent.kind === "player" && sent.movement?.length, 10);
  await waitFor(() => assert.equal(prompts.length, 1));
  assert.match(prompts[0]!, /<movement>移动意图（旅人\[角色\/旅人\]/);
  assert.match(prompts[0]!, new RegExp(`intent: "${sent.id}"`));
  assert.match(prompts[0]!, /地图位置（幕后/);

  const projection = await chat.roomProjection(room.id, player);
  const [view] = projection.sections.map.maps;
  assert.equal(view?.id, "测试场景");
  assert.ok(view.tokens.some((token) => token.id === "角色/旅人" && token.playerId === player.id));
  assert.ok(!view.tokens.some((token) => token.id === "守望者"));
});
