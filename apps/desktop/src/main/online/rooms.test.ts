import { afterAll, test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ChatService, gameRouter } from "@jointarp/core/node";
import { createSession } from "@jointarp/core/node/sessions/session-store";
import { writeTestFile } from "@jointarp/module/testing/files";
import { createTestModule } from "@jointarp/module/testing/test-module";
import { createORPCClient } from "@orpc/client";
import { os, type RouterClient } from "@orpc/server";
import native from "node-datachannel";
import { z } from "zod";

import type { DesktopRpcContext } from "../desktop-rpc-context";
import { LanService } from "../lan/service";
import { loadLocalSessionModuleResources } from "../sessions/local-room-resources";
import { roomNotesRouter } from "../sessions/room-notes-router";
import { Coordinator, coordinatorUrl } from "./coordinator";
import { coordinatorFixture } from "./coordinator.fixture";

const router = {
  game: gameRouter,
  sessions: {
    notes: roomNotesRouter,
    module: {
      resources: os
        .$context<DesktopRpcContext>()
        .input(z.object({ roomId: z.string().uuid() }))
        .handler(({ context, input }) =>
          loadLocalSessionModuleResources(context.sessionsRoot, input.roomId),
        ),
    },
  },
  config: { get: os.$context<DesktopRpcContext>().handler(() => "不能公开") },
};
afterAll(() => native.cleanup());

