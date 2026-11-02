import { onTestFinished, test } from "bun:test";
import { strict as assert } from "node:assert";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@jointarp/module/testing/files";
import { createTestModule } from "@jointarp/module/testing/test-module";

import { loadDocumentTypes } from "./document-types";
import { loadModuleDocuments } from "./module-documents";
import { loadModuleMaps } from "./module-maps";
import { validateModule } from "./validate-module";

test("maps 目录作为地图配置读取，不被当作游戏文档，配置错误按地图报告", async () => {
  const fixture = await createTestModule();
  onTestFinished(fixture.cleanup);
  const root = fixture.modulePath;
  const [map] = await loadModuleMaps(root);
  assert.equal(map?.id, "测试场景");
  assert.equal(map?.config.grid.type === "square" && map.config.grid.diagonal, "equal");
  assert.deepEqual(
    map?.config.doors.map((door) => [door.id, door.open, door.secret]),
    [
      ["中门", false, false],
      ["暗门", false, true],
    ],
  );
  assert.deepEqual(
    map?.config.regions.map((region) => [region.id, region.secret]),
    [
      ["西室", false],
      ["东室", false],
      ["暗室", true],
    ],
  );
  const documents = await loadModuleDocuments(root, await loadDocumentTypes(root));
  assert.ok(documents.every((document) => !document.path.startsWith("maps/")));
  const valid = await validateModule(root);
  assert.equal(valid.status, "success", JSON.stringify(valid.issues));
  assert.equal(valid.mapCount, 1);

  await writeFile(
    join(root, "maps/坏图.json"),
    JSON.stringify({
      name: "坏图",
      image: "maps/图片/不存在.png",
      width: 100,
      height: 100,
      grid: { type: "none", pixelsPerUnit: 10, unit: "米" },
      tokens: [{ id: "幽灵", document: "人物/不存在", at: [10, 10] }],
    }),
  );
  await writeFile(
    join(root, "maps/越界.json"),
    JSON.stringify({
      name: "越界",
      image: "maps/图片/测试场景.svg",
      width: 100,
      height: 100,
      grid: { type: "none", pixelsPerUnit: 10, unit: "米" },
      walls: [
        {
          points: [
            [0, 0],
            [200, 0],
          ],
        },
      ],
    }),
  );
  const invalid = await validateModule(root);
  const messages = invalid.issues
    .filter((issue) => issue.kind === "map")
    .map((issue) => issue.message);
  assert.ok(messages.some((message) => /人物\/不存在/u.test(message)));
  assert.ok(messages.some((message) => /找不到底图/u.test(message)));
  assert.ok(messages.some((message) => /超出底图范围/u.test(message)));
  await assert.rejects(loadModuleMaps(root), /越界/u);

  await rm(join(root, "maps"), { recursive: true });
  await writeFile(join(root, ".types/maps.fields.json"), JSON.stringify({ fields: {} }));
  await assert.rejects(loadDocumentTypes(root), /保留给地图配置/u);
});
