import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { assertRegularFile } from "../storage/regular-file";
import { directoryExists } from "./module-copy";

export const moduleSyncDirectory = (directory: string) => join(directory, ".module-sync");
export const moduleSyncJournal = (directory: string) => join(directory, ".module-sync.json");
export function hasModuleSyncJournal(directory: string): boolean {
  return Boolean(lstatSync(moduleSyncJournal(directory), { throwIfNoEntry: false }));
}
const journalSchema = z.strictObject({
  phase: z.enum(["prepared", "committed"]),
  hadIndex: z.boolean(),
});

/** 调用方持有 game 锁。未提交则恢复旧模组及关联索引，已提交仅清理备份。 */
export async function recoverModuleSync(directory: string): Promise<void> {
  const transaction = moduleSyncDirectory(directory);
  const journal = moduleSyncJournal(directory);
  if (!hasModuleSyncJournal(directory)) return;
  assertRegularFile(journal);
  const { phase, hadIndex } = journalSchema.parse(JSON.parse(readFileSync(journal, "utf8")));
  if (!(await directoryExists(transaction, "模组同步备份目录")))
    throw new Error("模组同步恢复资料缺失，请保留存档并修复备份目录");
  if (phase === "prepared") {
    const previousModule = join(transaction, "previous-module");
    if (await directoryExists(previousModule, "原模组备份目录")) {
      const current = join(directory, "module");
      if (await directoryExists(current, "房间模组副本目录"))
        rmSync(current, { recursive: true, force: true });
      renameSync(previousModule, current);
    }
    for (const name of ["adventure.json", "map-state.json", "document-references.json"]) {
      const backup = join(transaction, `previous-${name}`);
      if (existsSync(backup)) {
        assertRegularFile(backup);
        renameSync(backup, join(directory, name));
      } else if (name === "document-references.json" && !hadIndex) {
        const target = join(directory, name);
        if (existsSync(target)) {
          assertRegularFile(target);
          rmSync(target);
        }
      }
    }
  }
  // 先移除恢复标记；清理备份中断也不能把完整版本误判为未完成事务。
  rmSync(journal);
  rmSync(transaction, { recursive: true, force: true });
}
