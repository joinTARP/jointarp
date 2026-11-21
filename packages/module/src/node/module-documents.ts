import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { resolveModuleDocuments, type ParsedModuleDocument } from "../schema/document-evaluator";
import { documentFormat, documentIdentity, documentTypeId } from "../schema/document-path";
import type { DocumentContentType, DocumentType } from "../schema/document-type";
import { documentMetadataSchema, validateDocumentValues } from "../schema/document-type";
import { mapDirectory } from "../schema/map";
import type { ModuleDocument, RawModuleDocument } from "../schema/module-document";
import { parseDocumentContent } from "./document-codec";
import { loadModuleMetadata } from "./module-metadata";
import { modulePagePath } from "./module-pages";

const ignoredDirectories = new Set(["node_modules"]);
const ignoredFiles = new Set(["AGENTS.md", "module.json", "module.toml"]);

async function findContentFiles(directory: string, root = true): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || ignoredFiles.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (root && entry.name === mapDirectory) continue;
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
      files.push(...(await findContentFiles(path, false)));
    } else if (entry.isFile() && /\.(json|toml|md)$/iu.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

interface NamedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly title: string;
  readonly typeId: string;
  readonly contentType: DocumentContentType;
  readonly identity: string;
}

function nameFile(libraryPath: string, absolutePath: string): NamedFile | null {
  const relativePath = relative(libraryPath, absolutePath).split(sep).join("/");
  const filename = basename(relativePath);
  const typeId = documentTypeId(relativePath);
  if (!typeId || !/^.+\.(json|toml|md)$/iu.test(filename)) return null;
  const contentType = documentFormat(relativePath);
  return {
    absolutePath,
    relativePath,
    title: basename(documentIdentity(relativePath)),
    typeId,
    contentType,
    identity: documentIdentity(relativePath),
  };
}

/** 一级目录决定类型，子目录只负责分组；计算结果不修改原始文档。 */
export function loadModuleDocuments(
  libraryPath: string,
  documentTypes: readonly DocumentType[],
  options: { raw: true; view?: "source" | "public" },
): Promise<readonly RawModuleDocument[]>;
export function loadModuleDocuments(
  libraryPath: string,
  documentTypes: readonly DocumentType[],
  options?: { raw?: boolean; view?: "source" | "public" },
): Promise<readonly ModuleDocument[]>;
export async function loadModuleDocuments(
  libraryPath: string,
  documentTypes: readonly DocumentType[],
  options: { raw?: boolean; view?: "source" | "public" } = {},
): Promise<readonly ModuleDocument[]> {
  return loadModuleContent(libraryPath, documentTypes, options);
}

/** 模组浏览保留原值，并补充缺省派生字段的计算结果。 */
export function loadModuleLibraryDocuments(
  libraryPath: string,
  documentTypes: readonly DocumentType[],
): Promise<readonly ModuleDocument[]> {
  return loadModuleContent(libraryPath, documentTypes, { view: "library" });
}

async function loadModuleContent(
  libraryPath: string,
  documentTypes: readonly DocumentType[],
  options: { raw?: boolean; view?: "source" | "public" | "library" },
): Promise<readonly ModuleDocument[]> {
  const types = new Map(documentTypes.map((type) => [type.id, type]));
  const metadata = await loadModuleMetadata(libraryPath);
  const pages = new Set((metadata.pages ?? []).map((page) => modulePagePath(libraryPath, page)));
  const files: NamedFile[] = [];
  const malformed: ModuleDocument[] = [];
  for (const absolutePath of await findContentFiles(libraryPath)) {
    const named = nameFile(libraryPath, absolutePath);
    const relativePath = relative(libraryPath, absolutePath).split(sep).join("/");
    if (pages.has(relativePath)) continue;
    if (named) {
      files.push(named);
    } else {
      const path = relative(libraryPath, absolutePath).split(sep).join("/");
      malformed.push({
        path,
        title: basename(path),
        valid: false,
        error: "游戏文档必须位于类型目录下，使用 类型/分组/名称.json、.toml 或 .md",
      });
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const counts = new Map<string, number>();
  for (const file of files) {
    counts.set(file.identity, (counts.get(file.identity) ?? 0) + 1);
  }

  const parsedFiles = await Promise.all(
    files.map(async (file): Promise<ParsedModuleDocument | ModuleDocument> => {
      const base = {
        path: file.relativePath,
        title: file.title,
        docType: file.typeId,
        contentType: file.contentType,
      };
      try {
        if ((counts.get(file.identity) ?? 0) > 1) {
          throw new Error("同名 JSON、TOML 和 Markdown 不能同时存在");
        }
        const documentType = types.get(file.typeId);
        if (!documentType)
          throw new Error(
            `文档类型 ${file.typeId} 未在 .types/${file.typeId}.fields.json 或 .toml 中定义`,
          );
        const source = await readFile(file.absolutePath, "utf8");
        const content = parseDocumentContent(source, file.relativePath);
        const parsed = documentMetadataSchema.safeParse(content);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new Error(`${issue?.path.join(".") || "元数据"}：${issue?.message ?? "格式无效"}`);
        }
        if (Object.hasOwn(parsed.data, "doc_type")) {
          throw new Error("类型由一级目录决定，不要在内容中重复填写 doc_type");
        }
        const { name, description, image, avatar, body, computed, ...fields } = parsed.data;
        validateDocumentValues(documentType, parsed.data);
        const values = fields;
        return {
          identity: file.identity,
          documentType,
          values,
          computed,
          document: {
            ...base,
            title: name ?? file.title,
            description,
            image,
            avatar,
            ...(body !== undefined ? { body } : {}),
            valid: true,
          },
        };
      } catch (error) {
        return {
          ...base,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const documents = options.raw
    ? parsedFiles.map((item) =>
        "identity" in item
          ? {
              ...item.document,
              values: item.values,
              ...(item.computed ? { computed: item.computed } : {}),
            }
          : item,
      )
    : await resolveModuleDocuments(parsedFiles, { view: options.view ?? "source" });
  return [...documents, ...malformed].sort((a, b) => a.path.localeCompare(b.path));
}
