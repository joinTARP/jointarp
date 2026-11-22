/** 与 node-datachannel 的运行时加载器使用相同的平台包命名。 */
export function datachannelPackage(platform: NodeJS.Platform, arch: string, libc?: string | null) {
  const suffix =
    platform === "linux"
      ? libc === "musl"
        ? "-musl"
        : "-gnu"
      : platform === "win32"
        ? "-msvc"
        : "";
  return `@node-datachannel/${platform}-${arch}${suffix}`;
}
