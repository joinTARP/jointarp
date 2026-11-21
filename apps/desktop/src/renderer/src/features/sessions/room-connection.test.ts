import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import type { ChatMessage, RoomNotification } from "@jointarp/core/shared/game";
import {
  createRoomReplica,
  createRoomBaseline,
  createRoomEncoder,
} from "@jointarp/core/testing/room-replica";
import { advanceTimersByTime, useFakeTimers, useRealTimers } from "@jointarp/module/testing/async";

import type { GameClient } from "./game-client";
import { RoomConnection, type LocalRoomModuleLoader } from "./room-connection";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("等待房间同步超时");
}
function fixture() {
  const state = createRoomReplica();
  let subscriptions = 0;
  let active = 0;
  let histories = 0;
  let resources = 0;
  const cursors: number[] = [];
  const streamId = randomUUID();
  const acknowledgments: number[] = [];
  let nextMessages: RoomNotification[] = [];
  const localModule = {
    resources: async () => {
      resources++;
      return {
        baseline: createRoomBaseline(),
        room: state.sections.room,
        module: { name: "测试" },
        documentTypes: [],
        documents: [],
        maps: [],
        pages: [],
      };
    },
  } satisfies LocalRoomModuleLoader;
  const client = {
    chat: {
      history: async () => {
        histories++;
        return {
          messages: [],
          cursor: 0,
          streamId,
          submissionMode: { mode: "auto", revision: 0 },
          pendingMessageIds: [],
          steering: { enabled: false, revision: 0, entries: [] },
          isHost: true,
          hasMore: false,
        };
      },
    },
    room: {
      acknowledge: async (input: { sequence: number }) => {
        acknowledgments.push(input.sequence);
      },
      subscribe: async function* (
        input: { afterChatCursor: number },
        options: { signal: AbortSignal },
      ) {
        subscriptions++;
        active++;
        cursors.push(input.afterChatCursor);
        const id = randomUUID();
        try {
          yield {
            type: "state",
            frame: createRoomEncoder(createRoomBaseline()).update(state)!,
            delivery: { id, seq: 1 },
          };
          let seq = 1;
          for (const message of nextMessages) yield { ...message, delivery: { id, seq: ++seq } };
          await new Promise<void>((resolve) => {
            options.signal.addEventListener("abort", () => resolve(), { once: true });
            if (options.signal.aborted) resolve();
          });
        } finally {
          active--;
        }
      },
    },
  } as unknown as GameClient;
  return {
    state,
    client,
    localModule,
    cursors,
    acknowledgments,
    get counts() {
      return { subscriptions, active, histories, resources };
    },
    enqueue(messages: RoomNotification[]) {
      nextMessages = messages;
    },
  };
}

test("多个面板共享一个订阅，最后离开取消并清除房间数据", async () => {
  const f = fixture();
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule);
  const releaseA = connection.retain();
  const releaseB = connection.retain();
  await until(() => connection.getSnapshot().connected);
  assert.equal(f.counts.subscriptions, 1);
  await until(() => f.acknowledgments.length === 1);
  releaseA();
  assert.equal(f.counts.active, 1);
  releaseB();
  await until(() => f.counts.active === 0);
  assert.equal(connection.getSnapshot().replica, undefined);
  assert.equal(connection.getSnapshot().initialized, false);
});

test("重连从已应用聊天游标恢复，新状态快照不重置聊天，重复事件仍会确认", async () => {
  const f = fixture();
  const event = { type: "mode", cursor: 1, snapshot: { mode: "manual", revision: 1 } } as const;
  f.enqueue([{ type: "chat", event, delivery: { id: randomUUID(), seq: 2 } }]);
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule);
  const release = connection.retain();
  try {
    await until(
      () =>
        connection.getSnapshot().submissionMode.mode === "manual" && f.acknowledgments.length === 2,
    );
    f.state.entities.monster.document = { ...f.state.entities.monster.document, values: { hp: 2 } };
    connection.reconnect();
    await until(() => f.counts.subscriptions === 2 && f.acknowledgments.length === 4);
    assert.deepEqual(f.cursors, [0, 1]);
    assert.equal(f.counts.histories, 1);
    assert.equal(f.counts.resources, 1);
    assert.equal(connection.getSnapshot().replica!.entities.monster.document.values.hp, 2);
    assert.deepEqual(connection.getSnapshot().submissionMode, { mode: "manual", revision: 1 });
  } finally {
    release();
  }
});

