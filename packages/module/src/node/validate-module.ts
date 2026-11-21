import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { validateWorkbench } from "../schema/creation-workbench";
import { collectReferences } from "../schema/document-evaluator";
import { documentIdentity } from "../schema/document-path";
import type { DocumentType } from "../schema/document-type";
import { launchConfigSchema, validateFlow, validateLaunch } from "../schema/flow";
import type { ModuleMetadata } from "../schema/module-document";
import { parseDocumentContent } from "./document-codec";
import { loadDocumentTypes } from "./document-types";
import { validateInitialGameState } from "./game-state-validation";
import { loadModuleDocuments } from "./module-documents";
import { loadModuleMapEntries, validateModuleMapReferences } from "./module-maps";
import { loadModuleMetadata } from "./module-metadata";
import { loadModulePages } from "./module-pages";

export interface ModuleValidationIssue {
  readonly kind:
    | "metadata"
    | "types"
    | "document"
    | "reference"
    | "page"
    | "launch"
    | "map"
    | "empty";
  readonly path: string;
  readonly message: string;
}

export interface ModuleValidationResult {
  readonly status: "success" | "error";
  readonly path: string;
  readonly name?: string;
  readonly documentTypeCount: number;
  readonly documentCount: number;
  readonly pageCount: number;
  readonly mapCount: number;
  readonly issues: readonly ModuleValidationIssue[];
}

/** 开发校验复用应用加载器和开局规则，不读取个人配置、不创建存档、不修改模组。 */
export async function validateModule(directory: string): Promise<ModuleValidationResult> {
  const path = resolve(directory);
  const issues: ModuleValidationIssue[] = [];
  let metadata: ModuleMetadata | undefined;
  let types: readonly DocumentType[] | undefined;
  const add = (kind: ModuleValidationIssue["kind"], file: string, error: unknown) => {
    issues.push({
      kind,
      path: file,
      message: error instanceof Error ? error.message : String(error),
    });
  };
  const results = await Promise.allSettled([loadModuleMetadata(path), loadDocumentTypes(path)]);
  if (results[0].status === "fulfilled") metadata = results[0].value;
  else add("metadata", "module.toml / module.json", results[0].reason);
  if (results[1].status === "fulfilled") types = results[1].value;
  else add("types", ".types", results[1].reason);
  let documentCount = 0;
  let pageCount = 0;
  let mapCount = 0;
  if (metadata && types) {
    try {
      const documents = await loadModuleDocuments(path, types);
      documentCount = documents.length;
      try {
        const { maps, issues: mapIssues } = await loadModuleMapEntries(path);
        mapCount = maps.length;
        const identities = new Set(
          documents
            .filter((document) => document.valid)
            .map((document) => documentIdentity(document.path)),
        );
        for (const issue of [
          ...mapIssues,
          ...(await validateModuleMapReferences(path, maps, identities)),
        ])
          add("map", issue.path, issue.message);
      } catch (error) {
        add("map", "maps", error);
      }
      const byIdentity = new Map(
        documents.map((document) => [documentIdentity(document.path), document]),
      );
      const contents = new Map<string, string>();
      for (const document of documents)
        if (document.valid && document.contentType)
          contents.set(document.path, await readFile(join(path, document.path), "utf8"));
      for (const document of documents) {
        if (!document.valid) {
          add("document", document.path, document.error ?? "文档无效");
          continue;
        }
        const type = types.find((type) => type.id === document.docType);
        if (!type) continue;
        const source = contents.get(document.path);
        const raw = source === undefined ? {} : parseDocumentContent(source, document.path);
        const reported = new Set<string>();
        // 原始声明用于 load 与提交校验，不能被计算结果掩盖；派生引用也继续校验。
        for (const values of [raw as Record<string, unknown>, document.values ?? {}]) {
          for (const [reference, targets] of collectReferences(type.fields, values)) {
            const target = byIdentity.get(reference);
            if ((!target || !targets.has(target.docType ?? "")) && !reported.has(reference)) {
              add("reference", document.path, `引用「${reference}」的目标不存在或文档类型不匹配。`);
              reported.add(reference);
            }
          }
        }
      }
      if (!types.length || !documents.length) add("empty", ".", "模组没有可用于开局的文档。");
      try {
        validateInitialGameState(documents, types, contents);
      } catch (error) {
        add("launch", ".", error);
      }
      try {
        if (metadata.gameStarts) {
          validateLaunch(
            launchConfigSchema.parse({
              preludeFlow: metadata.preludeFlow,
              gameStarts: metadata.gameStarts,
            }),
            types,
            documents,
          );
        } else {
          if (metadata.preludeFlow) validateFlow(metadata.preludeFlow, documents);
          for (const type of types) {
            if (type.creationFlow)
              validateWorkbench(type.creationFlow.workbench, documents, type, types);
          }
        }
      } catch (error) {
        add("launch", "module.toml / module.json", error);
      }
    } catch (error) {
      add("document", ".", error);
    }
  }
  if (metadata) {
    try {
      const pages = await loadModulePages(path, metadata.pages);
      pageCount = pages.length;
      for (const page of pages) if (page.error) add("page", page.path, page.error);
    } catch (error) {
      add("page", "module.toml / module.json", error);
    }
  }
  return {
    status: issues.length ? "error" : "success",
    path,
    name: metadata?.name,
    documentTypeCount: types?.length ?? 0,
    documentCount,
    pageCount,
    mapCount,
    issues,
  };
}
