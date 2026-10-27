import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ChatService, type Runtime } from "@jointarp/core/node";
import { updateGameDocument } from "@jointarp/core/node/sessions/game-state";
import { createSession, openSessionDatabase } from "@jointarp/core/node/sessions/session-store";
import { gameDefaultsSchema } from "@jointarp/core/shared/game-defaults";
import { waitFor } from "@jointarp/module/testing/async";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createTestModule } from "@jointarp/module/testing/test-module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { PlaytestService, playtestCreateSchema } from "./playtest";
import { startPlaytestMcp } from "./server";
import { McpService } from "./service";

async function fixture(run?: Runtime["run"]) {
  const data = await createTestModule();
  let companionCalls = 0;
  let hostCalls = 0;
  const chat = new ChatService(
    data.sessions,
    {
      run:
        run ??
        (async (args) => {
          if (args.inputBatch)
            args.onInputReceived?.({
              batchId: args.inputBatch.id,
              messageId: args.messageId,
              reference: {
                sessionId: randomUUID(),
                beforeEntryId: null,
                afterEntryId: "test-input",
              },
            });
          if (args.companion) {
            companionCalls++;
            assert.match(args.text, /公开测试背景/);
            assert.doesNotMatch(args.text, /仅主持知道的机关/);
          } else {
            hostCalls++;
            const db = await openSessionDatabase(
              data.sessions,
              args.roomDirectory.split(/[\\/]/u).at(-1)!,
            );
            try {
              await updateGameDocument(db, join(args.roomDirectory, "game"), {
                path: "角色/向导",
                changes: [{ op: "set", path: "/hp", value: 3 - hostCalls }],
              });
            } finally {
              db.close();
            }
          }
          const message = args.companion
            ? fauxAssistantMessage(
                fauxToolCall("companion_request_ruling", { intent: "检查现场" }),
                { stopReason: "toolUse" },
              )
            : fauxAssistantMessage(
                `检查成功，生命减少一点。[@向导](#mention/${args.mentionTargets?.find((target) => target.kind === "companion")?.id})`,
              );
          args.onAgentEvent({ type: "message_start", messageIndex: 0, message });
        }),
    },
    async () => ({ config: { provider: "test", model: "test" } }),
  );
  const shown: (string | null)[] = [];
  const serviceOptions = {
    root: data.sessions,
    chat,
    player: async () => ({ id: "tester", nickname: "测试旁观者" }),
    defaults: async () => gameDefaultsSchema.parse({}),
    showRoom: (id: string | null) => {
      shown.push(id);
    },
  };
  const createService = () => new PlaytestService(serviceOptions);
  const service = createService();
  onTestFinished(async () => {
    await service.close();
    await chat.close();
    await data.cleanup();
  });
  const input = playtestCreateSchema.parse({
    modulePath: data.modulePath,
    startId: "arrival",
    background: "公开测试背景：已抵达测试地点。",
    hostBackground: "仅主持知道的机关",
    documents: [{ path: "角色/向导", values: { hp: 3 } }],
    companions: [{ path: "角色/向导" }],
  });
  return {
    ...data,
    chat,
    service,
    createService,
    input,
    shown,
    calls: () => ({ companionCalls, hostCalls }),
  };
}

test("临时局使用真实初始值与公式，按次数完成队友行动和裁定，状态与客户端投影一致", async () => {
  const f = await fixture();
  const source = await readFile(join(f.modulePath, "角色/向导.json"), "utf8");
  const { roomId } = await f.service.create(f.input);
  assert.deepEqual(f.shown, [roomId]);
  const initial = await f.service.inspect(roomId);
  assert.equal(initial.documents[0].values?.hp, 3);
  assert.equal(initial.documents[0].values?.capacity, 13);
  const launch = await f.chat.launchState(roomId, { id: "tester", nickname: "旁观者" });
  assert.equal(launch?.progress.confirmed, true);
  assert.equal(launch?.room.opening, "complete");
  await f.service.run(roomId, 2, 30);
  await waitFor(async () => assert.notEqual((await f.service.inspect(roomId)).status, "running"));
  const result = await f.service.inspect(roomId);
  assert.equal(
    result.status,
    "limit",
    JSON.stringify({ error: result.error, calls: f.calls(), messages: result.messages }),
  );
  assert.deepEqual(f.calls(), { companionCalls: 2, hostCalls: 2 });
  assert.equal(result.steps.length, 2);
  assert.equal(result.initial[0].values?.hp, 3);
  assert.equal(result.steps[0].after[0].values?.hp, 2);
  assert.equal(result.documents[0].values?.hp, 1);
  assert.ok(result.messages.some((message) => message.text.includes("检查成功")));
  assert.equal(
    (await f.chat.roomProjection(roomId, { id: "tester", nickname: "旁观者" })).sections.launch
      ?.room.opening,
    "complete",
  );
  assert.equal(await readFile(join(f.modulePath, "角色/向导.json"), "utf8"), source);
  const ordinary = await createSession(f.sessions, f.modulePath, "普通冒险");
  await assert.rejects(f.service.dispose(ordinary.id));
  await f.service.dispose(roomId);
  assert.equal(f.shown.at(-1), null);
  assert.ok((await readdir(f.sessions)).includes(ordinary.id));
  assert.ok(!(await readdir(f.sessions)).includes(roomId));
});