test("新冒险初始手动模式可读取，新通知不被迟到响应、重复通知或旧历史覆盖", async () => {
  const f = fixture();
  const history = f.client.chat.history;
  f.client.chat.history = async (...args) => ({
    ...(await history(...args)),
    submissionMode: { mode: "manual", revision: 0 },
  });
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule);
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    assert.deepEqual(connection.getSnapshot().submissionMode, { mode: "manual", revision: 0 });
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => (finish = resolve));
    f.client.chat.setSubmissionMode = async () => {
      await barrier;
      return { mode: "manual", revision: 1 };
    };
    const response = f.client.chat
      .setSubmissionMode({ roomId: f.state.sections.room.id, mode: "manual" })
      .then((snapshot) => connection.chat.confirmSubmissionMode(snapshot));
    connection.chat.applyEvent({
      type: "mode",
      cursor: 1,
      snapshot: { mode: "auto", revision: 2 },
    });
    finish();
    await response;
    connection.chat.applyEvent({
      type: "mode",
      cursor: 2,
      snapshot: { mode: "manual", revision: 2 },
    });
    await connection.chat.refresh(new AbortController().signal);
    assert.deepEqual(connection.getSnapshot().submissionMode, { mode: "auto", revision: 2 });
  } finally {
    release();
  }
});

test("事件流过期后刷新已加载旧消息和离线新增消息，分页期间的新通知不丢失", async () => {
  const f = fixture();
  const roomId = f.state.sections.room.id;
  const message = (sequence: number): Extract<ChatMessage, { kind: "player" }> => ({
    id: randomUUID(),
    roomId,
    sequence,
    revision: 1,
    senderId: "player",
    nickname: "玩家",
    createdAt: new Date().toISOString(),
    kind: "player",
    text: `消息 ${sequence}`,
    status: "complete",
    chatOnly: false,
    ...(sequence === 1 ? { pendingAgent: true } : {}),
  });
  let messages = Array.from({ length: 25 }, (_, i) => message(i + 1));
  const staleMessage = messages[0];
  let streamId = randomUUID();
  let cursor = 10;
  let refreshPages = 0;
  const requestedStreams: string[] = [];
  const originalSubscribe = f.client.room.subscribe;
  f.client.room.subscribe = async (input, options) => {
    requestedStreams.push(input.afterChatStreamId);
    if (input.afterChatStreamId !== streamId)
      throw Object.assign(new Error("通知已过期"), {
        code: "PRECONDITION_FAILED",
        data: { reason: "CHAT_RESYNC_REQUIRED" },
      });
    return originalSubscribe(input, options);
  };
  f.client.chat.history = async (input) => {
    if (cursor < 10) {
      refreshPages++;
      if (input.beforeSequence) {
        const updated = { ...messages.at(-1)!, revision: 2, text: "分页期间到达的新内容" };
        messages = [...messages.slice(0, -1), updated];
        cursor = 2;
        f.enqueue([
          {
            type: "chat",
            event: { type: "message", cursor: 1, message: updated },
            delivery: { id: randomUUID(), seq: 2 },
          },
          {
            type: "chat",
            event: { type: "message", cursor: 2, message: staleMessage },
            delivery: { id: randomUUID(), seq: 3 },
          },
        ]);
      }
    }
    const rows = messages
      .filter((item) => input.beforeSequence === undefined || item.sequence < input.beforeSequence)
      .reverse();
    const limit = input.limit ?? 50;
    return {
      messages: rows.slice(0, limit).reverse(),
      cursor,
      streamId,
      hasMore: rows.length > limit,
      submissionMode: { mode: "auto", revision: 0 },
      pendingMessageIds: messages.filter((item) => item.pendingAgent).map((item) => item.id),
      steering: { enabled: false, revision: 0, entries: [] },
      isHost: true,
    };
  };
  const connection = new RoomConnection(f.client, roomId, f.localModule);
  const notifiedIds: string[] = [];
  connection.onChat((event) => {
    if (event.type === "message") notifiedIds.push(event.message.id);
  });
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    const oldStream = streamId;
    streamId = randomUUID();
    cursor = 0;
    messages = [
      { ...messages[0], revision: 2, text: "旧消息已经更新", pendingAgent: undefined },
      ...messages.slice(1),
      ...Array.from({ length: 200 }, (_, i) => message(i + 26)),
    ];
    connection.reconnect();
    await until(() => {
      const snapshot = connection.getSnapshot();
      const last = snapshot.messages.at(-1);
      return (
        snapshot.messages.length === 225 &&
        last?.kind === "player" &&
        last.text === "分页期间到达的新内容" &&
        snapshot.connected &&
        f.acknowledgments.length >= 4
      );
    });
    const first = connection.getSnapshot().messages[0];
    assert.equal(first.kind === "player" && first.text, "旧消息已经更新");
    assert.deepEqual(connection.getSnapshot().pendingMessageIds, []);
    assert.equal(connection.getSnapshot().hasMore, false);
    assert.equal(refreshPages, 3);
    assert.deepEqual(notifiedIds, [messages.at(-1)!.id]);
    assert.deepEqual(requestedStreams, [oldStream, oldStream, streamId]);
    assert.deepEqual(f.cursors, [10, 0]);
  } finally {
    release();
  }
});

