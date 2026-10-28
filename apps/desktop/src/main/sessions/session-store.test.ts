import { describe, it, onTestFinished } from "bun:test";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  beginAdventureEdit,
  commitAdventureEdit,
  updateAdventureState,
} from "@jointarp/core/node/sessions/adventure-state";
import { updateGameDocument } from "@jointarp/core/node/sessions/game-state";
import { roomDisplaySettings } from "@jointarp/core/node/sessions/room-display-settings";
import { readRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import { readAdventure } from "@jointarp/core/node/sessions/room-storage";
import {
  createSession,
  deleteSession,
  loadRoomNotes,
  openSessionDatabase,
  roomDirectory,
  saveRoomNotes,
  setSessionStatus,
} from "@jointarp/core/node/sessions/session-store";
import { writeTestFile as writeFile } from "@jointarp/module/testing/files";

import { documentMediaUrl } from "../../shared/document-media";
import { resolveMediaRequestFile } from "../media-path";
import {
  listLocalSessions as listSessions,
  loadLocalSession as loadSession,
} from "./local-room-resources";
import { LocalSessionLifecycle } from "./local-session-lifecycle";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tarp-session-"));
  const modulePath = join(root, "模组");
  const sessions = join(root, "sessions");
  await mkdir(join(modulePath, ".types"), { recursive: true });
  await writeFile(
    join(modulePath, ".types", "人物.fields.json"),
    JSON.stringify({
      name: "人物",
      fields: { hp: { type: "number", label: "生命", mutable: true } },
    }),
  );
  await writeFile(
    join(modulePath, "人物/向导.json"),
    JSON.stringify({ name: "向导", hp: 8, image: "向导.webp" }),
  );
  await writeFile(join(modulePath, "向导.webp"), "image fixture");
  await writeFile(
    join(modulePath, "module.json"),
    JSON.stringify({ name: "测试模组", description: "存档测试" }),
  );
  return { root, modulePath, sessions };
}

