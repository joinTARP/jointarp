import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { DocumentField, DocumentType } from "../schema/document-type";
import { validateDocumentLayout, validateDocumentType } from "../schema/document-type";
import { mapDirectory } from "../schema/map";
import { parseConfig } from "./config-file";
import { loadLayoutTemplates } from "./layout-templates";

function validateTargets(
  fields: readonly DocumentField[],
  knownTypes: ReadonlySet<string>,
  path: string,
): void {
  for (const field of fields) {
    const targets =
      field.type === "reference"
        ? field.targets
        : field.type === "list" && field.item?.type === "reference"
          ? field.item.targets
          : undefined;
    for (const target of targets ?? []) {
      if (!knownTypes.has(target)) {
        throw new Error(`${path}.${field.key}：目标文档类型 ${target} 不存在`);
      }
    }
    if (field.fields) validateTargets(field.fields, knownTypes, `${path}.${field.key}`);
    if (field.item?.fields)
      validateTargets(field.item.fields, knownTypes, `${path}.${field.key}.item`);
  }
}

/** 读取模组库现有的文档类型，不预设角色、NPC 等具体类型。 */
export async function loadDocumentTypes(libraryPath: string): Promise<readonly DocumentType[]> {
  const typeDirectory = join(libraryPath, ".types");
  let entries;
  try {
    entries = await readdir(typeDirectory, { withFileTypes: true });
  } catch {
    throw new Error("模组库根目录需要包含 .types 文件夹，且该文件夹必须可读取。");
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.fields\.(json|toml)$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const layoutFiles = entries.filter(
    (entry) => entry.isFile() && /\.layout\.(json|toml)$/.test(entry.name),
  );
  const unknownConfig = entries.find(
    (entry) =>
      entry.isFile() &&
      /\.(json|toml)$/.test(entry.name) &&
      !/\.fields\.(json|toml)$/.test(entry.name) &&
      !/\.layout\.(json|toml)$/.test(entry.name),
  );
  if (unknownConfig) {
    throw new Error(
      `.types/${unknownConfig.name}：类型定义请命名为 类型.fields.json 或 类型.fields.toml`,
    );
  }

  const reserved = files.find((entry) => entry.name.startsWith(`${mapDirectory}.fields.`));
  if (reserved) throw new Error(`.types/${reserved.name}：${mapDirectory} 目录保留给地图配置`);
  const seen = new Set<string>();
  for (const entry of [...files, ...layoutFiles]) {
    const stem = entry.name.replace(/\.(json|toml)$/, "");
    if (seen.has(stem)) throw new Error(`配置冲突：${stem}.json 与 ${stem}.toml 不能同时存在`);
    seen.add(stem);
  }

  const documentTypes = await Promise.all(
    files.map(async (entry) => {
      try {
        const source = await readFile(join(typeDirectory, entry.name), "utf8");
        return validateDocumentType(
          entry.name.replace(/\.fields\.(json|toml)$/, ""),
          parseConfig(source, entry.name),
        );
      } catch (error) {
        throw new Error(`${entry.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }),
  );

  const knownTypes = new Set(documentTypes.map((type) => type.id));
  for (const documentType of documentTypes) {
    validateTargets(documentType.fields, knownTypes, documentType.id);
  }

  const typesById = new Map(documentTypes.map((type) => [type.id, type]));
  const layouts = await Promise.all(
    layoutFiles.map(async (entry) => {
      const id = entry.name.replace(/\.layout\.(json|toml)$/, "");
      const documentType = typesById.get(id);
      if (!documentType)
        throw new Error(`.types/${entry.name}：找不到对应的 ${id}.fields.json 或 .toml`);
      try {
        const source = await readFile(join(typeDirectory, entry.name), "utf8");
        return [
          id,
          validateDocumentLayout(
            documentType,
            await loadLayoutTemplates(libraryPath, parseConfig(source, entry.name)),
          ),
        ] as const;
      } catch (error) {
        throw new Error(
          `.types/${entry.name}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  const layoutsById = new Map(layouts);
  return documentTypes.map((type) => ({ ...type, layout: layoutsById.get(type.id) }));
}
