import { randomBytes } from "node:crypto";

import { resolveMediaRequestFile } from "./media-path";

/** 仅监听本机；令牌只通过受限原生桥交给应用页面，不写入日志或存档。 */
export function createMediaServer(
  remote?: (source: string, method: string) => Promise<Response | undefined>,
) {
  const token = randomBytes(32).toString("hex");
  const prefix = `/${token}/document/`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (
        url.host !== `127.0.0.1:${server.port}` ||
        !["GET", "HEAD"].includes(request.method) ||
        !url.pathname.startsWith(prefix)
      )
        return new Response(null, { status: 404 });
      const source = `tarp://document/${url.pathname.slice(prefix.length)}${url.search}`;
      const response = await remote?.(source, request.method);
      if (response) return response;
      const file = await resolveMediaRequestFile(source);
      if (!file) return new Response(null, { status: 404 });
      return new Response(request.method === "HEAD" ? null : Bun.file(file), {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Type": Bun.file(file).type,
        },
      });
    },
  });
  return { base: `http://127.0.0.1:${server.port}${prefix}`, close: () => server.stop(true) };
}