describe("游戏房存档", () => {
  it("支持结束、重新开启和永久删除冒险", async () => {
    const f = await fixture();
    try {
      const room = await createSession(f.sessions, f.modulePath, "生命周期测试");
      assert.equal(room.status, "active");

      const ended = await setSessionStatus(f.sessions, room.id, "ended");
      assert.equal(ended.status, "ended");
      assert.ok(ended.endedAt);
      assert.equal((await listSessions(f.sessions)).rooms[0].status, "ended");

      const reopened = await setSessionStatus(f.sessions, room.id, "active");
      assert.equal(reopened.status, "active");
      assert.equal(reopened.endedAt, undefined);

      await deleteSession(f.sessions, room.id);
      await assert.rejects(access(roomDirectory(f.sessions, room.id)), { code: "ENOENT" });
      assert.deepEqual(await listSessions(f.sessions), { rooms: [], issues: [] });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("宿主删除等待运行关闭，关闭失败时保留存档并关闭资料窗口", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    onTestFinished(async () => {
      release();
      await rm(f.root, { recursive: true, force: true });
    });
    const room = await createSession(f.sessions, f.modulePath, "宿主生命周期");
    const windows: string[] = [];
    let fail = true;
    const lifecycle = new LocalSessionLifecycle(
      f.sessions,
      {
        closeRoom: async () => {
          if (fail) throw new Error("关闭失败");
          entered();
          await waiting;
        },
      },
      (id) => windows.push(id),
    );
    await assert.rejects(lifecycle.remove(room.id), /关闭失败/);
    await access(roomDirectory(f.sessions, room.id));
    assert.deepEqual(windows, [room.id]);
    fail = false;
    const removal = lifecycle.remove(room.id);
    await started;
    await access(roomDirectory(f.sessions, room.id));
    release();
    await removal;
    await assert.rejects(access(roomDirectory(f.sessions, room.id)), { code: "ENOENT" });
  });

  it("新房间保存完整只读模组副本，包含隐藏文件、附件和空目录，跳过所有符号链接", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.modulePath, ".hidden", "empty"), { recursive: true });
      await writeFile(join(f.modulePath, ".hidden", "attachment.bin"), Buffer.from([0, 255, 3]));
      await writeFile(join(f.modulePath, "AGENTS.md"), "# 模组说明\n");
      await symlink(f.root, join(f.modulePath, "outside"));
      await symlink(f.modulePath, join(f.modulePath, "loop"));
      await symlink(join(f.modulePath, "向导.webp"), join(f.modulePath, "linked.webp"));
      await symlink(join(f.root, "missing"), join(f.modulePath, "broken"));
      const room = await createSession(f.sessions, f.modulePath, "完整副本");
      const directory = roomDirectory(f.sessions, room.id);
      const copy = join(directory, "module");
      const stored = JSON.parse(await readFile(join(directory, "adventure.json"), "utf8"));
      assert.equal(stored.room.id, room.id);
      assert.deepEqual(Object.keys(stored).sort(), [
        "contextSubscriptions",
        "launch",
        "notes",
        "party",
        "room",
      ]);
      assert.deepEqual(stored.contextSubscriptions, {});
      const selection = stored;
      assert.deepEqual(Object.keys(selection.launch).sort(), ["players", "state"]);
      assert.deepEqual(Object.keys(selection.party).sort(), [
        "characters",
        "companions",
        "members",
      ]);
      assert.equal(readRoomSettings(directory).ai, null);
      assert.ok(Array.isArray(selection.party.characters));
      assert.equal(room.moduleName, "测试模组");
      for (const file of [
        "人物/向导.json",
        "向导.webp",
        ".types/人物.fields.json",
        ".hidden/attachment.bin",
        "AGENTS.md",
      ]) {
        assert.deepEqual(
          await readFile(join(copy, file)),
          await readFile(join(f.modulePath, file)),
        );
        assert.equal((await lstat(join(copy, file))).mode & 0o222, 0);
      }
      assert.ok((await lstat(join(copy, ".hidden", "empty"))).isDirectory());
      for (const file of ["outside", "loop", "linked.webp", "broken"]) {
        await assert.rejects(lstat(join(copy, file)), { code: "ENOENT" });
      }
      await writeFile(join(f.modulePath, "向导.webp"), "changed");
      assert.equal(await readFile(join(copy, "向导.webp"), "utf8"), "image fixture");
      const db = await openSessionDatabase(f.sessions, room.id);
      try {
        db.sqlite.exec("CREATE TABLE writable_probe (value TEXT)");
        db.sqlite.prepare("INSERT INTO writable_probe VALUES (?)").run("可写");
      } finally {
        db.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("笔记按房间和玩家隔离，列表、笔记与设置不依赖 SQLite，缺失数据库不会被重建", async () => {
    const f = await fixture();
    const playerId = randomUUID();
    const otherPlayerId = randomUUID();
    try {
      const first = await createSession(f.sessions, f.modulePath, "笔记 A");
      const second = await createSession(f.sessions, f.modulePath, "笔记 B");
      assert.equal(await loadRoomNotes(f.sessions, first.id, playerId), "");
      await Promise.all([
        saveRoomNotes(f.sessions, first.id, playerId, "线索一\n旧宅的门牌号"),
        saveRoomNotes(f.sessions, first.id, otherPlayerId, "另一玩家的秘密"),
        saveRoomNotes(f.sessions, second.id, playerId, "另一房间的秘密"),
      ]);

      assert.equal(await loadRoomNotes(f.sessions, first.id, playerId), "线索一\n旧宅的门牌号");
      assert.equal(await loadRoomNotes(f.sessions, first.id, otherPlayerId), "另一玩家的秘密");
      assert.equal(await loadRoomNotes(f.sessions, second.id, playerId), "另一房间的秘密");
      assert.equal(await loadRoomNotes(f.sessions, second.id, otherPlayerId), "");
      // 选角草稿延迟提交时，设置和笔记已保存的新值必须保留。
      const db = await openSessionDatabase(f.sessions, first.id);
      try {
        beginAdventureEdit(db);
        updateAdventureState(db, (selection) => {
          selection.party.companions.push({ id: "测试队友", status: "empty" });
        });
        await roomDisplaySettings(f.sessions, first.id, { showReasoning: true });
        await saveRoomNotes(f.sessions, first.id, playerId, "草稿期间保存的笔记");
        commitAdventureEdit(db);
        const stored = readAdventure(join(f.sessions, first.id));
        assert.equal(stored.notes[playerId], "草稿期间保存的笔记");
        assert.equal(stored.notes[otherPlayerId], "另一玩家的秘密");
        assert.equal(readRoomSettings(join(f.sessions, first.id)).display.showReasoning, true);
        assert.equal(stored.party.companions[0].id, "测试队友");
      } finally {
        db.close();
      }
      await rm(join(f.sessions, first.id, "session.sqlite"));
      assert.equal((await listSessions(f.sessions)).rooms.length, 2);
      assert.deepEqual(
        await roomDisplaySettings(f.sessions, first.id, {
          showReasoning: undefined,
          showAllDocuments: true,
        }),
        { showReasoning: true, showAllDocuments: true },
      );
      assert.deepEqual(
        await roomDisplaySettings(f.sessions, first.id, {
          showReasoning: false,
          showAllDocuments: undefined,
        }),
        { showReasoning: false, showAllDocuments: true },
      );
      assert.equal((await setSessionStatus(f.sessions, first.id, "ended")).status, "ended");
      await assert.rejects(openSessionDatabase(f.sessions, first.id), { code: "ENOENT" });
      await assert.rejects(access(join(f.sessions, first.id, "session.sqlite")), {
        code: "ENOENT",
      });
      await saveRoomNotes(f.sessions, first.id, playerId, "更新后的笔记");
      assert.equal(await loadRoomNotes(f.sessions, first.id, playerId), "更新后的笔记");
      assert.equal(await loadRoomNotes(f.sessions, first.id, otherPlayerId), "另一玩家的秘密");
      assert.equal(await loadRoomNotes(f.sessions, second.id, playerId), "另一房间的秘密");
      const state = JSON.parse(
        await readFile(join(f.sessions, first.id, "adventure.json"), "utf8"),
      );
      assert.equal(state.room.id, first.id);
      assert.deepEqual(state.notes, {
        [playerId]: "更新后的笔记",
        [otherPlayerId]: "另一玩家的秘密",
      });
      await saveRoomNotes(f.sessions, first.id, playerId, "");
      assert.equal(await loadRoomNotes(f.sessions, first.id, playerId), "");
      assert.equal(await loadRoomNotes(f.sessions, first.id, otherPlayerId), "另一玩家的秘密");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("拒绝链接房间、数据库和副本目录，不触及外部文件", async () => {
    const f = await fixture();
    try {
      const room = await createSession(f.sessions, f.modulePath, "路径边界");
      const directory = roomDirectory(f.sessions, room.id);
      assert.throws(() => roomDirectory(f.sessions, "../escape"), /ID/);
      await rename(directory, join(f.root, "external-room"));
      await symlink(join(f.root, "external-room"), directory);
      await assert.rejects(openSessionDatabase(f.sessions, room.id), /目录/);
      await rm(directory);
      await rename(join(f.root, "external-room"), directory);
      for (const name of ["adventure.json", "session.sqlite", "module"]) {
        await rename(join(directory, name), join(f.root, name));
        await symlink(join(f.root, name), join(directory, name));
        await assert.rejects(openSessionDatabase(f.sessions, room.id), /路径|目录/);
        await rm(join(directory, name));
        await rename(join(f.root, name), join(directory, name));
      }
      await symlink(join(directory, "session.sqlite"), join(directory, "session.sqlite-wal"));
      await assert.rejects(openSessionDatabase(f.sessions, room.id), /路径/);
      await rm(join(directory, "session.sqlite-wal"));
      const configPath = join(directory, "adventure.json");
      const source = await readFile(configPath, "utf8");
      const mismatched = JSON.parse(source);
      mismatched.room.id = randomUUID();
      const damaged = JSON.stringify(mismatched);
      await writeFile(configPath, damaged);
      await assert.rejects(openSessionDatabase(f.sessions, room.id), /ID/);
      assert.deepEqual(await listSessions(f.sessions), { rooms: [], issues: [] });
      assert.equal(await readFile(configPath, "utf8"), damaged);
      await writeFile(configPath, source);
      assert.equal((await loadSession(f.sessions, room.id)).room.id, room.id);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("拒绝在源模组内创建房间副本并清理 staging", async () => {
    const f = await fixture();
    try {
      const nested = join(f.modulePath, "sessions");
      await assert.rejects(createSession(nested, f.modulePath, "递归副本"), /源模组/);
      assert.deepEqual(await readdir(nested), []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("同模组多次开局使用独立数据库，删除原模组后仍可读取快照", async () => {
    const f = await fixture();
    try {
      const first = await createSession(f.sessions, f.modulePath, "第一局");
      const second = await createSession(f.sessions, f.modulePath, "第二局");
      assert.notEqual(first.id, second.id);
      for (const room of [first, second]) {
        await access(join(f.sessions, room.id, "session.sqlite"));
      }
      const firstDb = await openSessionDatabase(f.sessions, first.id);
      await updateGameDocument(firstDb, join(f.sessions, first.id, "game"), {
        path: "人物/向导.json",
        changes: [{ op: "set", path: "/hp", value: 3 }],
      });
      firstDb.close();
      await rm(f.modulePath, { recursive: true });
      const loaded = await loadSession(f.sessions, first.id);
      const other = await loadSession(f.sessions, second.id);
      assert.equal(loaded.documents[0].values?.hp, 3);
      assert.equal(other.documents[0].values?.hp, 8);
      const image = await resolveMediaRequestFile(
        documentMediaUrl(`room:${second.id}`, other.documents[0].path, other.documents[0].image)!,
      );
      assert.equal(image, await realpath(join(f.sessions, second.id, "module", "向导.webp")));
      await access(image!);
      const listed = await listSessions(f.sessions);
      assert.equal(listed.rooms.length, 2);
      assert.equal(listed.issues.length, 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("房间冻结封面、元数据、阅读页和规则，原模组修改或删除后仍可读取", async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.modulePath, "图片"));
      await writeFile(join(f.modulePath, "图片/封面.png"), "cover");
      await writeFile(join(f.modulePath, "图片/主持头像.png"), "avatar");
      await writeFile(
        join(f.modulePath, ".types/规则.fields.json"),
        JSON.stringify({ name: "核心规则" }),
      );
      await writeFile(
        join(f.modulePath, "规则/伤害.md"),
        "---\nname: 伤害\n---\n\n从耐久里扣除。\n",
      );
      await writeFile(
        join(f.modulePath, "玩家手册.md"),
        "---\nname: 玩家手册\n---\n\n直接说明行动。\n",
      );
      const metadata = {
        name: "后山",
        description: "墓门开了。",
        cover: "图片/封面.png",
        host: { name: "引路人", avatar: "图片/主持头像.png" },
        system: "石冢",
        author: "测试",
        version: "1.0.0",
        tags: ["地穴"],
        pages: ["玩家手册.md"],
      };
      await writeFile(join(f.modulePath, "module.json"), JSON.stringify(metadata));
      const room = await createSession(f.sessions, f.modulePath, "冻结资料");
      await writeFile(join(f.modulePath, "玩家手册.md"), "已被改写。\n");
      await writeFile(join(f.modulePath, "module.json"), JSON.stringify({ name: "后来改名" }));
      const loaded = await loadSession(f.sessions, room.id);
      assert.deepEqual(loaded.module, {
        name: metadata.name,
        description: metadata.description,
        cover: metadata.cover,
        hostName: metadata.host.name,
        hostAvatar: metadata.host.avatar,
        system: metadata.system,
        author: metadata.author,
        version: metadata.version,
        tags: metadata.tags,
      });
      assert.deepEqual(
        loaded.pages.map(({ path, title, body }) => ({ path, title, body })),
        [{ path: "玩家手册.md", title: "玩家手册", body: "直接说明行动。" }],
      );
      const rule = loaded.documents.find((document) => document.path === "规则/伤害.json");
      assert.equal(rule?.title, "伤害");
      assert.equal(rule?.body?.trim(), "从耐久里扣除。");
      const scope = `room-module:${room.id}`;
      const cover = await resolveMediaRequestFile(
        documentMediaUrl(scope, "", loaded.module.cover)!,
      );
      assert.equal(cover, await realpath(join(f.sessions, room.id, "module/图片/封面.png")));
      await access(cover!);
      const avatar = await resolveMediaRequestFile(
        documentMediaUrl(scope, "", loaded.module.hostAvatar)!,
      );
      assert.equal(avatar, await realpath(join(f.sessions, room.id, "module/图片/主持头像.png")));
      // 房间角色可以使用 game 覆盖，模组封面和主持头像始终读取冻结副本。
      await mkdir(join(f.sessions, room.id, "game/图片"), { recursive: true });
      await writeFile(join(f.sessions, room.id, "game/图片/封面.png"), "游戏覆盖");
      await writeFile(join(f.sessions, room.id, "game/图片/主持头像.png"), "游戏覆盖");
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "", loaded.module.cover)!),
        cover,
      );
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "", loaded.module.hostAvatar)!),
        avatar,
      );
      await rm(f.modulePath, { recursive: true });
      assert.deepEqual(await loadSession(f.sessions, room.id), loaded);
      const listed = await listSessions(f.sessions);
      assert.equal(listed.rooms[0]?.cover, metadata.cover);
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "", listed.rooms[0]?.cover)!),
        cover,
      );
      // 图片缺失不影响房间读取，协议返回缺失，由展示层显示占位。
      await rm(cover!);
      assert.equal((await loadSession(f.sessions, room.id)).module.cover, metadata.cover);
      assert.equal(
        await resolveMediaRequestFile(documentMediaUrl(scope, "", metadata.cover)!),
        undefined,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("拒绝越界房间和缺失房间", async () => {
    const f = await fixture();
    try {
      const room = await createSession(f.sessions, f.modulePath, "安全存档");
      const before = await loadSession(f.sessions, room.id);
      await assert.rejects(loadSession(f.sessions, "../escape"));
      await assert.rejects(loadSession(f.sessions, "00000000-0000-4000-8000-000000000000"));
      assert.deepEqual(await loadSession(f.sessions, room.id), before);
      const listed = await listSessions(f.sessions);
      assert.equal(listed.rooms[0]?.id, room.id);
      assert.equal(listed.issues.length, 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("无效模组不创建房间", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.modulePath, "人物/向导.json"), "{broken");
      await assert.rejects(createSession(f.sessions, f.modulePath, "失败开局"), /修复/);
      assert.deepEqual(await listSessions(f.sessions), { rooms: [], issues: [] });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
