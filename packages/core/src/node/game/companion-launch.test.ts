import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { waitFor } from "@jointarp/module/testing/async";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createTestModule } from "@jointarp/module/testing/test-module";

import type { LaunchAction } from "../../shared/launch";
import { advanceLaunch, launchState } from "../sessions/launch-store";
import { createSession, openSessionDatabase } from "../sessions/session-store";
import { ChatService } from "./chat-service";
import type { Runtime } from "./chat/types";
import { companionContext } from "./companion";

async function fixture(
  options: { presets?: "none" | "self"; aiOpening?: boolean; onRun?: Runtime["run"] } = {},
) {
  const data = await createTestModule();
  const path = join(data.modulePath, "module.json");
  const module = JSON.parse(await readFile(path, "utf8"));
  const start = module.gameStarts[0];
  if (options.presets === "none") delete start.aiCompanions;
  if (options.presets === "self") start.aiCompanions = { "角色/向导": "扮演向导。" };
  if (options.aiOpening) start.opening = { mode: "ai", prompt: "介绍已确认的小队。" };
  await writeFile(path, JSON.stringify(module));
  const room = await createSession(data.sessions, data.modulePath, "开局组队测试");
  const player = { id: randomUUID(), nickname: "玩家" };
  let credentialCalls = 0;
  const prompts: string[] = [];
  const chat = new ChatService(
    data.sessions,
    {
      run: async (args) => {
        prompts.push(args.text);
        await options.onRun?.(args);
      },
    },
    async () => {
      credentialCalls++;
      return { config: { provider: "test", model: "test" } };
    },
  );
  const state = (playerId = player.id) => launchState(data.sessions, room.id, playerId);
  const act = async (action: LaunchAction["action"], extra = {}, playerId = player.id) => {
    const latest = (await state(playerId))!;
    return advanceLaunch(
      data.sessions,
      {
        roomId: room.id,
        revision: latest.progress.revision,
        roomRevision: latest.room.revision,
        action,
        ...extra,
      },
      playerId,
    );
  };
  const history = () => chat.history({ roomId: room.id, limit: 100 }, player);
  const initial = await history();
  const initialCompanionVersion = (await chat.roomProjection(room.id, player)).sections
    .companionVersion;
  const initialCompanionSettings = await chat.companionSettings(room.id);
  const ready = initial.messages.find(
    (message) => message.kind === "card" && message.card.type === "ready",
  )!;
  await chat.confirmReady(room.id, player, ready.id);
  const characters = (await state())!.characters;
  const confirm = async () => {
    await act("select", {
      characterId: characters.find((character) => character.name === "向导")!.id,
    });
    await act("confirm");
    return history();
  };
  const recruit = async (name: string) => {
    const character = characters.find((item) => item.name === name)!;
    const selected = await chat.selectCompanion(room.id, character.id);
    const seat = selected.seats.find((item) => item.reservedCharacterId === character.id)!;
    const settings = await chat.saveCompanion(
      room.id,
      seat.id,
      { characterId: character.id },
      player,
    );
    return settings.seats.find((item) => item.id === seat.id)!.companion!;
  };
  return {
    ...data,
    room,
    player,
    chat,
    state,
    act,
    history,
    characters,
    confirm,
    recruit,
    prompts,
    credentials: () => credentialCalls,
    initialCompanionVersion,
    initialCompanionSettings,
    async close() {
      await chat.close();
      await data.cleanup();
    },
  };
}