test("本地缺模组停止重试，恢复后显式重连重新读取本地入口", async () => {
  const f = fixture();
  let reads = 0;
  let missing = true;
  const loader: LocalRoomModuleLoader = {
    ...f.localModule,
    resources: async () => {
      reads++;
      if (missing) throw new Error("session/module 不存在");
      return f.localModule.resources();
    },
  };
  const connection = new RoomConnection(f.client, f.state.sections.room.id, loader);
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const release = connection.retain();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(connection.getSnapshot().error);
    assert.match(connection.getSnapshot().error!.message, /本地冻结模组读取失败/);
    advanceTimersByTime(15_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(f.counts.subscriptions, 0);
    useRealTimers();
    missing = false;
    connection.reconnect();
    await until(() => connection.getSnapshot().connected);
    assert.equal(reads, 2);
  } finally {
    release();
    useRealTimers();
  }
});

test("模组版本不符停止重试且保留明确错误，不再次请求远端资源", async () => {
  const f = fixture();
  let calls = 0;
  f.client.room.subscribe = async () => {
    calls++;
    throw Object.assign(new Error("本地冻结模组版本与房间不匹配"), {
      code: "PRECONDITION_FAILED",
      data: { reason: "BASELINE_MISMATCH" },
    });
  };
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule);
  useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const release = connection.retain();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(connection.getSnapshot().error);
    advanceTimersByTime(15_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(f.counts.resources, 1);
    assert.match(connection.getSnapshot().error!.message, /本地冻结模组版本/);
  } finally {
    release();
    useRealTimers();
  }
});

test("取消单个读取者不影响其他面板，旧版结果自动重读", async () => {
  const f = fixture();
  const initialRevision = f.state.documentRevision;
  let revision = 0;
  let resolveFirst!: (value: typeof f.state.entities.monster.document) => void;
  const first = new Promise<typeof f.state.entities.monster.document>((resolve) => {
    resolveFirst = resolve;
  });
  const evaluator = {
    setSnapshot: (version: number) => {
      revision = version;
    },
    updateSnapshot: (version: number) => {
      revision = version;
    },
    evaluateDocument: async (
      item: import("@jointarp/module/document-evaluator").ParsedModuleDocument,
    ) => item.document,
    readDocument: async () => {
      if (revision === initialRevision) return first;
      return { ...f.state.entities.monster.document, title: `版本${revision}` };
    },
    readDocumentName: async () => {
      throw new Error("此场景不读取名称");
    },
  };
  const connection = new RoomConnection(
    f.client,
    f.state.sections.room.id,
    f.localModule,
    () => evaluator,
  );
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    const aborted = new AbortController();
    const active = new AbortController();
    const entity = connection.getSnapshot().replica!.entities.monster;
    const cancelled = connection.loadDocument(entity, aborted.signal);
    const shared = connection.loadDocument(entity, active.signal);
    aborted.abort();
    await assert.rejects(cancelled);
    f.state.documentRevision++;
    connection.reconnect();
    await until(() => f.counts.subscriptions === 2 && connection.getSnapshot().connected);
    resolveFirst(entity.document);
    const latest = await shared;
    assert.equal(latest.title, `版本${f.state.documentRevision}`);
    f.state.sections.room = { ...f.state.sections.room, name: "仅房间元数据变化" };
    connection.reconnect();
    await until(() => f.counts.subscriptions === 3 && connection.getSnapshot().connected);
    assert.equal(connection.getSnapshot().replica!.sections.room.name, "仅房间元数据变化");
    assert.deepEqual(await connection.loadDocument(entity, active.signal), latest);
  } finally {
    release();
  }
});

