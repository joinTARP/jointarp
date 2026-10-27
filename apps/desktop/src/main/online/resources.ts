import { randomUUID } from "node:crypto";

import { os, ORPCError, type RouterClient } from "@orpc/server";
import { z } from "zod";

const resourceInput = z.object({
  path: z.string().min(1).max(4096),
  method: z.enum(["GET", "HEAD"]),
  etag: z.string().max(256).optional(),
});
const handleInput = z.object({ id: z.string().uuid() });
const procedure = os.$context<object>();

/** 按客户端读取节奏发送资源，避免大文件一次灌满 RPC 队列。 */
export function resourceRouter(
  request: (request: Request) => Promise<Response | undefined>,
  authorize: () => string,
) {
  type Handle = {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    pending: Uint8Array;
    timer: ReturnType<typeof setTimeout>;
    reads: number;
    tail: Promise<void>;
    done: boolean;
  };
  const handles = new Map<string, Handle>();
  let opening = 0;
  let stopped = false;
  const close = (id: string) => {
    const handle = handles.get(id);
    if (!handle) return;
    handles.delete(id);
    clearTimeout(handle.timer);
    void handle.reader.cancel().catch(() => undefined);
  };
  const router = {
    open: procedure.input(resourceInput).handler(async ({ input }) => {
      const token = authorize();
      if (stopped) throw new ORPCError("PRECONDITION_FAILED");
      if (handles.size + opening >= 4) throw new ORPCError("TOO_MANY_REQUESTS");
      if (
        !/^\/(module|media)\//.test(input.path) ||
        input.path.includes("\\") ||
        input.path.includes("#")
      )
        throw new ORPCError("FORBIDDEN");
      opening++;
      try {
        const response = await request(
          new Request(`http://room.invalid${input.path}`, {
            method: input.method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(input.etag ? { "If-None-Match": input.etag } : {}),
            },
          }),
        );
        if (!response) throw new ORPCError("NOT_FOUND");
        if (stopped) {
          await response.body?.cancel();
          throw new ORPCError("PRECONDITION_FAILED");
        }
        const id = randomUUID();
        if (response.body) {
          const handle: Handle = {
            reader: response.body.getReader(),
            pending: new Uint8Array(),
            timer: setTimeout(() => close(id), 30_000),
            reads: 0,
            tail: Promise.resolve(),
            done: false,
          };
          handles.set(id, handle);
        }
        return {
          id: response.body ? id : null,
          status: response.status,
          headers: Object.fromEntries(response.headers),
        };
      } finally {
        opening--;
      }
    }),
    read: procedure.input(handleInput).handler(async ({ input }) => {
      authorize();
      const handle = handles.get(input.id);
      if (!handle || handle.reads >= 4)
        throw new ORPCError("PRECONDITION_FAILED", { message: "资源读取已失效" });
      handle.reads++;
      const previous = handle.tail;
      let release!: () => void;
      handle.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      clearTimeout(handle.timer);
      handle.timer = setTimeout(() => close(input.id), 30_000);
      try {
        authorize();
        if (stopped || handles.get(input.id) !== handle) throw new ORPCError("PRECONDITION_FAILED");
        if (handle.done) return { data: new Blob(), done: true };
        const chunks: Uint8Array[] = [];
        let size = 0;
        let done = false;
        while (size < 256 * 1024) {
          if (!handle.pending.length) {
            const next = await handle.reader.read();
            if (next.done) {
              done = true;
              handle.done = true;
              break;
            }
            handle.pending = next.value;
          }
          const count = Math.min(handle.pending.length, 256 * 1024 - size);
          chunks.push(handle.pending.subarray(0, count));
          handle.pending = handle.pending.subarray(count);
          size += count;
        }
        return { data: new Blob([new Uint8Array(Buffer.concat(chunks))]), done };
      } catch (error) {
        close(input.id);
        throw error;
      } finally {
        handle.reads--;
        release();
      }
    }),
    close: procedure.input(handleInput).handler(({ input }) => {
      authorize();
      close(input.id);
    }),
  };
  return {
    router,
    close: () => {
      stopped = true;
      for (const id of handles.keys()) close(id);
    },
  };
}

type ResourceClient = RouterClient<ReturnType<typeof resourceRouter>["router"]>;
export async function fetchResource(
  client: ResourceClient,
  path: string,
  options: RequestInit,
): Promise<Response> {
  const signal = options.signal ?? undefined;
  signal?.throwIfAborted();
  const method = options.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw Error("资源请求方法无效");
  const response = await client.open(
    { path, method, etag: new Headers(options.headers).get("If-None-Match") ?? undefined },
    { signal },
  );
  const id = response.id;
  if (!id) return new Response(null, { status: response.status, headers: response.headers });
  let ended = false;
  let eof = false;
  type Chunk = Awaited<ReturnType<ResourceClient["read"]>>;
  const pending: Promise<{ chunk: Chunk } | { error: unknown }>[] = [];
  const fill = () => {
    while (!ended && !eof && pending.length < 4) {
      pending.push(
        client.read({ id }, { signal }).then(
          (chunk) => {
            if (chunk.done) eof = true;
            return { chunk };
          },
          (error: unknown) => ({ error }),
        ),
      );
    }
  };
  const close = () => {
    if (ended) return;
    ended = true;
    pending.length = 0;
    signal?.removeEventListener("abort", aborted);
    void client.close({ id }, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  };
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const aborted = () => {
    if (!ended) {
      close();
      streamController.error(signal?.reason ?? Error("资源请求已取消"));
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      },
      async pull(controller) {
        if (ended) return;
        try {
          fill();
          const result = await pending.shift()!;
          if ("error" in result) throw result.error;
          const chunk = result.chunk;
          if (ended) return;
          if (!chunk.done) fill();
          const bytes = new Uint8Array(await chunk.data.arrayBuffer());
          if (ended) return;
          if (bytes.length) controller.enqueue(bytes);
          if (chunk.done) {
            close();
            controller.close();
          }
        } catch (error) {
          if (!ended) {
            close();
            controller.error(error);
          }
        }
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: response.status, headers: response.headers });
}
