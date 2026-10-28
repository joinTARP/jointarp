import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageChannel } from "node:worker_threads";

import { ChatService, gameRouter } from "@jointarp/core/node";
import { createSession } from "@jointarp/core/node/sessions/session-store";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createORPCClient } from "@orpc/client";
import { RPCLink as PortLink } from "@orpc/client/message-port";
import { os, type RouterClient } from "@orpc/server";
import { RPCHandler as PortHandler } from "@orpc/server/message-port";
import { z } from "zod";

import type { DesktopRpcContext } from "../desktop-rpc-context";
import { createMediaServer } from "../media-protocol";
import { loadLocalSessionModuleResources } from "../sessions/local-room-resources";
import { roomNotesRouter } from "../sessions/room-notes-router";
import { lanForwarder } from "./forwarder";
import { LanService, lanAddress } from "./service";

const procedure = os.$context<DesktopRpcContext>();
const router = {
  game: gameRouter,
  sessions: {
    notes: roomNotesRouter,
    module: {
      resources: procedure
        .input(z.object({ roomId: z.string().uuid() }))
        .handler(({ context, input }) =>
          loadLocalSessionModuleResources(context.sessionsRoot, input.roomId),
        ),
    },
  },
  config: {
    get: procedure.handler(() => {
      throw new Error("不应执行本机配置操作");
    }),
  },
};