test("草稿同版读取共享，单方取消不影响图片及计算，旧版本结果被丢弃", async () => {
  const f = fixture();
  const { validateDocumentType } = await import("@jointarp/module/document-type");
  const type = validateDocumentType("角色", { fields: { strength: { type: "number" } } });
  const resources = await f.localModule.resources();
  const localModule: LocalRoomModuleLoader = {
    ...f.localModule,
    resources: async () => ({ ...resources, documentTypes: [type] }),
  };
  let reads = 0;
  let resolve!: (value: import("@shared/desktop-api").ModuleDocument) => void;
  const first = new Promise<import("@shared/desktop-api").ModuleDocument>((done) => {
    resolve = done;
  });
  const engine = new (await import("@jointarp/module/document-evaluator")).DocumentEvaluator();
  const evaluator = {
    setSnapshot: engine.setSnapshot.bind(engine),
    updateSnapshot: engine.updateSnapshot.bind(engine),
    readDocument: engine.readDocument.bind(engine),
    readDocumentName: engine.readDocumentName.bind(engine),
    evaluateDocument: async (
      item: import("@jointarp/module/document-evaluator").ParsedModuleDocument,
    ) => {
      reads++;
      if (reads === 1) return first;
      return { ...item.document, title: "已计算", image: "portrait.png", avatar: "avatar.png" };
    },
  };
  const connection = new RoomConnection(
    f.client,
    f.state.sections.room.id,
    localModule,
    () => evaluator,
  );
  const release = connection.retain();
  const draft: import("@jointarp/module/character").Character = {
    id: "draft",
    typeId: type.id,
    name: "草稿",
    description: "",
    values: { strength: 2 },
    sourcePath: null,
    playerId: null,
    version: 1,
  };
  try {
    await until(() => connection.getSnapshot().connected);
    const abort = new AbortController();
    const cancelled = connection.loadDraft(draft, abort.signal);
    const stale = connection.loadDraft(structuredClone(draft), new AbortController().signal);
    assert.equal(reads, 1);
    abort.abort();
    await assert.rejects(cancelled);
    f.state.documentRevision++;
    connection.reconnect();
    await until(() => f.counts.subscriptions === 2 && connection.getSnapshot().connected);
    resolve({ path: "draft", title: "旧结果", docType: type.id, contentType: "json", valid: true });
    await assert.rejects(stale, /版本已变化/u);
    const current = await connection.loadDraft(draft, new AbortController().signal);
    assert.equal(current.title, "已计算");
    assert.equal(current.image, "portrait.png");
    assert.equal(current.avatar, "avatar.png");
    await connection.loadDraft(structuredClone(draft), new AbortController().signal);
    assert.equal(reads, 2);
  } finally {
    release();
  }
});

test("NPC名称候选共享版本缓存与取消读取，不解析候选图片且丢弃旧版别名", async () => {
  const f = fixture();
  let nameReads = 0;
  let fullReads = 0;
  let revision = 0;
  let resolveFirst!: (value: typeof f.state.entities.monster.document) => void;
  const first = new Promise<typeof f.state.entities.monster.document>((resolve) => {
    resolveFirst = resolve;
  });
  const evaluator = {
    setSnapshot: (version: number) => {
      revision = version;
    },
    updateSnapshot: (version: number) => {
      revision = version;
    },
    evaluateDocument: async (
      item: import("@jointarp/module/document-evaluator").ParsedModuleDocument,
    ) => item.document,
    readDocument: async () => {
      fullReads++;
      return { ...f.state.entities.monster.document, image: "插画.webp", avatar: "头像.webp" };
    },
    readDocumentName: async () => {
      nameReads++;
      return nameReads === 1
        ? first
        : {
            ...f.state.entities.monster.document,
            title: `别名${revision}`,
            image: "隐藏图片.webp",
          };
    },
  };
  const connection = new RoomConnection(
    f.client,
    f.state.sections.room.id,
    {
      ...f.localModule,
    },
    () => evaluator,
  );
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    const entity = connection.getSnapshot().replica!.entities.monster;
    const abort = new AbortController();
    const cancelled = connection.loadDocumentName(entity, abort.signal);
    const current = connection.loadDocumentName(entity, new AbortController().signal);
    assert.equal(nameReads, 1);
    abort.abort();
    await assert.rejects(cancelled);
    f.state.documentRevision++;
    connection.reconnect();
    await until(() => f.counts.subscriptions === 2 && connection.getSnapshot().connected);
    resolveFirst({ ...entity.document, title: "旧版别名" });
    const result = await current;
    assert.equal(result.title, `别名${f.state.documentRevision}`);
    assert.equal(result.image, undefined);
    await connection.loadDocumentName(entity, new AbortController().signal);
    assert.equal(nameReads, 2);
    assert.equal(fullReads, 0);
    const document = await connection.loadDocument(entity, new AbortController().signal);
    assert.equal(document.image, "插画.webp");
    assert.equal(document.avatar, "头像.webp");
    assert.equal(fullReads, 1);
  } finally {
    release();
  }
});

