import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTestFile as writeFile } from "@jointarp/module/testing/files";

import { typeFormatLabel } from "../schema/document-path";
import { validateDocumentLayout, validateDocumentType } from "../schema/document-type";
import { parseDocumentContent, stringifyDocumentContent } from "./document-codec";
import { loadModuleDocuments, loadModuleLibraryDocuments } from "./module-documents";

async function library() {
  const root = await mkdtemp(join(tmpdir(), "tarp-docs-"));
  await writeFile(
    join(root, "module.json"),
    JSON.stringify({ name: "测试", description: "文档格式" }),
  );
  return root;
}

test("一级目录决定类型，多级分组可有同名文档，根目录与未知类型不能充当游戏资料", async () => {
  const root = await library();
  try {
    const type = validateDocumentType("规则", {
      fields: { cost: { type: "number", required: true } },
    });
    await writeFile(join(root, "规则/探险/基础/行动.md"), "---\ncost: 10\n---\n探索正文");
    await writeFile(join(root, "规则/战斗/行动.toml"), "cost = 1");
    await writeFile(join(root, "规则/战斗/破门.强攻.json"), '{"cost":2}');
    await writeFile(join(root, "其他/行动.json"), '{"cost":3}');
    await writeFile(join(root, "散落.md"), "未归类正文");
    const documents = await loadModuleDocuments(root, [type]);
    const rules = documents.filter((document) => document.docType === "规则");
    assert.equal(rules.length, 3);
    assert.ok(rules.every((document) => document.valid));
    assert.deepEqual(
      rules
        .filter((document) => document.title === "行动")
        .map((document) => document.values?.cost)
        .sort((a, b) => Number(a) - Number(b)),
      [1, 10],
    );
    assert.equal(
      rules.find((document) => document.path.endsWith("破门.强攻.json"))?.title,
      "破门.强攻",
    );
    assert.match(
      documents.find((document) => document.path === "其他/行动.json")?.error ?? "",
      /未在 .types/,
    );
    assert.match(
      documents.find((document) => document.path === "散落.md")?.error ?? "",
      /类型目录/,
    );
    await writeFile(join(root, "规则/战斗/行动.json"), '{"cost":4}');
    const conflict = await loadModuleDocuments(root, [type]);
    assert.equal(
      conflict.filter((document) => document.path.startsWith("规则/战斗/行动.") && !document.valid)
        .length,
      2,
    );
    assert.ok(conflict.find((document) => document.path === "规则/探险/基础/行动.md")?.valid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("模组库原值优先并补充派生值，公式失败仍可浏览原值", async () => {
  const root = await library();
  try {
    const type = validateDocumentType("装备", {
      fields: {
        name: { type: "text", compute: "'未辨识装备'" },
        image: { type: "text", compute: "null" },
        body: { type: "text", compute: "null" },
        armor: { type: "number", compute: "$raw.armor + 2" },
        rating: { type: "number", compute: "$self.armor * 2" },
        secret: { type: "text", visibility: "gm" },
      },
    });
    const original = {
      name: "皮甲",
      image: "皮甲.webp",
      body: "完整说明",
      armor: 6,
      secret: "主持资料",
      extra: { zero: 0, off: false, empty: "", missing: null },
    };
    await writeFile(join(root, "装备/皮甲.json"), JSON.stringify(original));
    const loaded = await loadModuleLibraryDocuments(root, [type]);
    const document = loaded[0]!;
    assert.equal(document.title, "皮甲");
    assert.equal(document.image, "皮甲.webp");
    assert.equal(document.body, "完整说明");
    assert.equal(document.values?.armor, 6);
    assert.equal(document.values?.rating, 16);
    assert.equal(document.values?.secret, "主持资料");
    const [game] = await loadModuleDocuments(root, [type], { view: "public" });
    assert.equal(game?.title, "未辨识装备");
    assert.equal(game?.image, undefined);
    assert.equal(game?.body, undefined);
    assert.equal(game?.values?.armor, 8);
    const broken = validateDocumentType("装备", {
      fields: { armor: { type: "number", compute: "(() => { throw new Error('公式损坏') })()" } },
    });
    const inspected = await loadModuleLibraryDocuments(root, [broken]);
    assert.equal(inspected[0]?.valid, true);
    assert.equal(inspected[0]?.error, undefined);
    assert.equal(inspected[0]?.image, "皮甲.webp");
    assert.equal(inspected[0]?.values?.armor, 6);
    const [hidden] = await loadModuleDocuments(root, [broken], { view: "public" });
    assert.equal(hidden?.valid, true);
    assert.equal(hidden?.values?.armor, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("三种格式共用字段与元数据校验，正文归一化，图片保留原始引用", async () => {
  const root = await library();
  try {
    await mkdir(join(root, "物品"));
    await writeFile(
      join(root, "物品/火把.json"),
      JSON.stringify({
        name: "火把",
        quantity: 1,
        body: "照明",
        image: "封面.webp",
        avatar: "头像.webp",
      }),
    );
    await writeFile(
      join(root, "物品/绳子.toml"),
      'name = "绳子"\nquantity = 2\nbody = "攀爬"\nimage = "封面.webp"\navatar = "头像.webp"\n',
    );
    await writeFile(
      join(root, "物品/纸条.md"),
      "---\nname: 纸条\nquantity: 3\nimage: 封面.webp\navatar: 头像.webp\n---\n线索正文\n",
    );
    const type = validateDocumentType("物品", {
      name: "物品",
      fields: { quantity: { type: "number", required: true } },
    });
    const documents = await loadModuleDocuments(root, [type]);
    assert.deepEqual(
      documents.map((document) => [
        document.path,
        document.valid,
        document.contentType,
        document.values?.quantity,
        document.body,
      ]),
      [
        ["物品/火把.json", true, "json", 1, "照明"],
        ["物品/纸条.md", true, "markdown", 3, "线索正文\n"],
        ["物品/绳子.toml", true, "toml", 2, "攀爬"],
      ],
    );
    for (const document of documents) {
      assert.equal(document.image, "封面.webp");
      assert.equal(document.avatar, "头像.webp");
      assert.equal(document.values?.avatar, undefined);
      assert.equal(document.values?.body, undefined);
    }
    assert.equal(typeFormatLabel(type.id, documents), "JSON / TOML / Markdown");
    assert.throws(
      () => validateDocumentType("物品", { fields: { avatar: { type: "number" } } }),
      /内置展示字段必须是 text 类型/,
    );
    await writeFile(join(root, "物品/错误.json"), JSON.stringify({ quantity: 1, avatar: 123 }));
    const invalid = (await loadModuleDocuments(root, [type])).find(
      (document) => document.path === "物品/错误.json",
    )!;
    assert.equal(invalid.valid, false);
    assert.match(invalid.error!, /avatar/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("同一文档身份不能以不同格式重复存在", async () => {
  const root = await library();
  await mkdir(join(root, "规则"));
  await writeFile(join(root, "规则/甲.md"), "正文\n");
  await writeFile(join(root, "规则/甲.json"), JSON.stringify({ name: "甲" }));
  await writeFile(join(root, "规则/甲.toml"), 'name = "甲"\n');
  const documents = await loadModuleDocuments(root, [
    validateDocumentType("规则", { name: "规则" }),
  ]);
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.equal(document.valid, false);
    assert.match(document.error ?? "", /同名 JSON、TOML 和 Markdown 不能同时存在/);
  }
});

test("计算字段生成的表格行标识同样校验，行标识计算完成前不误报缺失", async () => {
  const root = await library();
  try {
    const base = validateDocumentType("表格", {
      fields: {
        rows: {
          type: "list",
          item: {
            type: "object",
            fields: {
              source: { type: "text", required: true },
              id: { type: "text", compute: "$item.source" },
            },
          },
        },
      },
    });
    const type = {
      ...base,
      layout: validateDocumentLayout(base, {
        detail: {
          type: "grid",
          fields: ["rows"],
          fieldViews: {
            rows: { type: "FieldTable", rowKey: "id", columns: [{ field: "source" }] },
          },
        },
      }),
    };
    await writeFile(
      join(root, "表格/唯一.json"),
      JSON.stringify({ rows: [{ source: "a" }, { source: "b" }] }),
    );
    await writeFile(
      join(root, "表格/重复.json"),
      JSON.stringify({ rows: [{ source: "a" }, { source: "a" }] }),
    );
    const documents = await loadModuleDocuments(root, [type]);
    assert.equal(documents.find((document) => document.title === "唯一")?.valid, true);
    const invalid = documents.find((document) => document.title === "重复");
    assert.equal(invalid?.valid, false);
    assert.match(invalid?.error ?? "", /行标识 id 重复/);
    const displayed = (await loadModuleDocuments(root, [type], { view: "public" })).find(
      (document) => document.title === "重复",
    );
    assert.equal(displayed?.valid, true);
    assert.equal(displayed?.values?.rows, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("三种格式的文档公式覆盖控制元数据显隐，原始加载保留主持字段与配置", async () => {
  const root = await library();
  try {
    const type = validateDocumentType("线索", {
      fields: {
        found: { type: "boolean", mutable: true },
        trueName: { type: "text", visibility: "gm" },
        secretText: { type: "text", visibility: "gm" },
        sourceImage: { type: "text", visibility: "gm" },
        name: { type: "text", compute: "'类型默认名称'" },
        description: { type: "text", compute: "$self.found ? '已发现的线索' : null" },
        body: { type: "text", compute: "'类型默认正文'" },
        image: { type: "text", compute: "$self.found ? $self.sourceImage : null" },
        avatar: { type: "text", compute: "$self.found ? $self.sourceImage : null" },
        summary: { type: "text", compute: "$self.name + ':' + ($self.body ?? '隐藏')" },
      },
    });
    const source = {
      found: false,
      trueName: "真实名称",
      secretText: "完整正文",
      sourceImage: "线索.webp",
      computed: {
        name: "$self.found ? $self.trueName : '未知线索'",
        body: "$self.found ? $self.secretText : null",
      },
    };
    const { computed, ...businessValues } = source;
    for (const format of ["json", "toml", "md"]) {
      const path = `线索/资料-${format}.${format}`;
      const text = stringifyDocumentContent(source, path);
      assert.deepEqual(parseDocumentContent(text, path), source);
      await writeFile(join(root, path), text);
    }
    const raw = await loadModuleDocuments(root, [type], { raw: true });
    for (const document of raw) {
      assert.deepEqual(document.values, businessValues);
      assert.deepEqual(document.computed, computed);
      assert.equal(document.image, undefined);
    }
    const preview = await loadModuleDocuments(root, [type], { view: "public" });
    for (const document of preview) {
      assert.equal(document.valid, true, document.error ?? "");
      assert.equal(document.title, "未知线索");
      assert.equal(document.description, undefined);
      assert.equal(document.body, undefined);
      assert.equal(document.image, undefined);
      assert.equal(document.avatar, undefined);
      assert.equal(document.values?.summary, "未知线索:隐藏");
      assert.equal(document.values?.computed, undefined);
    }
    const inspected = await loadModuleLibraryDocuments(root, [type]);
    for (const document of inspected) {
      assert.equal(document.values?.computed, undefined);
    }
    for (const format of ["json", "toml", "md"]) {
      const path = `线索/资料-${format}.${format}`;
      await writeFile(join(root, path), stringifyDocumentContent({ ...source, found: true }, path));
    }
    for (const document of await loadModuleDocuments(root, [type], { view: "public" })) {
      assert.equal(document.valid, true, document.error ?? "");
      assert.equal(document.title, "真实名称");
      assert.equal(document.description, "已发现的线索");
      assert.equal(document.body, "完整正文");
      assert.equal(document.image, "线索.webp");
      assert.equal(document.avatar, "线索.webp");
      assert.equal(document.values?.secretText, "完整正文");
    }
    for (const document of await loadModuleDocuments(root, [type])) {
      assert.equal(
        document.title,
        document.path
          .split("/")
          .at(-1)!
          .replace(/\.[^.]+$/, ""),
      );
      assert.equal(document.image, undefined);
      assert.equal(document.values?.image, "线索.webp");
    }
    await writeFile(join(root, "线索/手填.md"), "---\nfound: false\n---\n手填计算正文");
    const withOriginal = (await loadModuleDocuments(root, [type])).find(
      (document) => document.path === "线索/手填.md",
    )!;
    assert.equal(withOriginal.valid, true);
    assert.match(withOriginal.body ?? "", /手填计算正文/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