test("确认角色后只出现一次队友提示，重开保持等待，独自开始后才播放开场", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.initialCompanionSettings.characters, []);
    const beforeConfirm = (await f.chat.roomProjection(f.room.id, f.player)).sections
      .companionVersion;
    assert.notEqual(beforeConfirm, f.initialCompanionVersion, "选定开局后使早期空队友缓存失效");
    const before = await f.chat.companionSettings(f.room.id);
    assert.ok(before.characters.some((character) => character.name === "向导"));
    const first = await f.confirm();
    assert.notEqual(
      (await f.chat.roomProjection(f.room.id, f.player)).sections.companionVersion,
      beforeConfirm,
      "真人确认角色后使旧的可选队友缓存失效",
    );
    const available = (await f.chat.companionSettings(f.room.id)).characters.filter(
      (character) =>
        character.playable &&
        character.aiConfigured &&
        !character.controllerId &&
        !character.reservedBy,
    );
    assert.deepEqual(
      available.map((character) => character.name).sort(),
      ["学者", "工匠", "旅人"].sort(),
    );
    const character = first.messages.find(
      (message) => message.kind === "card" && message.card.type === "character",
    )!;
    const prompt = first.messages.find(
      (message) => message.kind === "card" && message.card.type === "companions",
    )!;
    assert.equal(character.status, "complete");
    assert.ok(prompt.sequence > character.sequence);
    assert.equal(prompt.status, "running");
    assert.ok(
      prompt.kind === "card" && prompt.card.type === "companions" && prompt.card.stage === "prompt",
    );
    assert.equal((await f.state())!.room.opening, "pending");
    assert.ok(
      !first.messages.some(
        (message) => message.kind === "scripted" && message.postKey?.startsWith("opening:"),
      ),
    );
    await assert.rejects(f.chat.openLaunch(f.room.id, f.player), /先完成 AI 队友选择/);
    assert.equal(f.credentials(), 0);

    await f.chat.closeRoom(f.room.id);
    const reopened = await f.history();
    assert.deepEqual(
      reopened.messages.map((message) => message.id),
      first.messages.map((message) => message.id),
    );
    await f.act("beginAdventure");
    const done = await f.history();
    assert.equal((await f.state())!.room.opening, "complete");
    assert.ok(
      done.messages.some(
        (message) => message.kind === "scripted" && message.postKey === "opening:arrival:0:0",
      ),
    );
    const settled = done.messages.find((message) => message.id === prompt.id)!;
    assert.equal(settled.status, "complete");
    assert.ok(
      settled.kind === "card" &&
        settled.card.type === "companions" &&
        settled.card.selected?.length === 0,
    );
    await f.act("beginAdventure");
    assert.deepEqual((await f.history()).messages, done.messages);
  } finally {
    await f.close();
  }
});

