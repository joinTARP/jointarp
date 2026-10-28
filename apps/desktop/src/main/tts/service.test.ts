import { test, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import { initializeAdventure, updateAdventure } from "@jointarp/core/node/sessions/room-storage";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";

import { mimoTtsProvider } from "./mimo";
import type { TtsProvider } from "./provider";
import { TtsService } from "./service";

const audio = {
  data: Buffer.from("RIFF0000WAVEtest").toString("base64"),
  mimeType: "audio/wav" as const,
};
test("MiMo 使用 assistant 正文、user 风格和 WAV 响应；拒绝鉴权错误与无效音频", async () => {
  let payload: any;
  const provider = mimoTtsProvider((async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    assert.equal(url, "https://api.xiaomimimo.com/v1/chat/completions");
    assert.equal(new Headers(init?.headers).get("api-key"), "test-key");
    payload = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { audio: { data: audio.data } } }] });
  }) as unknown as typeof fetch);
  const config = provider.info.defaultConfig;
  assert.deepEqual(
    await provider.synthesize({ text: "酒馆开门了。", config, apiKey: "test-key" }),
    audio,
  );
  assert.deepEqual(payload.messages, [
    { role: "user", content: config.instructions },
    { role: "assistant", content: "酒馆开门了。" },
  ]);
  assert.deepEqual(payload.audio, { format: "wav", voice: "冰糖" });
  assert.equal(payload.stream, false);
  const bad = mimoTtsProvider(
    (async () => new Response("secret-key", { status: 401 })) as unknown as typeof fetch,
  );
  await assert.rejects(bad.synthesize({ text: "你好", config, apiKey: "test-key" }), /鉴权失败/);
  const invalid = mimoTtsProvider((async () =>
    Response.json({
      choices: [{ message: { audio: { data: "aGVsbG8=" } } }],
    })) as unknown as typeof fetch);
  await assert.rejects(
    invalid.synthesize({ text: "你好", config, apiKey: "test-key" }),
    /音频格式无效/,
  );
});

