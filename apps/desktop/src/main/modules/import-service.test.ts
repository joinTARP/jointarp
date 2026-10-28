import { test } from "bun:test";
import { strict as assert } from "node:assert";

import { waitFor } from "@jointarp/module/testing/async";
import {
  githubRepository,
  parseModuleImportLink,
  moduleImportArgument,
} from "@shared/module-import";

import { windowsProtocolCommand } from "../import-protocol";
import { ExistingGitModuleError } from "./import-git-module";
import { ModuleImportService } from "./import-service";

test("本地来源选择期间不开始导入，取消后可重选，选定后才进入导入状态", async () => {
  let directoryReads = 0;
  const service = new ModuleImportService(async () => {
    directoryReads++;
    return "/library";
  });
  let select!: (path: string | null) => void;
  let finish!: () => void;
  let imports = 0;
  const run = async (directory: string, path: string) => {
    imports++;
    assert.equal(directory, "/library");
    assert.equal(path, "/tmp/module.zip");
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { path: "/library/module", name: "测试模组" };
  };
  const choose = () => new Promise<string | null>((resolve) => (select = resolve));
  const canceled = service.local("ZIP 文件", choose, run);
  assert.equal(service.get().status, "selecting");
  assert.equal(directoryReads, 0);
  assert.equal(imports, 0);
  assert.throws(() => service.start({ url: "https://github.com/a/b.git" }), /稍后重试/);
  await assert.rejects(service.local("文件夹", choose, run), /稍后重试/);
  service.dismiss(service.get().id);
  service.report(new Error("不能打断选择"));
  assert.equal(service.get().status, "selecting");
  select(null);
  assert.equal(await canceled, null);
  assert.equal(service.get().status, "idle");
  assert.equal(directoryReads, 0);
  assert.equal(imports, 0);

  const importing = service.local("ZIP 文件", choose, run);
  select("/tmp/module.zip");
  await waitFor(() => assert.equal(imports, 1));
  assert.equal(service.get().status, "running");
  assert.equal(directoryReads, 1);
  finish();
  assert.deepEqual(await importing, { path: "/library/module", name: "测试模组" });
  assert.equal(service.get().status, "success");
});

test("官网链接仅接受 GitHub 仓库与提醒版本，不能注入路径、分支或命令", () => {
  const revision = "a".repeat(40);
  assert.deepEqual(
    parseModuleImportLink(`tarp://import?repository=Author%2FRepo&revision=${revision}`),
    { url: "https://github.com/author/repo.git", revision },
  );
  for (const value of [
    "tarp://document/test",
    "https://github.com/a/b",
    "tarp://import?repository=../repo",
    "tarp://import?repository=a/b/c",
    "tarp://import?repository=a/b&ref=main",
    "tarp://import?repository=a/b&repository=c/d",
    "tarp://import?repository=a/b&revision=main",
    "tarp://import?repository=a%2Fb%0A--upload-pack=evil",
    "tarp://evil@import?repository=a/b",
    "tarp://import?repository=a/b#fragment",
  ])
    assert.throws(() => parseModuleImportLink(value), Error, value);
  assert.equal(
    moduleImportArgument(["tarp://import?repository=a%2Fb"]),
    "tarp://import?repository=a%2Fb",
  );
  assert.equal(
    moduleImportArgument(["module", "validate", "tarp://import?repository=a/b"]),
    undefined,
  );
  assert.equal(moduleImportArgument([]), undefined);
  for (const origin of [
    "https://github.com/Author/Repo.git",
    "git@github.com:author/repo.git",
    "ssh://git@github.com/AUTHOR/repo.git",
  ])
    assert.equal(githubRepository(origin), "author/repo");
  assert.notEqual(
    githubRepository("https://github.com/other/repo"),
    githubRepository("https://github.com/author/repo"),
  );
  assert.equal(
    windowsProtocolCommand("C:\\用户 文件\\TARP\\launcher.exe"),
    '"C:\\用户 文件\\TARP\\launcher.exe" "%1"',
  );
  assert.throws(() => windowsProtocolCommand('C:\\bad" path\\launcher.exe'));
});

test("导入互斥、替换确认取消、失败重试与官网版本提醒", async () => {
  let complete!: () => void;
  const gate = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const service = new ModuleImportService(
    async () => "/library",
    async (_directory, input) => {
      calls++;
      if (calls === 1) {
        await gate;
        throw new ExistingGitModuleError("/library/author--repo");
      }
      if (calls === 2) throw new ExistingGitModuleError("/library/author--repo");
      if (calls === 3) {
        assert.equal(input.replacePath, "/library/author--repo");
        throw new Error("网络中断");
      }
      return { path: "/library/author--repo/module", name: "测试冒险", revision: "b".repeat(40) };
    },
  );
  const request = { url: "https://github.com/author/repo.git", revision: "a".repeat(40) };
  service.start(request);
  assert.throws(() => service.start(request), /稍后重试/);
  assert.equal(service.get().busyNotice, 1);
  await assert.rejects(
    service.local(
      "ZIP",
      async () => assert.fail("忙碌时不能打开选择器"),
      async () => assert.fail("忙碌时不能导入"),
    ),
    /稍后重试/,
  );
  complete();
  await waitFor(() => assert.equal(service.get().status, "confirm"));
  const oldId = service.get().id;
  service.confirm(oldId, false);
  assert.equal(service.get().status, "idle");
  service.start(request);
  await waitFor(() => assert.equal(service.get().status, "confirm"));
  assert.throws(() => service.confirm(oldId, true), /失效/);
  service.confirm(service.get().id, true);
  await waitFor(() => assert.equal(service.get().status, "error"));
  service.retry(service.get().id);
  await waitFor(() => assert.equal(service.get().status, "success"));
  assert.equal(service.get().mismatch, true);
  service.dismiss(service.get().id);
  service.start({ ...request, revision: "b".repeat(40) });
  await waitFor(() => assert.equal(service.get().status, "success"));
  assert.equal(service.get().mismatch, false);
  service.dismiss(service.get().id);
  service.start({ url: request.url });
  await waitFor(() => assert.equal(service.get().status, "success"));
  assert.equal(service.get().mismatch, false);
});
