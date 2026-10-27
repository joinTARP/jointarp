import { randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Signal, ProbeResult } from "./shared";

const signalSchema = z.object({
  description: z
    .object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(64000) })
    .optional(),
  candidate: z
    .object({
      candidate: z.string().max(4096),
      sdpMid: z.string().nullable().optional(),
      sdpMLineIndex: z.number().nullable().optional(),
      usernameFragment: z.string().nullable().optional(),
    })
    .optional(),
});
const packetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("signal"), data: signalSchema }),
  z.object({
    kind: z.literal("result"),
    data: z
      .object({
        scope: z.string(),
        origin: z.string(),
        secure: z.boolean(),
        peer: z.string(),
        checks: z.array(z.string()),
        error: z.string().optional(),
      })
      .passthrough(),
  }),
]);
export function startSignaling(options: {
  iceServers: { urls: string }[];
  onSignal: (data: Signal) => void;
  onReady: () => void;
  onResult: (data: ProbeResult) => void;
  onClose: () => void;
}) {
  const token = randomBytes(24).toString("hex");
  let socket: import("bun").ServerWebSocket<undefined> | undefined;
  let reserved = false;
  const server = Bun.serve<undefined>({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const supplied = Buffer.from(url.searchParams.get("token") ?? "");
      const expected = Buffer.from(token);
      if (
        url.pathname !== "/signal" ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("拒绝连接", { status: 403 });
      if (reserved) return new Response("已有加入者", { status: 409 });
      if (server.upgrade(request, { data: undefined })) {
        reserved = true;
        return;
      }
      return new Response("需要 WebSocket", { status: 400 });
    },
    websocket: {
      maxPayloadLength: 128 * 1024,
      open(ws) {
        socket = ws;
        ws.send(JSON.stringify({ kind: "config", iceServers: options.iceServers }));
      },
      message(ws, message) {
        try {
          const packet = packetSchema.parse(JSON.parse(String(message)));
          if (packet.kind === "ready") options.onReady();
          else if (packet.kind === "signal") options.onSignal(packet.data);
          else options.onResult(packet.data as ProbeResult);
        } catch {
          ws.close(1008, "无效实验消息");
        }
      },
      close(ws) {
        if (socket === ws) {
          socket = undefined;
          options.onClose();
        }
      },
    },
  });
  return {
    port: server.port,
    token,
    send: (data: unknown) => socket?.send(JSON.stringify(data)),
    stop: () => server.stop(true),
  };
}