test("可添加多名队友，重开恢复选择，开场包含确认后的小队", async () => {
  const f = await fixture();
  try {
    await f.confirm();
    await f.act("chooseCompanions");
    await f.history();
    const first = await f.recruit("工匠");
    const second = await f.recruit("学者");
    assert.equal((await f.state())!.room.opening, "pending");
    await f.chat.closeRoom(f.room.id);
    const reopened = await f.history();
    const prompt = reopened.messages.find(
      (message) => message.kind === "card" && message.card.type === "companions",
    );
    assert.ok(
      prompt?.kind === "card" &&
        prompt.card.type === "companions" &&
        prompt.card.stage === "select",
    );
    assert.equal(
      (await f.chat.companionSettings(f.room.id)).seats.filter((seat) => seat.companion).length,
      2,
    );
    await f.act("beginAdventure");
    const done = await f.history();
    const opening = done.messages.find(
      (message) => message.kind === "scripted" && message.postKey?.startsWith("opening:"),
    )!;
    assert.ok(first.joinedSequence < opening.sequence && second.joinedSequence < opening.sequence);
    const settled = done.messages.find((message) => message.id === prompt!.id)!;
    assert.ok(settled.kind === "card" && settled.card.type === "companions");
    assert.deepEqual(
      settled.card.selected?.map((character) => character.name).sort(),
      ["学者", "工匠"].sort(),
    );
    const db = await openSessionDatabase(f.sessions, f.room.id);
    try {
      const context = JSON.parse(await companionContext(db, first));
      assert.ok(
        context.events.some((event: { text: string }) => event.text === "脚本开场测试文本。"),
      );
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

for (const presets of ["none", "self"] as const)
  test(`没有剩余可由 AI 扮演的角色时直接开场（${presets}）`, async () => {
    const f = await fixture({ presets });
    try {
      const history = await f.confirm();
      assert.equal((await f.state())!.room.opening, "complete");
      assert.ok(
        !history.messages.some(
          (message) => message.kind === "card" && message.card.type === "companions",
        ),
      );
    } finally {
      await f.close();
    }
  });

test("队友确认前不调用开场模型，正式开场输入包含已加入的 AI 角色", async () => {
  const f = await fixture({ aiOpening: true });
  try {
    await f.confirm();
    await f.act("chooseCompanions");
    const companion = await f.recruit("工匠");
    await f.history();
    assert.equal(f.credentials(), 0);
    assert.equal(f.prompts.length, 0);
    await f.act("beginAdventure");
    await f.history();
    await waitFor(() => assert.ok(f.prompts[0]?.includes(companion.characterId)));
    assert.equal(f.credentials(), 1);
    assert.ok(f.prompts[0]?.includes(f.player.id));
  } finally {
    await f.close();
  }
});

test("只有首次选角的玩家能确认小队，其他玩家的选角不重复提示", async () => {
  const f = await fixture();
  const other = randomUUID();
  try {
    await f.confirm();
    await assert.rejects(f.act("beginAdventure", {}, other), /不能选择开局队友/);
    await f.chat.history({ roomId: f.room.id, limit: 100 }, { id: other, nickname: "其他玩家" });
    await f.act(
      "select",
      { characterId: f.characters.find((character) => character.name === "旅人")!.id },
      other,
    );
    await f.act("confirm", {}, other);
    const history = await f.chat.history(
      { roomId: f.room.id, limit: 100 },
      { id: other, nickname: "其他玩家" },
    );
    assert.equal(
      history.messages.filter(
        (message) => message.kind === "card" && message.card.type === "companions",
      ).length,
      1,
    );
    assert.equal((await f.state())!.room.companionSetup?.playerId, f.player.id);
    assert.equal((await f.state())!.room.opening, "pending");
    await assert.rejects(
      f.chat.openLaunch(f.room.id, { id: other, nickname: "其他玩家" }),
      /先完成 AI 队友选择/,
    );
  } finally {
    await f.close();
  }
});

test("开始冒险拒绝过期进度和未完成的队友预留，取消后可以继续", async () => {
  const f = await fixture();
  try {
    await f.confirm();
    const stale = (await f.state())!;
    await f.act("chooseCompanions");
    await assert.rejects(
      advanceLaunch(
        f.sessions,
        {
          roomId: f.room.id,
          revision: stale.progress.revision,
          roomRevision: stale.room.revision,
          action: "beginAdventure",
        },
        f.player.id,
      ),
      /已变化/,
    );
    const characterId = f.characters.find((character) => character.name === "学者")!.id;
    const selected = await f.chat.selectCompanion(f.room.id, characterId);
    const seat = selected.seats.find((item) => item.reservedCharacterId === characterId)!;
    await assert.rejects(f.act("beginAdventure"), /完成或取消待入队/);
    await f.chat.saveCompanion(f.room.id, seat.id, null, f.player);
    await f.act("beginAdventure");
    await f.history();
    assert.equal((await f.state())!.room.opening, "complete");
  } finally {
    await f.close();
  }
});

test("无 AI 预设的离线成员可接力，接回及移除保持正确角色归属", async () => {
  const f = await fixture({ presets: "none" });
  try {
    await f.chat.registerMember(f.room.id, f.player);
    await assert.rejects(f.chat.setMemberRelay(f.room.id, f.player.id, true), /尚未选择角色/);
    await f.confirm();
    const characterId = (await f.state())!.progress.characterId;
    await f.chat.setMemberRelay(f.room.id, f.player.id, true);
    let settings = await f.chat.companionSettings(f.room.id);
    assert.equal(settings.members.find((member) => member.id === f.player.id)?.relay, true);
    assert.equal(
      settings.seats.find((seat) => seat.id === f.player.id)?.companion?.characterId,
      characterId,
    );
    assert.equal(
      settings.characters.find((character) => character.id === characterId)?.controllerId,
      f.player.id,
    );
    await assert.rejects(f.chat.saveCompanion(f.room.id, f.player.id, null, f.player), /接力入口/);
    await f.chat.setMemberRelay(f.room.id, f.player.id, false);
    settings = await f.chat.companionSettings(f.room.id);
    assert.equal(settings.members[0]?.relay, false);
    assert.equal(
      settings.seats.some((seat) => seat.id === f.player.id),
      false,
    );
    assert.equal(
      settings.characters.find((character) => character.id === characterId)?.controllerId,
      f.player.id,
    );
    await f.chat.setMemberRelay(f.room.id, f.player.id, true);
    await f.chat.removeMember(f.room.id, f.player.id);
    settings = await f.chat.companionSettings(f.room.id);
    assert.equal(settings.members.length, 0);
    assert.equal(
      settings.seats.some((seat) => seat.id === f.player.id),
      false,
    );
    assert.equal(
      settings.characters.find((character) => character.id === characterId)?.controllerId,
      null,
    );
  } finally {
    await f.close();
  }
});

test("接回角色等待当前 AI 行动完成，等待期间不提前撤销接力", async () => {
  let finishRun!: () => void;
  const running = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  let started = false;
  const f = await fixture({
    presets: "self",
    onRun: async () => {
      started = true;
      await running;
    },
  });
  try {
    await f.confirm();
    await f.act("beginAdventure");
    await f.chat.registerMember(f.room.id, f.player);
    await f.chat.setMemberRelay(f.room.id, f.player.id, true);
    await f.chat.send(
      {
        roomId: f.room.id,
        clientMessageId: randomUUID(),
        chatOnly: true,
        text: `[@向导](#mention/${f.player.id}) 请回应一下。`,
      },
      { id: randomUUID(), nickname: "同行者" },
    );
    await waitFor(async () => assert.equal(started, true));
    let returned = false;
    const reclaim = f.chat.setMemberRelay(f.room.id, f.player.id, false).then(() => {
      returned = true;
    });
    await Promise.resolve();
    assert.equal(returned, false);
    assert.equal((await f.chat.companionSettings(f.room.id)).members[0]?.relay, true);
    finishRun();
    await reclaim;
    assert.equal((await f.chat.companionSettings(f.room.id)).members[0]?.relay, false);
  } finally {
    finishRun();
    await f.close();
  }
});