test("非法初始值、重复角色和路径越界不会留下半成品测试局", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, documents: [{ path: "角色/向导", values: { hp: "错误值" } }] },
    { ...f.input, documents: [{ path: "角色/../角色/向导", values: { hp: 3 } }] },
    { ...f.input, documents: [{ path: "角色/向导", values: { computed: {} } }] },
    { ...f.input, companions: [...f.input.companions, ...f.input.companions] },
  ]) {
    await assert.rejects(f.service.create(input));
    assert.deepEqual(await readdir(f.sessions), []);
  }
});

test("并发启动被拒绝；暂停取消生成并等待收尾，清理不遗留活动运行", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async (args) => {
    entered();
    await new Promise<void>((resolve) =>
      args.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const { roomId } = await f.service.create(f.input);
  const attempts = await Promise.allSettled([
    f.service.run(roomId, 3, 30),
    f.service.run(roomId, 3, 30),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  await waitFor(async () => {
    const result = await f.service.inspect(roomId);
    assert.notEqual(result.status, "failed", result.error ?? "");
    assert.ok(result.activity.running);
  });
  await started;
  assert.equal((await f.service.inspect(roomId)).activity.running?.companionId !== undefined, true);
  await f.service.pause(roomId);
  assert.equal((await f.service.inspect(roomId)).status, "paused");
  assert.equal((await f.service.inspect(roomId)).activity.running, null);
  await f.service.dispose(roomId);
});

test("真实 MCP HTTP 客户端可以创建、读取与清理测试局，未授权或浏览器来源请求被拒绝", async () => {
  const f = await fixture();
  // 遗留发现文件即使权限过宽，也必须以私有文件原子替换。
  await writeFile(join(f.root, "mcp.json"), "{}", { mode: 0o644 });
  const token = "isolated-test-token-only";
  const server = await startPlaytestMcp({ service: f.service, directory: f.root, port: 0, token });
  const client = new Client({ name: "playtest-test", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
  });
  assert.equal((await fetch(server.url, { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(server.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  assert.equal((await stat(join(f.root, "mcp.json"))).mode & 0o777, 0o600);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  assert.equal((await client.listTools()).tools.length, 5);
  const created = await client.callTool({ name: "playtest_create", arguments: f.input });
  assert.equal(created.isError, undefined);
  const roomId = (created.structuredContent as { roomId: string }).roomId;
  const inspected = await client.callTool({ name: "playtest_inspect", arguments: { roomId } });
  assert.equal(inspected.isError, undefined);
  assert.equal((inspected.structuredContent as { status: string }).status, "idle");
  const disposed = await client.callTool({ name: "playtest_dispose", arguments: { roomId } });
  assert.equal(disposed.isError, undefined);
});

test("多队友跨单步继续轮换，全员不提交行动时停止而不额外启动主持", async () => {
  const called: string[] = [];
  const f = await fixture(async (args) => {
    assert.ok(args.companion);
    called.push(args.companion.id);
    args.onAgentEvent({
      type: "message_start",
      messageIndex: 0,
      message: fauxAssistantMessage(fauxToolCall("companion_silent", {}), {
        stopReason: "toolUse",
      }),
    });
  });
  const { roomId } = await f.service.create({
    ...f.input,
    companions: [{ path: "角色/向导" }, { path: "角色/工匠" }],
  });
  for (let i = 0; i < 2; i++) {
    await f.service.run(roomId, 1, 30);
    await waitFor(async () => assert.equal((await f.service.inspect(roomId)).status, "limit"));
  }
  assert.notEqual(called[0], called[1]);
  await f.service.run(roomId, 10, 30);
  await waitFor(async () => assert.equal((await f.service.inspect(roomId)).status, "waiting"));
  assert.deepEqual(called, [called[0], called[1], called[0], called[1]]);
  assert.equal((await f.service.inspect(roomId)).steps.length, 4);
});

test("MCP 默认关闭，启停和应用重启后连接信息稳定，状态不暴露令牌且复制由主进程完成", async () => {
  const f = await fixture();
  const copied: string[] = [];
  const options = {
    directory: f.root,
    createPlaytest: f.createService,
    copyText: (text: string) => {
      copied.push(text);
    },
  };
  const first = new McpService(options);
  onTestFinished(() => first.close());
  assert.equal((await first.initialize()).state, "stopped");
  assert.throws(() => first.copyConfiguration(), /先开启/);
  assert.deepEqual(f.calls(), { companionCalls: 0, hostCalls: 0 });
  assert.equal((await first.setEnabled(true)).state, "running");
  const original = first.get().url;
  const saved = JSON.parse(await readFile(join(f.root, "mcp-settings.json"), "utf8"));
  assert.ok(saved.port > 0);
  assert.equal(saved.enabled, true);
  assert.equal((await stat(join(f.root, "mcp-settings.json"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first.get()).includes(saved.token));
  assert.deepEqual(first.copyConfiguration(), { copied: true });
  const connection = JSON.parse(copied[0]).mcpServers["tarp-playtest"];
  assert.equal(connection.url, original);
  assert.equal(connection.headers.Authorization, `Bearer ${saved.token}`);
  const client = new Client({ name: "settings-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers },
    }),
  );
  await client.listTools();
  assert.ok(first.get().lastRequestAt);
  await client.close();
  await Promise.all([first.setEnabled(false), first.setEnabled(true)]);
  assert.equal(first.get().state, "running");
  assert.equal(first.get().url, original);
  await first.close();
  assert.equal(JSON.parse(await readFile(join(f.root, "mcp-settings.json"), "utf8")).enabled, true);
  const restarted = new McpService(options);
  onTestFinished(() => restarted.close());
  assert.equal((await restarted.initialize()).state, "running");
  assert.equal(restarted.get().url, original);
  assert.equal(restarted.get().lastRequestAt, null);
  restarted.copyConfiguration();
  assert.equal(copied[1], copied[0]);
  await restarted.setEnabled(false);
  assert.equal(
    JSON.parse(await readFile(join(f.root, "mcp-settings.json"), "utf8")).enabled,
    false,
  );
  await restarted.close();
  const disabled = new McpService(options);
  onTestFinished(() => disabled.close());
  assert.equal((await disabled.initialize()).state, "stopped");
  assert.equal(disabled.get().enabled, false);
});

test("已保存端口被占用时返回可见错误；释放端口可重试且不悄悄改变连接地址", async () => {
  const f = await fixture();
  const options = { directory: f.root, createPlaytest: f.createService, copyText: () => {} };
  const original = new McpService(options);
  await original.initialize();
  const initial = await original.setEnabled(true);
  await original.close();
  const blocker = createServer();
  await new Promise<void>((resolve) =>
    blocker.listen(Number(new URL(initial.url!).port), "127.0.0.1", resolve),
  );
  onTestFinished(() => {
    blocker.close();
  });
  const restarted = new McpService(options);
  onTestFinished(() => restarted.close());
  const failed = await restarted.initialize();
  assert.equal(failed.state, "error");
  assert.equal(failed.enabled, true);
  assert.match(failed.error!, /端口被占用/);
  assert.throws(() => restarted.copyConfiguration());
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  assert.equal((await restarted.setEnabled(true)).url, initial.url);
});

test("关闭 MCP 取消正在运行的预演并保留 session，重新开启不会自动续跑", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const f = await fixture(async (args) => {
    calls++;
    entered();
    await new Promise<void>((resolve) =>
      args.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const services: PlaytestService[] = [];
  const manager = new McpService({
    directory: f.root,
    copyText: () => {},
    createPlaytest: () => {
      const service = f.createService();
      services.push(service);
      return service;
    },
  });
  onTestFinished(() => manager.close());
  await manager.initialize();
  await manager.setEnabled(true);
  const { roomId } = await services[0].create(f.input);
  await services[0].run(roomId, 5, 30);
  await started;
  await manager.setEnabled(false);
  assert.equal(manager.get().state, "stopped");
  assert.equal(
    (await f.chat.roomProjection(roomId, { id: "tester", nickname: "旁观者" })).sections
      .chatActivity.running,
    null,
  );
  assert.ok((await readdir(f.sessions)).includes(roomId));
  await manager.setEnabled(true);
  assert.equal((await services[1].inspect(roomId)).status, "idle");
  assert.equal(calls, 1);
});
