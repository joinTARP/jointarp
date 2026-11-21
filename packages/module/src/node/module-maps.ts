import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  mapConfigSchema,
  mapDirectory,
  mapLineage,
  validateMapDestination,
  type ModuleMap,
} from "../schema/map";
import { parseConfig } from "./config-file";

export interface ModuleMapIssue {
  readonly path: string;
  readonly message: string;
}

async function findMapFiles(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await findMapFiles(root, path)));
    else if (entry.isFile() && /\.(json|toml)$/iu.test(entry.name)) files.push(path);
  }
  return files;
}

async function hasMapDirectory(root: string): Promise<boolean> {
  try {
    const stat = await lstat(join(root, mapDirectory));
    if (!stat.isDirectory()) throw new Error(`${mapDirectory} 必须是目录`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 读取 maps/ 中的地图配置；单张地图错误不影响其他地图的结果。 */
export async function loadModuleMapEntries(
  root: string,
): Promise<{ maps: ModuleMap[]; issues: ModuleMapIssue[] }> {
  const maps: ModuleMap[] = [];
  const issues: ModuleMapIssue[] = [];
  if (!(await hasMapDirectory(root))) return { maps, issues };
  const files = (await findMapFiles(root, mapDirectory)).sort();
  const counts = new Map<string, number>();
  const idOf = (path: string) =>
    path.slice(mapDirectory.length + 1).replace(/\.(json|toml)$/iu, "");
  for (const path of files) counts.set(idOf(path), (counts.get(idOf(path)) ?? 0) + 1);
  for (const path of files) {
    const id = idOf(path);
    try {
      if ((counts.get(id) ?? 0) > 1) throw new Error("同名 JSON 与 TOML 地图不能同时存在");
      const parsed = mapConfigSchema.safeParse(
        parseConfig(await readFile(join(root, path), "utf8"), path),
      );
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${issue?.path.join(".") || "地图"}：${issue?.message ?? "格式无效"}`);
      }
      maps.push({ id, path, config: parsed.data });
    } catch (error) {
      issues.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const byId = new Map(maps.map((map) => [map.id, map]));
  for (const map of maps) {
    try {
      for (const link of map.config.connections)
        validateMapDestination(map.id, link, byId.get(link.map)?.config);
      mapLineage(map.id, (id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`上级地图不存在或无效：${id}`);
        return entry.config.parent;
      });
    } catch (error) {
      issues.push({
        path: map.path,
        message: String(error instanceof Error ? error.message : error),
      });
    }
  }
  return { maps, issues };
}

/** 运行时加载要求全部地图有效。 */
export async function loadModuleMaps(root: string): Promise<ModuleMap[]> {
  const { maps, issues } = await loadModuleMapEntries(root);
  const issue = issues[0];
  if (issue) throw new Error(`地图 ${issue.path} 无效：${issue.message}`);
  return maps;
}

/** 地图引用的资料须存在；底图须是模组内图片。 */
export async function validateModuleMapReferences(
  root: string,
  maps: readonly ModuleMap[],
  documentIdentities: ReadonlySet<string>,
): Promise<ModuleMapIssue[]> {
  const issues: ModuleMapIssue[] = [];
  for (const map of maps) {
    for (const item of [...map.config.tokens, ...map.config.regions])
      if (item.document && !documentIdentities.has(item.document))
        issues.push({ path: map.path, message: `${item.id} 关联的资料不存在：${item.document}` });
    const image = map.config.image.replaceAll("\\", "/");
    if (!/\.(avif|gif|jpe?g|png|svg|webp)$/iu.test(image)) {
      issues.push({ path: map.path, message: `底图不是支持的图片格式：${map.config.image}` });
      continue;
    }
    if (image.startsWith("/") || image.split("/").includes("..")) {
      issues.push({ path: map.path, message: `底图必须位于模组目录内：${map.config.image}` });
      continue;
    }
    try {
      if (!(await lstat(join(root, image))).isFile()) throw new Error();
    } catch {
      issues.push({ path: map.path, message: `找不到底图：${map.config.image}` });
    }
  }
  return issues;
}
