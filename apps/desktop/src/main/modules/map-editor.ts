import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeFileAtomicSync } from "@jointarp/core/node/storage/write-file-atomic";
import {
  mapConfigSchema,
  mapLineage,
  validateMapDestination,
  type MapConfig,
} from "@jointarp/module/map";
import { parseConfig } from "@jointarp/module/node/config-file";
import { findNodeAtLocation, parseTree, modify, applyEdits } from "jsonc-parser/lib/esm/main.js";
import { parseTOML, type AST } from "toml-eslint-parser";

import { applyMapEdit, editPoint, type VertexEdit, type MapEdit } from "../../shared/map-vertex";

function mapFile(root: string, path: string) {
  if (
    !/^maps\/(?:[^/\\]+\/)*[^/\\]+\.(toml|json)$/iu.test(path) ||
    path.split("/").some((p) => p.startsWith("."))
  )
    throw new Error("无效地图路径");
  const file = resolve(realpathSync(root), path);
  if (realpathSync(file) !== file || !statSync(file).isFile())
    throw new Error("地图必须是模组内的普通文件");
  return file;
}
const revision = (text: string) => createHash("sha256").update(text).digest("hex");

export function openMapEdit(root: string, path: string) {
  const text = readFileSync(mapFile(root, path), "utf8");
  return { config: mapConfigSchema.parse(parseConfig(text, path)), revision: revision(text) };
}

function tomlNumbers(source: string) {
  const ranges = new Map<string, [number, number]>();
  function visit(
    node: AST.TOMLTable | AST.TOMLKeyValue | AST.TOMLContentNode,
    path: (string | number)[],
  ) {
    if (node.type === "TOMLTable") node.body.forEach((child) => visit(child, node.resolvedKey));
    else if (node.type === "TOMLKeyValue")
      visit(node.value, [
        ...path,
        ...node.key.keys.map((k) => (k.type === "TOMLBare" ? k.name : k.value)),
      ]);
    else if (node.type === "TOMLArray")
      node.elements.forEach((child, i) => visit(child, [...path, i]));
    else if (node.type === "TOMLInlineTable") node.body.forEach((child) => visit(child, path));
    else if (typeof node.value === "number") ranges.set(JSON.stringify(path), node.range);
  }
  parseTOML(source, { tomlVersion: "1.1" }).body[0].body.forEach((node) => visit(node, []));
  return ranges;
}

function patchVertices(source: string, path: string, config: MapConfig, edits: VertexEdit[]) {
  const toml = /\.toml$/iu.test(path) ? tomlNumbers(source) : undefined;
  const tree = toml ? undefined : parseTree(source);
  const changes = new Map<number, { end: number; value: number }>();
  for (const edit of edits) {
    const point = editPoint(config, edit);
    const key =
      edit.layer === "walls"
        ? ["walls", edit.index, "points", edit.vertex]
        : ["doors", edit.index, edit.vertex === 0 ? "from" : "to"];
    for (const axis of [0, 1] as const) {
      if (point[axis] === edit.at[axis]) continue;
      const loc = [...key, axis];
      const json = tree && findNodeAtLocation(tree, loc);
      const range = json
        ? [json.offset, json.offset + json.length]
        : toml?.get(JSON.stringify(loc));
      if (!range) throw new Error("无法定位坐标在源文件中的位置");
      changes.set(range[0], { end: range[1], value: edit.at[axis] });
      point[axis] = edit.at[axis];
    }
  }
  for (const [start, { end, value }] of [...changes].sort(([a], [b]) => b - a))
    source = source.slice(0, start) + value + source.slice(end);
  return source;
}