test("六位码原生房间：审批与权限、模组图片、身份恢复，协调服务断开后聊天与订阅继续", async () => {
  const fixture = await createTestModule();
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const coordinator = coordinatorFixture({
    beforeCreate: () => {
      requested.resolve();
      return release.promise;
    },
  });
  const options = { coordinatorUrl: coordinator.base, iceServers: [] };
  const metadata = await Bun.file(join(fixture.modulePath, "module.json")).json();
  delete metadata.gameStarts;
  delete metadata.preludeFlow;
  await writeTestFile(join(fixture.modulePath, "module.json"), JSON.stringify(metadata));
  const image = Buffer.alloc(2 * 1024 * 1024, 123);
  await writeTestFile(join(fixture.modulePath, "transport.png"), image);
  const room = await createSession(fixture.sessions, fixture.modulePath, "原生联机验证");
  const chat = new ChatService(fixture.sessions, { run: async () => {} }, async () => {
    throw Error("禁止访问模型网络");
  });
  const hostPlayer = { id: randomUUID(), nickname: "房主" };
  const guestPlayer = { id: randomUUID(), nickname: "玩家" };
  const context = {
    sessionsRoot: fixture.sessions,
    player: hostPlayer,
    isHost: true,
    chat,
  } as DesktopRpcContext;
  const host = new LanService(fixture.root, async () => context, router, options);
  const guestDirectory = join(fixture.root, "guest");
  const guestContext = {
    ...context,
    sessionsRoot: join(guestDirectory, "sessions"),
    player: guestPlayer,
  };
  await mkdir(guestContext.sessionsRoot, { recursive: true });
  let guest = new LanService(guestDirectory, async () => guestContext, router, options);
  const controller = new AbortController();
  try {
    const opening = host.online.host(room.id);
    await requested.promise;
    // 线上房间尚未就绪时，不能把准备中的房主误报为已开放的内网房间。
    assert.equal(host.status(room.id).hosting, false);
    assert.equal(host.status(room.id).online, null);
    release.resolve();
    const hosted = await opening;
    assert.equal(hosted.hosting, true);
    assert.equal(hosted.online?.code, "012345");
    assert.deepEqual(hosted.addresses, []);
    assert.equal((await guest.online.join(coordinator.code)).status, "pending");
    assert.equal(guest.remote(room.id), undefined);
    guest.online.cancelJoin(coordinator.code);
    for (let i = 0; i < 100 && host.status(room.id).pending.length; i++) await Bun.sleep(5);
    assert.equal(host.status(room.id).pending.length, 0);
    assert.equal((await guest.online.join(coordinator.code)).status, "pending");
    // 即使底层加密通道已建好，审批前仍不能读取游戏或资源。
    const pending = (
      guest.online as unknown as {
        guest: { link: import("@orpc/client/message-port").RPCLink<object> };
      }
    ).guest;
    const unauthorized = createORPCClient<RouterClient<typeof router>>(pending.link);
    await assert.rejects(unauthorized.game.chat.history({ roomId: room.id, limit: 10 }), {
      code: "FORBIDDEN",
    });
    const request = host.status(room.id).pending[0]!;
    assert.equal(request.nickname, guestPlayer.nickname);
    await host.decide(room.id, request.id, true);
    // 不再次 join，审批也必须原子地绑定玩家身份。
    const { saveRoomNotes } = await import("@jointarp/core/node/sessions/session-store");
    await saveRoomNotes(fixture.sessions, room.id, hostPlayer.id, "房主私密笔记");
    await assert.rejects(
      unauthorized.sessions.notes.get({ roomId: room.id, playerId: hostPlayer.id }),
      { code: "FORBIDDEN" },
    );
    assert.equal((await unauthorized.game.steering.get({ roomId: room.id })).isHost, false);
    assert.equal((await guest.online.join(coordinator.code)).status, "approved");
    const remote = guest.remote(room.id)!;
    const client = createORPCClient<RouterClient<typeof router>>(remote.link);
    assert.equal((await client.game.steering.get({ roomId: room.id })).isHost, false);
    const intruder = new LanService(
      join(fixture.root, "intruder"),
      async () => guestContext,
      router,
      options,
    );
    try {
      await assert.rejects(intruder.online.join(coordinator.code), { code: "FORBIDDEN" });
    } finally {
      intruder.close();
    }
    await assert.rejects(client.config.get(), { code: "FORBIDDEN" });
    await assert.rejects(client.game.chat.history({ roomId: randomUUID(), limit: 10 }), {
      code: "FORBIDDEN",
    });
    await assert.rejects(client.game.chat.setSubmissionMode({ roomId: room.id, mode: "manual" }), {
      code: "FORBIDDEN",
    });
    const resources = await guest.moduleResources(room.id);
    assert.equal(resources.room.id, room.id);
    const path = `/media/${encodeURIComponent(`room:${room.id}`)}?path=&image=transport.png`;
    const opened = await Promise.allSettled(
      Array.from({ length: 5 }, () => remote.request!(path, {})),
    );
    assert.equal(opened.filter((result) => result.status === "fulfilled").length, 4);
    for (const result of opened)
      if (result.status === "fulfilled") await result.value.body!.cancel();
    const cancelled = await remote.request!(path, {});
    await cancelled.body!.cancel();
    const response = await remote.request!(path, {});
    assert(Buffer.from(await response.arrayBuffer()).equals(image));
    const notModified = await remote.request!(path, {
      headers: { "If-None-Match": response.headers.get("ETag")! },
    });
    assert.equal(notModified.status, 304);
    const cached = await guest.media(
      `tarp://document/${encodeURIComponent(`room:${room.id}`)}?path=&image=transport.png`,
      "GET",
    );
    assert(Buffer.from(await cached!.arrayBuffer()).equals(image));
    await assert.rejects(remote.request!("/rpc", {}), { code: "FORBIDDEN" });
    assert.equal(
      (
        await remote.request!(
          `/media/${encodeURIComponent(`room:${randomUUID()}`)}?path=&image=transport.png`,
          {},
        )
      ).status,
      403,
    );
    await client.sessions.notes.save({
      roomId: room.id,
      playerId: guestPlayer.id,
      content: "原生连接笔记",
    });
    await assert.rejects(client.sessions.notes.get({ roomId: room.id, playerId: hostPlayer.id }), {
      code: "FORBIDDEN",
    });
    // 重建客户端，证明持久恢复凭证与个人笔记不依赖信令身份。
    guest.close();
    guest = new LanService(guestDirectory, async () => guestContext, router, options);
    assert.equal((await guest.online.join(coordinator.code)).status, "pending");
    await host.decide(room.id, host.status(room.id).pending[0]!.id, true);
    assert.equal((await guest.online.join(coordinator.code)).status, "approved");
    let restored = createORPCClient<RouterClient<typeof router>>(guest.remote(room.id)!.link);
    assert.equal(
      await restored.sessions.notes.get({ roomId: room.id, playerId: guestPlayer.id }),
      "原生连接笔记",
    );
    const previousRemote = guest.remote(room.id)!;
    const active = (
      guest.online as unknown as { guest: { peer: import("./native-peer").NativePeer } }
    ).guest;
    active.peer.close();
    assert.equal(guest.status(room.id).connection, "disconnected");
    assert(previousRemote.controller.signal.aborted);
    assert.equal((await guest.online.join(coordinator.code)).status, "pending");
    await host.decide(room.id, host.status(room.id).pending[0]!.id, true);
    assert.equal((await guest.online.join(coordinator.code)).status, "approved");
    assert.notEqual(guest.remote(room.id), previousRemote);
    restored = createORPCClient<RouterClient<typeof router>>(guest.remote(room.id)!.link);
    const history = await restored.game.chat.history({ roomId: room.id, limit: 10 });
    const subscription = await restored.game.room.subscribe(
      {
        roomId: room.id,
        protocolVersion: 1,
        baselineVersion: resources.baseline.version,
        afterChatCursor: 0,
        afterChatStreamId: history.streamId,
      },
      { signal: controller.signal },
    );
    const first = await subscription.next();
    assert.equal(first.done, false);
    coordinator.disconnect();
    const message = await restored.game.chat.send({
      roomId: room.id,
      clientMessageId: randomUUID(),
      text: "协调离线后仍直连",
      chatOnly: true,
    });
    assert(
      (await chat.history({ roomId: room.id, limit: 20 }, hostPlayer, true)).messages.some(
        (item) => item.id === message.id,
      ),
    );
    assert.equal(
      (await guest.moduleResources(room.id)).baseline.version,
      resources.baseline.version,
    );
    assert(
      coordinator.signals.every(
        (signal) => !signal.includes("协调离线后仍直连") && !signal.includes("原生连接笔记"),
      ),
    );
    controller.abort();
    await subscription.return?.().catch(() => undefined);
    host.stop(room.id);
    for (let i = 0; i < 100 && guest.status(room.id).connection !== "disconnected"; i++)
      await Bun.sleep(10);
    assert.equal(guest.status(room.id).connection, "disconnected");
    await assert.rejects(host.online.host(room.id));
    assert.equal(host.status(room.id).hosting, false);
    await assert.rejects(
      restored.game.steering.get({ roomId: room.id }, { signal: AbortSignal.timeout(1000) }),
    );
  } finally {
    release.resolve();
    controller.abort();
    guest.close();
    host.close();
    await coordinator.close();
    await chat.close();
    await fixture.cleanup();
  }
}, 20_000);

