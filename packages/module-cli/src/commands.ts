import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadDocumentTypes } from "@jointarp/module/node/document-types";
import { loadModuleMetadata } from "@jointarp/module/node/module-metadata";
import { validateModule } from "@jointarp/module/node/validate-module";

export type ModuleCommand =
  | { readonly kind: "desktop" }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "validate"; readonly path: string; readonly json: boolean }
  | { readonly kind: "preview"; readonly path: string }
  | { readonly kind: "error"; readonly message: string; readonly json: boolean };

export const cliHelp = `TARP 模组开发工具

用法：
  tarp module validate <模组目录> [--json]
  tarp module preview <模组目录>
  tarp --version
  tarp --help

validate  校验配置、文档、引用、计算字段、阅读页、地图及开局，不修改模组。
preview   在桌面应用中打开模组，可直接预览 Git 工作区。
--json    输出结构化校验结果，供开发 Agent 使用。

退出码：0 成功，1 校验或操作失败，2 参数错误。
`;

export function parseModuleCommand(args: readonly string[], cwd = process.cwd()): ModuleCommand {
  if (!args.length || args.every((arg) => arg.startsWith("-psn_"))) return { kind: "desktop" };
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    if (values.help) return { kind: "help" };
    if (values.version && !positionals.length && !values.json) return { kind: "version" };
    if (
      positionals[0] !== "module" ||
      !["validate", "preview"].includes(positionals[1]) ||
      positionals.length !== 3 ||
      !positionals[2].trim() ||
      values.version ||
      (positionals[1] === "preview" && values.json)
    ) {
      return {
        kind: "error",
        message:
          "参数无效。请使用 tarp module validate <目录> [--json] 或 tarp module preview <目录>。",
        json: values.json ?? false,
      };
    }
    const path = resolve(cwd, positionals[2]);
    return positionals[1] === "preview"
      ? { kind: "preview", path }
      : { kind: "validate", path, json: values.json ?? false };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : "参数无效。",
      json: args.includes("--json"),
    };
  }
}

export interface CliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
  readonly previewPath?: string;
}

/** 返回命令结果，由独立 CLI 或桌面入口负责输出与预览启动。 */
export async function runModuleCommand(
  command: Exclude<ModuleCommand, { kind: "desktop" }>,
  appVersion: string,
): Promise<CliResult> {
  if (command.kind === "help") return { exitCode: 0, stdout: cliHelp, stderr: "" };
  if (command.kind === "version")
    return { exitCode: 0, stdout: `TARP ${appVersion}\n`, stderr: "" };
  if (command.kind === "error") {
    return {
      exitCode: 2,
      stdout: command.json
        ? `${JSON.stringify({ schemaVersion: 1, appVersion, status: "error", message: command.message })}\n`
        : "",
      stderr: command.json ? "" : `${command.message}\n使用 --help 查看帮助。\n`,
    };
  }
  if (command.kind === "preview") {
    try {
      await Promise.all([loadModuleMetadata(command.path), loadDocumentTypes(command.path)]);
      return { exitCode: 0, stdout: "", stderr: "", previewPath: command.path };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `无法预览模组：${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
  }
  const result = await validateModule(command.path);
  if (command.json)
    return {
      exitCode: result.status === "success" ? 0 : 1,
      stdout: `${JSON.stringify({ schemaVersion: 1, appVersion, ...result })}\n`,
      stderr: "",
    };
  return {
    exitCode: result.status === "success" ? 0 : 1,
    stdout: `${result.status === "success" ? "校验通过" : "校验失败"}：${result.name ?? result.path}\n${result.documentTypeCount} 种文档类型 · ${result.documentCount} 份文档 · ${result.pageCount} 个阅读页 · ${result.mapCount} 张地图\n${result.issues.map((issue) => `[${issue.kind}] ${issue.path}：${issue.message}\n`).join("")}`,
    stderr: "",
  };
}

export function modulePreviewHash(path: string): string {
  return `/module?${new URLSearchParams({ path })}`;
}