function patchStructure(
  source: string,
  path: string,
  previous: MapConfig,
  next: MapConfig,
  layer: "walls" | "doors" | "starts" | "connections",
) {
  const old = previous[layer],
    items = next[layer];
  let start = 0;
  while (start < old.length && old[start] === items[start]) start++;
  let end = old.length,
    tail = items.length;
  while (end > start && tail > start && old[end - 1] === items[tail - 1]) {
    end--;
    tail--;
  }
  if (start === end && start === tail) return source;
  const insert = items.slice(start, tail);
  if (/\.json$/iu.test(path)) {
    const opts = {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: source.includes("\r\n") ? "\r\n" : "\n",
      },
    };
    if (!findNodeAtLocation(parseTree(source)!, [layer]))
      return applyEdits(source, modify(source, [layer], insert, opts));
    for (let i = end - 1; i >= start; i--)
      source = applyEdits(source, modify(source, [layer, i], undefined, opts));
    insert.forEach((item, i) => {
      source = applyEdits(
        source,
        modify(source, [layer, start + i], item, { ...opts, isArrayInsertion: true }),
      );
    });
    return source;
  }
  const ast = parseTOML(source, { tomlVersion: "1.1" });
  const nodes = ast.body[0].body;
  const tables = nodes.filter(
    (n): n is AST.TOMLTable => n.type === "TOMLTable" && n.resolvedKey[0] === layer,
  );
  const fields = (obj: (typeof insert)[number]) =>
    Object.entries(obj).map(([k, v]) => k + " = " + JSON.stringify(v));
  const inline = nodes.find(
    (n) =>
      n.type === "TOMLKeyValue" &&
      n.key.keys.length === 1 &&
      (n.key.keys[0].type === "TOMLBare" ? n.key.keys[0].name : n.key.keys[0].value) === layer,
  );
  if (inline?.type === "TOMLKeyValue" && inline.value.type === "TOMLArray") {
    const arr = inline.value;
    const text = insert.map((o) => "{ " + fields(o).join(", ") + " }").join(", ");
    if (start === end) {
      const last = arr.elements.at(-1),
        offset = last?.range[1] ?? arr.range[0] + 1;
      return source.slice(0, offset) + (last ? ", " : "") + text + source.slice(offset);
    }
    const [a, b] = arr.elements[start].range;
    if (text) return source.slice(0, a) + text + source.slice(b);
    const comma = ast.tokens.find(
      (t) =>
        t.range[0] >= b &&
        t.range[0] < (arr.elements[end]?.range[0] ?? arr.range[1]) &&
        t.value === ",",
    );
    if (comma) source = source.slice(0, comma.range[0]) + source.slice(comma.range[1]);
    return source.slice(0, a) + source.slice(b);
  }
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const text = insert.map((o) => ["[[" + layer + "]]", ...fields(o)].join(nl)).join(nl + nl);
  const offset = tables[start]?.range[0] ?? source.length;
  for (let i = end - 1; i >= start; i--) {
    const [a, b] = tables[i].range;
    source = source.slice(0, a) + source.slice(b);
  }
  return source.slice(0, offset) + (text ? nl + text + nl : "") + source.slice(offset);
}
function patchParent(source: string, path: string, parent?: string) {
  if (/\.json$/iu.test(path)) return applyEdits(source, modify(source, ["parent"], parent, {}));
  const entry = parseTOML(source, { tomlVersion: "1.1" }).body[0].body.find(
    (node) =>
      node.type === "TOMLKeyValue" &&
      node.key.keys.length === 1 &&
      (node.key.keys[0].type === "TOMLBare" ? node.key.keys[0].name : node.key.keys[0].value) ===
        "parent",
  );
  if (entry?.type === "TOMLKeyValue") {
    const [start, end] = parent ? entry.value.range : entry.range;
    return source.slice(0, start) + (parent ? JSON.stringify(parent) : "") + source.slice(end);
  }
  return parent
    ? `parent = ${JSON.stringify(parent)}${source.includes("\r\n") ? "\r\n" : "\n"}${source}`
    : source;
}

function referencedMap(root: string, id: string) {
  if (id.split("/").some((part) => !part || part.startsWith(".") || part.includes("\\")))
    throw new Error("引用地图路径无效");
  const directory = dirname(`maps/${id}`);
  const location = resolve(realpathSync(root), directory);
  if (realpathSync(location) !== location) throw new Error("引用地图路径无效");
  const files = readdirSync(location)
    .filter(
      (name) =>
        /\.(json|toml)$/iu.test(name) && name.replace(/\.(json|toml)$/iu, "") === basename(id),
    )
    .map((name) => `${directory}/${name}`);
  if (files.length !== 1) throw new Error(`引用地图不存在或重名：${id}`);
  return openMapEdit(root, files[0]).config;
}

export function saveMapEdit(root: string, path: string, expected: string, edits: MapEdit[]) {
  const file = mapFile(root, path);
  let source = readFileSync(file, "utf8");
  const conflict = () => {
    throw new Error("地图文件已在外部修改。请保留需要的坐标，退出编辑并重新加载后再修改。");
  };
  if (revision(source) !== expected) conflict();
  let config = mapConfigSchema.parse(parseConfig(source, path));
  for (let i = 0; i < edits.length;) {
    const edit = edits[i++];
    if ("kind" in edit) {
      const next = applyMapEdit(config, edit);
      if (edit.kind === "parent") source = patchParent(source, path, next.parent);
      else
        for (const layer of ["walls", "doors", "starts", "connections"] as const)
          source = patchStructure(source, path, config, next, layer);
      config = next;
    } else {
      const batch = [edit];
      while (i < edits.length && !("kind" in edits[i])) batch.push(edits[i++] as VertexEdit);
      source = patchVertices(source, path, config, batch);
    }
  }
  if (edits.some((edit) => "kind" in edit && edit.kind === "parent")) {
    const current = path.slice(5).replace(/\.(json|toml)$/iu, "");
    mapLineage(current, (id) => {
      if (id === current) return config.parent;
      return referencedMap(root, id).parent;
    });
  }
  if (edits.some((edit) => "kind" in edit && edit.kind === "connect")) {
    const id = path.slice(5).replace(/\.(json|toml)$/iu, "");
    for (const link of config.connections)
      validateMapDestination(id, link, referencedMap(root, link.map));
  }
  if (!isDeepStrictEqual(config, mapConfigSchema.parse(parseConfig(source, path))))
    throw new Error("写入校验失败");
  if (revision(readFileSync(mapFile(root, path), "utf8")) !== expected) conflict();
  writeFileAtomicSync(file, source, { mode: statSync(file).mode });
}