test("完全离线：开局前入房、审批、双向聊天与订阅、私有笔记、图片、重连及关闭权限", async () => {
  const root = await mkdtemp(join(tmpdir(), "tarp-lan-"));
  const hostDir = join(root, "host");
  const sessionsRoot = join(hostDir, "sessions");
  const module = join(root, "module");
  await writeFile(
    join(module, "module.json"),
    JSON.stringify({
      name: "内网测试",
      description: "离线连接测试",
      gameStarts: [
        {
          id: "start",
          name: "出发",
          description: "同行",
          characterTypeIds: ["角色"],
          playablePaths: ["角色/甲.json", "角色/乙.json"],
          allowCreate: false,
          opening: { mode: "scripted", beats: [{ text: "冒险已经开始。" }] },
        },
      ],
    }),
  );
  await writeFile(join(module, ".types", "规则.fields.json"), "{}");
  await writeFile(join(module, "规则", "开始.md"), "一起开始冒险");
  await writeFile(join(module, "test.png"), "local image");
  await writeFile(
    join(module, ".types", "角色.fields.json"),
    JSON.stringify({ designation: "character", fields: {} }),
  );
  await writeFile(join(module, "角色", "甲.json"), JSON.stringify({ name: "甲" }));
  await writeFile(join(module, "角色", "乙.json"), JSON.stringify({ name: "乙" }));
  const room = await createSession(sessionsRoot, module, "离线联机");
  const chat = new ChatService(sessionsRoot, { run: async () => {} }, async () => {
    throw new Error("测试禁止访问模型网络");
  });
  const hostPlayer = { id: randomUUID(), nickname: "房主" };
  const guestPlayer = { id: randomUUID(), nickname: "访客" };
  const context = { sessionsRoot, player: hostPlayer, chat, isHost: true } as DesktopRpcContext;
  const host = new LanService(hostDir, async () => context, router);
  const guestDir = join(root, "guest");
  await mkdir(join(guestDir, "sessions"), { recursive: true });
  const guest = new LanService(
    guestDir,
    async () => ({ ...context, sessionsRoot: join(guestDir, "sessions"), player: guestPlayer }),
    router,
  );
  const media = createMediaServer((source, method) => guest.media(source, method));
  let stream: AsyncIterator<unknown> | undefined;
  const controller = new AbortController();
  const ports = new MessageChannel();
  try {
    await host.host(room.id);
    // 回环地址仍经过真实 HTTP / WebSocket，不需要路由器或公网。
    const address = `127.0.0.1:${(host as unknown as { hosted: { server: { port: number } } }).hosted.server.port}`;
    const base = `http://${address}`;
    assert.equal((await fetch(`${base}/rpc`)).status, 403);
    assert.equal((await fetch(`${base}/module/manifest`)).status, 403);
    assert.equal(
      (await fetch(`${base}/join`, { method: "POST", headers: { Origin: "https://example.com" } }))
        .status,
      403,
    );
    assert.equal((await guest.join(address)).status, "pending");
    assert.equal(guest.remote(room.id), undefined);
    const request = host.status(room.id).pending[0]!;
    assert.equal(
      (
        await fetch(`${base}/module/manifest`, {
          headers: { Authorization: `Bearer ${request.id}` },
        })
      ).status,
      403,
    );
    assert.equal(request.nickname, "访客");
    await host.decide(room.id, request.id, true);
    assert.equal((await guest.join(address)).status, "approved");
    const remote = guest.remote(room.id)!;
    const direct: RouterClient<typeof router> = createORPCClient(remote.link);
    new PortHandler(router, { clientInterceptors: [lanForwarder] }).upgrade(ports.port1, {
      context: { ...context, player: guestPlayer, lan: guest },
    });
    const client: RouterClient<typeof router> = createORPCClient(
      new PortLink({ port: ports.port2 }),
    );
    assert.equal((await client.game.steering.get({ roomId: room.id })).isHost, false);
    await assert.rejects(direct.config.get(), { code: "FORBIDDEN" });
    await assert.rejects(direct.game.chat.history({ roomId: randomUUID(), limit: 10 }), {
      code: "FORBIDDEN",
    });
    await assert.rejects(client.game.chat.setSubmissionMode({ roomId: room.id, mode: "manual" }), {
      code: "FORBIDDEN",
    });
    const beforeOpening = (await client.game.launch.get({ roomId: room.id }))!;
    assert.notEqual(beforeOpening.room.opening, "complete");
    const earlyResources = await client.sessions.module.resources({ roomId: room.id });
    assert.equal(earlyResources.room.id, room.id);
    await assert.rejects(client.game.launch.open({ roomId: room.id }), { code: "FORBIDDEN" });
    // 玩家已经入房，房主再完成开局，原连接持续可用。
    const arrived = await chat.history({ roomId: room.id, limit: 20 }, hostPlayer, true);
    const ready = arrived.messages.find(
      (message) => message.kind === "card" && message.card.type === "ready",
    );
    assert(ready);
    await chat.confirmReady(room.id, hostPlayer, ready.id);
    await client.game.launch.confirmReady({ roomId: room.id, messageId: ready.id });
    let launch = (await chat.launchState(room.id, hostPlayer))!;
    launch = (await chat.advanceLaunch(
      {
        roomId: room.id,
        revision: launch.progress.revision,
        roomRevision: launch.room.revision,
        action: "select",
        characterId: launch.characterIds[0],
      },
      hostPlayer,
    ))!;
    launch = (await chat.advanceLaunch(
      {
        roomId: room.id,
        revision: launch.progress.revision,
        roomRevision: launch.room.revision,
        action: "confirm",
      },
      hostPlayer,
    ))!;
    if (launch.room.companionSetup?.stage === "prompt") {
      launch = (await chat.advanceLaunch(
        {
          roomId: room.id,
          revision: launch.progress.revision,
          roomRevision: launch.room.revision,
          action: "beginAdventure",
        },
        hostPlayer,
      ))!;
    }
    assert.equal(launch.room.opening, "complete");
    let guestLaunch = (await client.game.launch.get({ roomId: room.id }))!;
    assert.equal(guestLaunch.room.opening, "complete");
    const guestCharacter = guestLaunch.characterIds.find(
      (id) => id !== launch.progress.characterId,
    )!;
    guestLaunch = (await client.game.launch.advance({
      roomId: room.id,
      revision: guestLaunch.progress.revision,
      roomRevision: guestLaunch.room.revision,
      action: "select",
      characterId: guestCharacter,
    }))!;
    guestLaunch = (await client.game.launch.advance({
      roomId: room.id,
      revision: guestLaunch.progress.revision,
      roomRevision: guestLaunch.room.revision,
      action: "confirm",
    }))!;
    assert.equal(guestLaunch.progress.confirmed, true);
    assert.equal(guestLaunch.progress.characterId, guestCharacter);
    const resources = await client.sessions.module.resources({ roomId: room.id });
    const history = await client.game.chat.history({ roomId: room.id, limit: 10 });
    stream = await client.game.room.subscribe(
      {
        roomId: room.id,
        protocolVersion: 1,
        baselineVersion: resources.baseline.version,
        afterChatCursor: 0,
        afterChatStreamId: history.streamId,
      },
      { signal: controller.signal },
    );
    const first = await stream.next();
    assert.equal(first.done, false);
    const notification = first.value as { type: string; delivery: { id: string; seq: number } };
    assert.equal(notification.type, "state");
    await client.game.room.acknowledge({
      roomId: room.id,
      subscriptionId: notification.delivery.id,
      sequence: notification.delivery.seq,
    });
    const message = await client.game.chat.send({
      roomId: room.id,
      clientMessageId: randomUUID(),
      text: "来自离线访客",
      chatOnly: true,
    });
    assert.equal(message.kind, "player");
    const hostHistory = await chat.history({ roomId: room.id, limit: 20 }, hostPlayer, true);
    assert(hostHistory.messages.some((entry) => entry.id === message.id));
    const hostMessage = await chat.send(
      { roomId: room.id, clientMessageId: randomUUID(), text: "来自房主", chatOnly: true },
      hostPlayer,
    );
    const guestHistory = await client.game.chat.history({ roomId: room.id, limit: 20 });
    assert(guestHistory.messages.some((entry) => entry.id === hostMessage.id));
    await client.sessions.notes.save({
      roomId: room.id,
      playerId: guestPlayer.id,
      content: "访客的线索",
    });
    assert.equal(
      await client.sessions.notes.get({ roomId: room.id, playerId: guestPlayer.id }),
      "访客的线索",
    );
    await assert.rejects(client.sessions.notes.get({ roomId: room.id, playerId: hostPlayer.id }), {
      code: "FORBIDDEN",
    });
    const image = `${media.base}${encodeURIComponent(`room:${room.id}`)}?path=&image=test.png`;
    assert.equal(await (await fetch(image)).text(), "local image");
    assert.equal((await fetch(image, { method: "HEAD" })).status, 200);
    await writeFile(join(root, "outside.png"), "private");
    await symlink(join(root, "outside.png"), join(sessionsRoot, room.id, "game", "escape.png"));
    assert.equal((await fetch(image.replace("test.png", "escape.png"))).status, 404);
    assert.equal((await fetch(image.replace("test.png", "../../outside.png"))).status, 404);
    const auth = { Authorization: `Bearer ${remote.token}` };
    const hostImage = `${base}/media/${encodeURIComponent(`room:${room.id}`)}?path=&image=test.png`;
    const originalImage = await fetch(hostImage, { headers: auth });
    const etag = originalImage.headers.get("ETag");
    assert(etag);
    const conditional = await fetch(hostImage, { headers: { ...auth, "If-None-Match": etag } });
    assert.equal(conditional.status, 304);
    assert.equal((await conditional.arrayBuffer()).byteLength, 0);
    await writeFile(join(sessionsRoot, room.id, "game", "test.png"), "updated image");
    const overridden = await fetch(hostImage, { headers: { ...auth, "If-None-Match": etag } });
    assert.equal(overridden.status, 200);
    assert.equal(await overridden.text(), "updated image");
    assert.equal(await (await fetch(image)).text(), "updated image");
    assert.equal(
      (
        await fetch(
          `${base}/media/${encodeURIComponent(`room:${randomUUID()}`)}?path=&image=test.png`,
          { headers: auth },
        )
      ).status,
      403,
    );
    remote.socket?.close();
    await Bun.sleep(20);
    assert.equal((await client.game.steering.get({ roomId: room.id })).isHost, false);
    assert.equal(
      (await client.game.launch.get({ roomId: room.id }))?.progress.characterId,
      guestCharacter,
    );
    const { roomIdentity, challengeSchema } = await import("../online/identity");
    const impostor = roomIdentity(join(root, "impostor"));
    for (const player of [guestPlayer, hostPlayer]) {
      const challenge = challengeSchema.parse(await (await fetch(`${base}/challenge`)).json());
      const proof = await impostor.prove(player, challenge, "lan");
      const response = await fetch(`${base}/join`, { method: "POST", body: JSON.stringify(proof) });
      assert.equal(response.status, 403);
    }
    controller.abort();
    guest.stop(room.id);
    await Bun.sleep(30);
    assert.equal(
      (
        await fetch(`${base}/media/${encodeURIComponent(`room:${room.id}`)}?path=&image=test.png`, {
          headers: auth,
        })
      ).status,
      403,
    );
    assert.equal((await guest.join(address)).status, "approved");
    assert.equal(
      (await chat.companionSettings(room.id)).members.find((member) => member.id === guestPlayer.id)
        ?.online,
      false,
    );
    assert.equal((await guest.recent())[0]?.roomId, room.id);
    assert.equal((await guest.recent())[0]?.name, "离线联机");
    guest.stop(room.id);
    host.stop(room.id);
    assert.equal(host.status(room.id).hosting, false);
    assert.equal(guest.status(room.id).remote, false);
    const restored = new LanService(
      guestDir,
      async () => ({ ...context, sessionsRoot: join(guestDir, "sessions"), player: guestPlayer }),
      router,
    );
    try {
      await host.host(room.id);
      const reopened = `127.0.0.1:${(host as unknown as { hosted: { server: { port: number } } }).hosted.server.port}`;
      assert.equal((await restored.recent())[0]?.roomId, room.id);
      await assert.rejects(restored.join(reopened, undefined, randomUUID()), /另一个房间/);
      assert.equal((await restored.join(reopened, undefined, room.id)).status, "approved");
      assert.equal((await restored.recent()).length, 1);
      const restoredClient: RouterClient<typeof router> = createORPCClient(
        restored.remote(room.id)!.link,
      );
      assert.equal(
        (await restoredClient.game.launch.get({ roomId: room.id }))?.progress.characterId,
        guestCharacter,
      );
      assert.equal(
        await restoredClient.sessions.notes.get({ roomId: room.id, playerId: guestPlayer.id }),
        "访客的线索",
      );
      const restoredResources = await restored.moduleResources(room.id);
      assert.equal(restoredResources.baseline.version, resources.baseline.version);
      await restored.forgetRecent(room.id);
      assert.deepEqual(await restored.recent(), []);
      assert(restored.remote(room.id), "移除本机记录不应断开当前连接");
      assert.equal(
        (await restoredClient.game.launch.get({ roomId: room.id }))?.progress.characterId,
        guestCharacter,
      );
      await host.removeMember(room.id, guestPlayer.id);
      assert.equal(
        (await chat.companionSettings(room.id)).members.some(
          (member) => member.id === guestPlayer.id,
        ),
        false,
      );
      await assert.rejects(restored.moduleResources(room.id));
      restored.stop(room.id);
      assert.equal((await restored.join(reopened)).status, "pending");
      await host.decide(room.id, host.status(room.id).pending[0]!.id, false);
      assert.equal((await restored.join(reopened)).status, "rejected");
      host.stop(room.id);
      await assert.rejects(restored.moduleResources(room.id));
      await assert.rejects(
        restoredClient.game.launch.get({ roomId: room.id }, { signal: AbortSignal.timeout(1000) }),
      );
    } finally {
      restored.close();
    }
  } finally {
    controller.abort();
    ports.port1.close();
    ports.port2.close();
    if (stream) await stream.return?.().catch(() => undefined);
    host.close();
    guest.close();
    await media.close();
    await chat.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("内网地址拒绝公网、域名、凭据、路径及非规范 IPv4", () => {
  assert.equal(lanAddress(" 192.168.1.2:9876 "), "http://192.168.1.2:9876");
  for (const address of [
    "8.8.8.8:80",
    "localhost:80",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.1:80",
    "0177.0.0.1:80",
    "192.168.1.2:80/path",
    "user@192.168.1.2:80",
  ])
    assert.throws(() => lanAddress(address));
});
