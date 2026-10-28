export interface GitImportRequest {
  readonly url: string;
  readonly revision?: string;
}

export function moduleImportArgument(args: readonly string[]): string | undefined {
  return args.length === 1 && /^tarp:/iu.test(args[0]!) ? args[0] : undefined;
}

/** GitHub 来源按 owner/repo 识别，HTTPS 与 SSH 地址指向同一仓库。 */
export function githubRepository(value: string): string | undefined {
  const match = value
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/?#\s]+)\/([^/?#\s]+?)\/?$/iu,
    );
  if (!match) return undefined;
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/iu, "");
  if (
    !/^[a-z\d](?:[a-z\d-]{0,38})$/iu.test(owner) ||
    !/^[\w.-]{1,100}$/u.test(repo) ||
    /^\.+$/u.test(repo)
  )
    return undefined;
  return `${owner}/${repo}`.toLowerCase();
}

export function parseModuleImportLink(value: string): GitImportRequest {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value))
    throw new Error("模组导入链接无效。");
  const link = new URL(value);
  if (
    link.protocol !== "tarp:" ||
    link.hostname !== "import" ||
    link.username ||
    link.password ||
    link.port ||
    link.hash ||
    !["", "/"].includes(link.pathname)
  )
    throw new Error("模组导入链接无效。");
  for (const key of link.searchParams.keys()) {
    if (!["repository", "revision"].includes(key) || link.searchParams.getAll(key).length !== 1)
      throw new Error("模组导入链接包含无效参数。");
  }
  const repository = link.searchParams.get("repository") ?? "";
  const identity = githubRepository(`https://github.com/${repository}`);
  if (!identity || repository.endsWith("/") || repository.endsWith(".git"))
    throw new Error("请提供有效的 GitHub 仓库标识。");
  const revision = link.searchParams.get("revision") ?? undefined;
  if (revision !== undefined && !/^[a-f\d]{40}$/iu.test(revision))
    throw new Error("官网版本标识无效。");
  return {
    url: `https://github.com/${identity}.git`,
    ...(revision ? { revision: revision.toLowerCase() } : {}),
  };
}

export interface ModuleImportResult {
  readonly path: string;
  readonly name: string;
  readonly revision?: string;
}

export interface ModuleImportState {
  readonly id: number;
  readonly status: "idle" | "selecting" | "running" | "confirm" | "success" | "error";
  readonly source?: string;
  readonly existingPath?: string;
  readonly result?: ModuleImportResult;
  readonly message?: string;
  readonly mismatch?: boolean;
  readonly busyNotice?: number;
  readonly canRetry?: boolean;
}