test("凭据写入本机配置且不回显，缓存按配置隔离，新服务商不复用其他服务商的密钥", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-"));
  const calls: { provider: string; key: string }[] = [];
  const make = (id: string): TtsProvider => ({
    info: {
      ...mimoTtsProvider().info,
      id,
      defaultConfig: { ...mimoTtsProvider().info.defaultConfig, provider: id },
    },
    async synthesize(input) {
      calls.push({ provider: id, key: input.apiKey });
      return audio;
    },
  });
  const providers = [make("mimo"), make("future")];
  try {
    const service = new TtsService(root, providers);
    const original = await service.get();
    assert.equal(original.automatic, false);
    const saved = await service.save({
      config: original.config,
      automatic: true,
      apiKey: "first-secret",
    });
    assert.equal(saved.hasKey, true);
    assert.ok(!JSON.stringify(saved).includes("first-secret"));
    assert.match(await readFile(join(root, "settings.json"), "utf8"), /first-secret/);
    await service.synthesize("你好");
    await service.synthesize("你好");
    assert.equal(calls.length, 1);
    await service.save({ config: { ...saved.config, voice: "苏打" }, automatic: true });
    await service.synthesize("你好");
    assert.equal(calls.length, 2);
    const next = await service.save({ config: providers[1].info.defaultConfig, automatic: false });
    assert.equal(next.hasKey, false);
    await assert.rejects(service.synthesize("你好"), /API Key/);
    await service.save({ config: next.config, automatic: false, apiKey: "second-secret" });
    await service.synthesize("你好");
    assert.deepEqual(calls.at(-1), { provider: "future", key: "second-secret" });
    const reopened = new TtsService(root, providers);
    await reopened.save({ config: saved.config, automatic: true });
    await reopened.synthesize("再次播放");
    assert.deepEqual(calls.at(-1), { provider: "mimo", key: "first-secret" });
    await reopened.disconnect("mimo");
    const disconnected = await reopened.get();
    assert.equal(disconnected.hasKey, false);
    assert.equal(disconnected.automatic, true);
    await assert.rejects(reopened.synthesize("你好"), /API Key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("取消请求不产生音频，拒绝未知的预置音色", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-memory-"));
  try {
    const service = new TtsService(root);
    await service.save({
      config: (await service.get()).config,
      automatic: false,
      apiKey: "volatile-secret",
    });
    await assert.rejects(service.synthesize("不会发出请求", undefined, AbortSignal.abort()));
    await assert.rejects(
      service.save({
        config: { ...(await service.get()).config, voice: "unknown" },
        automatic: false,
      }),
      /音色/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MiMo SSE 跨网络边界增量产出 PCM，拒绝没有完成标记的截断流", async () => {
  let body: any;
  const packet = `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "AAA=" } } }] })}\r\n\r\n`;
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
  });
  const provider = mimoTtsProvider((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    body = JSON.parse(String(init?.body));
    return new Response(stream);
  }) as unknown as typeof fetch);
  const iterator = provider.stream!({
    text: "你好",
    config: provider.info.defaultConfig,
    apiKey: "key",
  })[Symbol.asyncIterator]();
  const next = iterator.next();
  writer.enqueue(new TextEncoder().encode(packet.slice(0, 17)));
  writer.enqueue(new TextEncoder().encode(packet.slice(17)));
  assert.equal((await next).value.data, "AAA=");
  assert.equal(body.stream, true);
  assert.equal(body.audio.format, "pcm16");
  writer.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
  writer.close();
  assert.equal((await iterator.next()).done, true);
  const truncated = mimoTtsProvider((async () => new Response(packet)) as unknown as typeof fetch);
  const broken = truncated.stream!({
    text: "你好",
    config: provider.info.defaultConfig,
    apiKey: "key",
  })[Symbol.asyncIterator]();
  await broken.next();
  await assert.rejects(broken.next(), /中断/);
});

test("流式结果完整后缓存为 WAV，并发听众只发一次请求，断流不缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-stream-"));
  let calls = 0;
  let broken = false;
  const provider: TtsProvider = {
    info: mimoTtsProvider().info,
    async synthesize() {
      throw new Error("应使用流式接口");
    },
    async *stream() {
      calls++;
      yield { type: "pcm", data: "AQACAA==", sampleRate: 24000, channels: 1 };
      if (broken) throw new Error("断流");
    },
  };
  try {
    const service = new TtsService(root, [provider]);
    await service.save({ config: provider.info.defaultConfig, automatic: false, apiKey: "key" });
    const [a, b] = await Promise.all([service.synthesize("你好"), service.synthesize("你好")]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    const wav = Buffer.from(a.data, "base64");
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.deepEqual([...wav.subarray(44)], [1, 0, 2, 0]);
    assert.equal((await service.stream("你好").next()).value?.type, "audio");
    assert.equal(calls, 1);
    broken = true;
    await assert.rejects(service.synthesize("失败"), /断流/);
    await assert.rejects(service.synthesize("失败"), /断流/);
    assert.equal(calls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("VoiceDesign 要求音色描述、不传预置 voice，走完整 WAV 并复用缓存", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-design-"));
  let payload: any;
  let calls = 0;
  const provider = mimoTtsProvider((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    calls++;
    payload = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { audio: { data: audio.data } } }] });
  }) as unknown as typeof fetch);
  try {
    const service = new TtsService(root, [provider]);
    const design = {
      ...provider.info.defaultConfig,
      model: "mimo-v2.5-tts-voicedesign",
      voice: "custom",
      voiceDescription: "一位低沉的说书人",
    };
    await assert.rejects(
      service.save({ config: { ...design, voiceDescription: "" }, automatic: false }),
      /音色描述/,
    );
    await service.save({ config: design, automatic: false, apiKey: "design-key" });
    const first = await service.stream("夜幕降临。 ").next();
    assert.equal(first.value?.type, "audio");
    assert.equal(payload.model, "mimo-v2.5-tts-voicedesign");
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.audio, { format: "wav" });
    assert.equal(payload.messages[0].role, "user");
    assert.match(payload.messages[0].content, /低沉的说书人/);
    assert.deepEqual(payload.messages.at(-1), { role: "assistant", content: "夜幕降临。" });
    assert.equal((await service.stream("夜幕降临。").next()).value?.type, "audio");
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("试听使用临时配置和密钥，不保存连接或默认声音", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-preview-"));
  let payload: any;
  let header = "";
  const provider = mimoTtsProvider((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    payload = JSON.parse(String(init?.body));
    header = new Headers(init?.headers).get("api-key") ?? "";
    return Response.json({ choices: [{ message: { audio: { data: audio.data } } }] });
  }) as unknown as typeof fetch);
  try {
    const config = {
      ...provider.info.defaultConfig,
      model: "mimo-v2.5-tts-voicedesign",
      voice: "custom",
      voiceDescription: "临时试听的低沉说书人",
    };
    const service = new TtsService(root, [provider]);
    await service.synthesize("只试听，不保存。", undefined, undefined, {
      config,
      apiKey: "preview-only-key",
    });
    assert.equal(header, "preview-only-key");
    assert.equal(payload.model, "mimo-v2.5-tts-voicedesign");
    assert.equal((await service.get()).hasKey, false);
    assert.equal((await service.get()).config.model, "mimo-v2.5-tts");
    await assert.rejects(readFile(join(root, "settings.json")), { code: "ENOENT" });
    await assert.rejects(service.synthesize("正式朗读仍需连接"), /API Key/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模组声音按主持人、AI 队友角色路径与 NPC 文档路径 解析，缺省继承全局", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-module-"));
  const roomId = "123e4567-e89b-42d3-a456-426614174000";
  const dir = join(root, "sessions", roomId);
  const requests: any[] = [];
  const provider = mimoTtsProvider((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const payload = JSON.parse(String(init?.body));
    requests.push(payload);
    if (payload.stream)
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "AQACAA==" } }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json({ choices: [{ message: { audio: { data: audio.data } } }] });
  }) as unknown as typeof fetch);
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "module"), { recursive: true });
    initializeRoomSettings(dir);
    initializeAdventure(dir, {
      id: roomId,
      name: "测试冒险",
      moduleName: "古墓",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(
      join(dir, "module", "module.toml"),
      `name = "古墓"\ndescription = "测试"\n[tts.host]\ndescription = "低沉的主持人"\ninstructions = "语速缓慢"\n[tts.characters."角色/老板娘.toml"]\ndescription = "爽朗的老板娘"\n[tts.characters."角色/阿青.toml"]\ndescription = "清亮的少女声"\n`,
    );
    updateAdventure(dir, (current) => ({
      ...current,
      party: {
        members: [],
        companions: [
          {
            id: "companion-id",
            status: "active",
            characterId: "character-id",
            joinedSequence: 0,
            model: null,
            initiative: { level: "natural", prompt: "" },
            documentAccess: false,
            voice: null,
            defaultVoice: null,
          },
        ],
        characters: [
          {
            id: "character-id",
            typeId: "角色",
            playerId: null,
            sourcePath: "角色/阿青.json",
            retired: false,
          },
        ],
      },
    }));
    const service = new TtsService(root, [provider]);
    await service.save({ config: provider.info.defaultConfig, automatic: false, apiKey: "key" });
    const speaker = (kind: "host" | "companion" | "npc", id: string) => ({ roomId, kind, id });
    await service.synthesize("主持人", speaker("host", ""));
    const inherited = await service.voiceSettings(roomId, "companion-id");
    assert.equal(inherited.voiceDescription, "清亮的少女声");
    await service.synthesize("队友", speaker("companion", "companion-id"));
    await service.synthesize("NPC", speaker("npc", "角色/老板娘.json"));
    await service.synthesize("其他人", speaker("npc", "unknown"));
    assert.deepEqual(
      requests.map((item) => item.model),
      [
        "mimo-v2.5-tts-voicedesign",
        "mimo-v2.5-tts-voicedesign",
        "mimo-v2.5-tts-voicedesign",
        "mimo-v2.5-tts",
      ],
    );
    assert.match(requests[0].messages[0].content, /低沉的主持人/);
    assert.match(requests[0].messages[0].content, /语速缓慢/);
    assert.match(requests[1].messages[0].content, /清亮的少女声/);
    assert.match(requests[2].messages[0].content, /爽朗的老板娘/);
    assert.equal(requests[3].audio.voice, "冰糖");
    await service.synthesize("预写台词", speaker("npc", "角色/阿青.md"));
    assert.match(requests.at(-1).messages[0].content, /清亮的少女声/);
    const selectionFile = join(dir, "adventure.json");
    const adventure = JSON.parse(await readFile(selectionFile, "utf8"));
    const companion = adventure.party.companions[0];
    companion.voice = {
      mode: "preset",
      voice: "苏打",
      instructions: "轻松",
    };
    await writeFile(selectionFile, JSON.stringify(adventure));
    await service.synthesize("队友", speaker("companion", "companion-id"));
    assert.equal(requests.at(-1).model, "mimo-v2.5-tts");
    assert.equal(requests.at(-1).audio.voice, "苏打");
    assert.equal(requests.at(-1).messages[0].content, "轻松");
    assert.equal(requests.length, 6);
    companion.voice = null;
    await writeFile(selectionFile, JSON.stringify(adventure));
    await service.synthesize("队友", speaker("companion", "companion-id"));
    assert.equal(requests.length, 6, "恢复模组后可复用此前的模组音色缓存");
    companion.voice = {
      mode: "design",
      description: "沙哑的青年声",
      instructions: "",
    };
    await writeFile(selectionFile, JSON.stringify(adventure));
    await service.synthesize("队友", speaker("companion", "companion-id"));
    assert.equal(requests.at(-1).model, "mimo-v2.5-tts-voicedesign");
    assert.equal(requests.at(-1).messages[0].content, "沙哑的青年声");
    const effective = await service.voiceSettings(roomId, "companion-id");
    assert.equal(effective.voiceDescription, "沙哑的青年声");
    assert.equal(effective.instructions, "");
    assert.ok(!JSON.stringify(effective).includes("apiKey"));
    // 模组没有声音表时仍使用房间内覆盖。
    const reopened = new TtsService(root, [provider]);
    await writeFile(join(dir, "module", "module.toml"), 'name = "古墓"\ndescription = "测试"\n');
    await reopened.synthesize("房间覆盖", speaker("companion", "companion-id"));
    assert.equal(requests.at(-1).messages[0].content, "沙哑的青年声");
    companion.voice = null;
    companion.defaultVoice = { mode: "preset", voice: "白桦", instructions: "模板兜底" };
    await writeFile(selectionFile, JSON.stringify(adventure));
    await reopened.synthesize("模板声音", speaker("companion", "companion-id"));
    assert.equal(requests.at(-1).audio.voice, "白桦");
    assert.equal(requests.at(-1).messages[0].content, "模板兜底");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模组声音配置损坏时报错，修复后同一服务可以重新读取", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-tts-module-error-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const roomId = "123e4567-e89b-42d3-a456-426614174001";
  const directory = join(root, "sessions", roomId);
  await mkdir(join(directory, "module"), { recursive: true });
  initializeRoomSettings(directory);
  const metadataPath = join(directory, "module", "module.toml");
  await writeFile(metadataPath, "name = [");
  const service = new TtsService(root);
  onTestFinished(() => service.close());

  await assert.rejects(service.hostVoiceSettings(roomId), /TOML 格式无效/);
  await writeFile(
    metadataPath,
    'name = "测试模组"\ndescription = "声音修复"\n[tts.host]\ndescription = "模组说书人"\n',
  );
  assert.equal((await service.hostVoiceSettings(roomId)).config.voiceDescription, "模组说书人");
});

