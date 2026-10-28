import type {
  GitImportRequest,
  ModuleImportResult,
  ModuleImportState,
} from "@shared/module-import";

import { ExistingGitModuleError, importGitModule } from "./import-git-module";

/** 任务留在宿主中，刷新页面不会丢失确认、进度或结果。 */
export class ModuleImportService {
  private state: ModuleImportState = { id: 0, status: "idle" };
  private request?: GitImportRequest;
  constructor(
    private readonly directory: () => Promise<string>,
    private readonly importGit = importGitModule,
  ) {}

  get(): ModuleImportState {
    return this.state;
  }

  private available(): void {
    if (["selecting", "running", "confirm"].includes(this.state.status)) {
      this.state = { ...this.state, busyNotice: (this.state.busyNotice ?? 0) + 1 };
      throw new Error("正在导入模组，请稍后重试。");
    }
  }

  start(request: GitImportRequest): void {
    this.available();
    this.request = request;
    this.state = { id: this.state.id + 1, status: "running", source: request.url, canRetry: true };
    void this.download();
  }

  report(error: unknown): void {
    if (["selecting", "running", "confirm"].includes(this.state.status)) return;
    this.request = undefined;
    this.state = {
      id: this.state.id + 1,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async download(replacePath?: string): Promise<void> {
    const request = this.request!;
    try {
      const result = await this.importGit(await this.directory(), {
        url: request.url,
        replacePath,
      });
      this.state = {
        ...this.state,
        status: "success",
        result,
        existingPath: undefined,
        message: undefined,
        mismatch: Boolean(request.revision && request.revision !== result.revision),
      };
    } catch (error) {
      this.state =
        error instanceof ExistingGitModuleError
          ? { ...this.state, status: "confirm", existingPath: error.path, message: error.message }
          : {
              ...this.state,
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            };
    }
  }

  confirm(id: number, replace: boolean): void {
    if (id !== this.state.id || this.state.status !== "confirm")
      throw new Error("导入确认已失效。");
    if (!replace) {
      this.dismiss(id);
      return;
    }
    const path = this.state.existingPath!;
    this.state = { ...this.state, status: "running" };
    void this.download(path);
  }

  retry(id: number): void {
    if (id !== this.state.id || this.state.status !== "error" || !this.request)
      throw new Error("请重新选择导入来源。");
    this.start(this.request);
  }

  dismiss(id: number): void {
    if (id !== this.state.id || ["selecting", "running"].includes(this.state.status)) return;
    this.state = { id, status: "idle" };
    this.request = undefined;
  }

  async local(
    source: string,
    select: () => Promise<string | null>,
    run: (directory: string, path: string) => Promise<ModuleImportResult>,
  ): Promise<ModuleImportResult | null> {
    this.available();
    this.request = undefined;
    this.state = { id: this.state.id + 1, status: "selecting", source };
    try {
      const path = await select();
      if (!path) {
        this.state = { id: this.state.id, status: "idle" };
        return null;
      }
      this.state = { ...this.state, status: "running" };
      const result = await run(await this.directory(), path);
      this.state = { ...this.state, status: "success", result };
      return result;
    } catch (error) {
      this.state = {
        ...this.state,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }
}
