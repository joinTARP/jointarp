import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { documentIdentity } from "@jointarp/module/document-path";
import { configFilePath, parseConfig } from "@jointarp/module/node/config-file";
import { parseDocumentContent } from "@jointarp/module/node/document-codec";
import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { loadModuleDocuments } from "@jointarp/module/node/module-documents";
import { loadModuleMaps } from "@jointarp/module/node/module-maps";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";

/** 只编译 staging 副本；保留作者原值、公式及引用，阅读页和附件不转换。 */
export async function compileModule(directory: string): Promise<void> {
  await loadModuleMetadata(directory);
  const types = await loadDocumentTypes(directory);
  const documents = await loadModuleDocuments(directory, types, { raw: true });
  const invalid = documents.find((document) => !document.valid);
  if (invalid) throw new Error(`请先修复模组文档 ${invalid.path}：${invalid.error}`);
  const conversions: { source: string; target: string; content: unknown }[] = [];
  const config = async (path: string) => {
    if (!path.endsWith(".toml")) return;
    conversions.push({
      source: path,
      target: path.replace(/\.toml$/u, ".json"),
      content: parseConfig(await readFile(join(directory, path), "utf8"), path),
    });
  };
  const metadataPath = configFilePath(directory, "module")!;
  if (metadataPath.endsWith(".toml")) await config("module.toml");
  for (const entry of await readdir(join(directory, ".types"), { withFileTypes: true }))
    if (entry.isFile() && /\.(fields|layout)\.toml$/u.test(entry.name))
      await config(`.types/${entry.name}`);
  for (const map of await loadModuleMaps(directory)) await config(map.path);
  for (const document of documents) {
    if (/\.json$/iu.test(document.path)) continue;
    conversions.push({
      source: document.path,
      target: `${documentIdentity(document.path)}.json`,
      content: parseDocumentContent(
        await readFile(join(directory, document.path), "utf8"),
        document.path,
      ),
    });
  }
  // 预检全部目标后再写入，绝不覆盖与文档同名的其他文件或目录。
  for (const conversion of conversions) {
    try {
      await lstat(join(directory, conversion.target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`运行时 JSON 路径冲突：${conversion.target}`);
  }
  for (const conversion of conversions) {
    await writeFile(
      join(directory, conversion.target),
      `${JSON.stringify(conversion.content, null, 2)}\n`,
      { flag: "wx", mode: 0o444 },
    );
    await unlink(join(directory, conversion.source));
  }
}