test("当前冒险的主持人声音覆盖模组预设，清除后恢复模组声音", async () => {
  const root = await mkdtemp(join(tmpdir(), "trpg-tts-host-"));
  const roomId = "123e4567-e89b-42d3-a456-426614174001";
  const dir = join(root, "sessions", roomId);
  const requests: any[] = [];
  const provider = mimoTtsProvider((async (
    _url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const payload = JSON.parse(String(init?.body));
    requests.push(payload);
    if (payload.stream)
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: "AQACAA==" } }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return Response.json({ choices: [{ message: { audio: { data: audio.data } } }] });
  }) as unknown as typeof fetch);
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "module"), { recursive: true });
    initializeRoomSettings(dir);
    initializeAdventure(dir, {
      id: roomId,
      name: "测试冒险",
      moduleName: "古墓",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(
      join(dir, "module", "module.toml"),
      'name = "古墓"\ndescription = "测试"\n[tts.host]\ndescription = "模组说书人"\n',
    );
    const service = new TtsService(root, [provider]);
    await service.save({ config: provider.info.defaultConfig, automatic: false, apiKey: "key" });

    const inherited = await service.hostVoiceSettings(roomId);
    assert.equal(inherited.overridden, false);
    assert.equal(inherited.config.voiceDescription, "模组说书人");

    assert.equal((await service.roomSettings(roomId)).enabled, true);
    assert.equal((await service.saveRoomSettings(roomId, false)).enabled, false);
    await assert.rejects(
      service.synthesize("不应朗读", { roomId, kind: "host", id: "" }),
      /关闭语音/,
    );
    await service.saveRoomSettings(roomId, true);

    const overridden = await service.saveHostVoice(roomId, {
      mode: "preset",
      voice: "苏打",
      instructions: "沉稳地讲述",
    });
    assert.equal(overridden.overridden, true);
    assert.equal(overridden.config.model, "mimo-v2.5-tts");
    assert.equal(overridden.config.voice, "苏打");
    await service.synthesize("覆盖后的主持人", { roomId, kind: "host", id: "" });
    assert.equal(requests.at(-1).model, "mimo-v2.5-tts");
    assert.equal(requests.at(-1).audio.voice, "苏打");
    assert.equal(requests.at(-1).messages[0].content, "沉稳地讲述");

    const restored = await service.saveHostVoice(roomId, null);
    assert.equal(restored.overridden, false);
    assert.equal(restored.config.voiceDescription, "模组说书人");
    await service.synthesize("恢复后的主持人", { roomId, kind: "host", id: "" });
    assert.equal(requests.at(-1).model, "mimo-v2.5-tts-voicedesign");
    assert.match(requests.at(-1).messages[0].content, /模组说书人/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("冒险语音快照独立于应用默认配置与其他房间，供应商删除后失效且重连恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-tts-snapshot-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const calls: { provider: string; config: unknown }[] = [];
  const make = (id: string): TtsProvider => ({
    info: {
      ...mimoTtsProvider().info,
      id,
      defaultConfig: { ...mimoTtsProvider().info.defaultConfig, provider: id },
    },
    async synthesize(input) {
      calls.push({ provider: id, config: input.config });
      return audio;
    },
  });
  const providers = [make("mimo"), make("other")];
  const service = new TtsService(root, providers);
  onTestFinished(() => service.close());
  const a = "123e4567-e89b-42d3-a456-426614174000";
  const b = "123e4567-e89b-42d3-a456-426614174001";
  const { mkdir, writeFile } = await import("node:fs/promises");
  for (const id of [a, b]) {
    const directory = join(root, "sessions", id);
    await mkdir(join(directory, "module"), { recursive: true });
    await writeFile(
      join(directory, "module", "module.json"),
      JSON.stringify({ name: "测试模组", description: "语音快照测试" }),
    );
    initializeRoomSettings(directory);
  }
  await service.connect("mimo", "local-only-key");
  await service.setRoomAutomatic(a, true);
  await service.save({
    config: providers[1].info.defaultConfig,
    automatic: false,
    apiKey: "other-key",
  });
  assert.equal((await service.roomSettings(a)).automatic, true);
  assert.equal((await service.roomSettings(b)).automatic, false);
  await service.synthesize("快照声音", { roomId: a, kind: "host", id: "" });
  assert.equal(calls.at(-1)?.provider, "mimo");
  await service.disconnect("mimo");
  assert.equal((await service.roomSettings(a)).hasKey, false);
  assert.equal((await service.roomSettings(a)).automatic, true);
  await assert.rejects(
    service.synthesize("不能回退", { roomId: a, kind: "host", id: "" }),
    /API Key/,
  );
  assert.equal(calls.length, 1);
  await service.connect("mimo", "reconnected-key");
  await service.synthesize("恢复声音", { roomId: a, kind: "host", id: "" });
  assert.equal(calls.at(-1)?.provider, "mimo");
  assert.ok(!(await readFile(join(root, "sessions", a, "settings.json"), "utf8")).includes("key"));
});