test("同版计算失败可显式重建计算器重试，共享模组资源不重复读取", async () => {
  const f = fixture();
  let created = 0;
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule, () => {
    const generation = ++created;
    return {
      setSnapshot: () => {},
      updateSnapshot: () => {},
      readDocumentName: async () => {
        throw new Error("此场景不读取名称");
      },
      evaluateDocument: async (item) => item.document,
      readDocument: async () => ({ ...f.state.entities.monster.document, valid: generation > 1 }),
    };
  });
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    const entity = connection.getSnapshot().replica!.entities.monster;
    assert.equal(
      (await connection.loadDocument(entity, new AbortController().signal)).valid,
      false,
    );
    connection.reconnect(true);
    await until(() => f.counts.subscriptions === 2 && connection.getSnapshot().connected);
    assert.equal((await connection.loadDocument(entity, new AbortController().signal)).valid, true);
    assert.equal(created, 2);
    assert.equal(f.counts.resources, 1);
    assert.equal(connection.getSnapshot().replica!.documentRevision, f.state.documentRevision);
  } finally {
    release();
  }
});

test("房间同步将公式配置独立交给计算器，配置变化与删除刷新展示", async () => {
  const f = fixture();
  const { validateDocumentType } = await import("@jointarp/module/document-type");
  const monsterType = validateDocumentType("怪物", {
    fields: {
      attack: { type: "number", compute: "1" },
      name: { type: "text" },
    },
  });
  f.state.entities = {
    ...f.state.entities,
    monster: {
      ...f.state.entities.monster,
      document: {
        ...f.state.entities.monster.document,
        values: {},
        computed: {
          attack: "10",
          name: "'攻击 ' + $self.attack",
        },
      },
    },
  };
  const resources = await f.localModule.resources();
  const connection = new RoomConnection(f.client, f.state.sections.room.id, {
    resources: async () => ({ ...resources, documentTypes: [monsterType] }),
  });
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    const signal = new AbortController().signal;
    let entity = connection.getSnapshot().replica!.entities.monster;
    assert.equal((await connection.loadDocumentName(entity, signal)).title, "攻击 10");
    assert.equal((await connection.loadDocument(entity, signal)).values?.computed, undefined);
    assert.equal(entity.document.values.computed, undefined, "公式配置不混入同步的业务字段");
    f.state.documentRevision++;
    f.state.entities = {
      ...f.state.entities,
      monster: {
        ...f.state.entities.monster,
        document: {
          ...f.state.entities.monster.document,
          computed: { attack: "99", name: "'攻击 ' + $self.attack" },
        },
      },
    };
    connection.reconnect();
    await until(
      () =>
        f.counts.subscriptions === 2 &&
        connection.getSnapshot().replica?.documentRevision === f.state.documentRevision,
    );
    entity = connection.getSnapshot().replica!.entities.monster;
    assert.equal(
      (await connection.loadDocumentName(entity, signal)).title,
      "攻击 99",
      "单独变化的公式配置也刷新结果",
    );
    f.state.documentRevision++;
    const { computed: _computed, ...ordinary } = f.state.entities.monster.document;
    f.state.entities = {
      ...f.state.entities,
      monster: { ...f.state.entities.monster, document: ordinary },
    };
    connection.reconnect();
    await until(
      () =>
        f.counts.subscriptions === 3 &&
        connection.getSnapshot().replica?.documentRevision === f.state.documentRevision,
    );
    entity = connection.getSnapshot().replica!.entities.monster;
    assert.equal(
      (await connection.loadDocument(entity, signal)).values?.attack,
      1,
      "移除配置恢复类型默认公式",
    );
  } finally {
    release();
  }
});

test("同步模组后显式重新加载资源，已打开的连接显示新模组资料", async () => {
  const f = fixture();
  const connection = new RoomConnection(f.client, f.state.sections.room.id, f.localModule);
  const release = connection.retain();
  try {
    await until(() => connection.getSnapshot().connected);
    assert.equal(connection.getSnapshot().resources?.module.name, "测试");
    const original = f.localModule.resources;
    f.localModule.resources = async () => ({
      ...(await original()),
      module: { name: "更新后的模组" },
    });
    connection.reconnect(true, true);
    await until(
      () =>
        connection.getSnapshot().connected &&
        connection.getSnapshot().resources?.module.name === "更新后的模组",
    );
    assert.equal(f.counts.resources, 2);
    assert.equal(f.counts.active, 1);
  } finally {
    release();
  }
});