test("协调地址只允许 HTTPS 或本机回环 HTTP", () => {
  assert.equal(coordinatorUrl("https://example.com"), "https://example.com");
  for (const value of [
    "http://example.com",
    "https://x:secret@example.com",
    "https://example.com/path",
    "https://example.com?token=x",
  ])
    assert.throws(() => coordinatorUrl(value));
});

test("房主回收只建立加密通道而不认证的玩家，轮询不能延长审批期限", async () => {
  const { NativePeer } = await import("./native-peer");
  const { attachHost } = await import("./rooms");
  const { roomIdentity } = await import("./identity");
  const { RPCLink } = await import("@orpc/client/message-port");
  const { useFakeTimers, useRealTimers, advanceTimersByTimeAsync } =
    await import("@jointarp/module/testing/async");
  const fixture = await createTestModule();
  async function pair() {
    let host: InstanceType<typeof NativePeer> | undefined;
    const queued: import("./native-peer").PeerSignal[] = [];
    const player = new NativePeer({
      initiator: true,
      iceServers: [],
      onSignal: (signal) => {
        if (host) host.receiveSignal(signal);
        else queued.push(signal);
      },
    });
    host = new NativePeer({
      initiator: false,
      iceServers: [],
      onSignal: (signal) => player.receiveSignal(signal),
    });
    for (const signal of queued) host.receiveSignal(signal);
    await Promise.all([host.ready, host.resourcesReady, player.ready, player.resourcesReady]);
    return { host, player };
  }
  const peers: Awaited<ReturnType<typeof pair>>[] = [];
  try {
    const roomId = randomUUID();
    const player = { id: randomUUID(), nickname: "未审批玩家" };
    const members = new Map();
    const hosted = {
      roomId,
      context: { player: { id: randomUUID(), nickname: "房主" } },
      members,
      nativeOwners: new Map(),
      request: async () => new Response(null, { status: 403 }),
      admit: async (_player: unknown, proof: string) => {
        let member = members.get("token");
        if (!member) {
          member = {
            player,
            proof,
            token: "token",
            status: "pending",
            expires: Date.now() + 120_000,
          };
          members.set("token", member);
        }
        return { status: member.status, roomId, token: "token" };
      },
    } as unknown as import("../lan/service").Hosted;
    const idle = await pair();
    peers.push(idle);
    useFakeTimers();
    attachHost(hosted, idle.host, router);
    await advanceTimersByTimeAsync(15_001);
    assert(idle.host.isClosed);
    useRealTimers();
    const waiting = await pair();
    peers.push(waiting);
    assert.equal(waiting.host.identityBinding(), waiting.player.identityBinding());

    useFakeTimers();
    const contract = attachHost(hosted, waiting.host, router);
    const client = createORPCClient<{ connection: RouterClient<typeof contract>["connection"] }>(
      new RPCLink({ port: await waiting.player.ready }),
    );
    const challenge = await client.connection.challenge();
    const proof = await roomIdentity(fixture.root).prove(
      player,
      challenge,
      waiting.player.identityBinding(),
    );
    assert.equal((await client.connection.join(proof)).status, "pending");
    await advanceTimersByTimeAsync(60_000);
    assert.equal((await client.connection.join(proof)).status, "pending");
    await advanceTimersByTimeAsync(60_001);
    assert(waiting.host.isClosed);
    assert.equal(members.size, 0);
  } finally {
    useRealTimers();
    for (const peer of peers) {
      peer.host.close();
      peer.player.close();
    }
    await fixture.cleanup();
  }
}, 10_000);

test("旧服务欢迎消息或 ICE 请求失败时给出具体错误，不冒充打洞失败", async () => {
  for (const [options, message] of [
    [{ omitApproval: true }, "协调服务协议不匹配"],
    [{ iceStatus: 503 }, "协调服务请求失败（503）"],
  ] as const) {
    const fixture = coordinatorFixture(options);
    try {
      await assert.rejects(
        Coordinator.create(fixture.base, () => {}),
        (error: unknown) => error instanceof Error && error.message.includes(message),
      );
    } finally {
      await fixture.close();
    }
  }
});
