import { randomBytes, randomUUID } from "node:crypto";

import type { ServerWebSocket } from "bun";

/** 公开协调协议的本机测试替身，不依赖私有服务仓库。 */
export function coordinatorFixture(
  options: {
    omitApproval?: boolean;
    iceStatus?: number;
    beforeCreate?: () => Promise<void>;
  } = {},
) {
  const hostToken = randomBytes(32).toString("hex");
  const guests = new Map<string, string>();
  const sockets = new Map<string, ServerWebSocket<{ id: string }>>();
  const approved = new Set<string>();
  const roomId = randomUUID();
  const signals: string[] = [];
  let unavailable = false;
  let closed = false;
  const code = "012345";
  const send = (id: string, data: unknown) => sockets.get(id)?.send(JSON.stringify(data));
  const server = Bun.serve<{ id: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      if (unavailable) return new Response(null, { status: 503 });
      const path = new URL(request.url).pathname;
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
      const id =
        token === hostToken ? "host" : [...guests].find(([, secret]) => secret === token)?.[0];
      if (path === "/v1/rooms" && request.method === "POST") {
        await options.beforeCreate?.();
        return Response.json({ code, roomId, hostToken, expiresAt: Date.now() + 180_000 });
      }
      if (path === `/v1/rooms/${code}/join` && !closed) {
        const peerId = randomUUID();
        const guestToken = randomBytes(32).toString("hex");
        guests.set(peerId, guestToken);
        return Response.json({ roomId, peerId, guestToken, connectBefore: Date.now() + 60_000 });
      }
      if (!id || closed) return new Response(null, { status: 403 });
      if (path === `/v1/rooms/${code}/socket` && server.upgrade(request, { data: { id } })) return;
      if (path === `/v1/rooms/${code}/ice`) {
        if (options.iceStatus)
          return Response.json({ error: "TEST_ICE_FAILURE" }, { status: options.iceStatus });
        return Response.json({ iceServers: [], relay: false });
      }
      if (path === `/v1/rooms/${code}/decision` && id === "host") {
        const value = (await request.json()) as { peerId: string; approve: boolean };
        if (value.approve) {
          approved.add(value.peerId);
          send(value.peerId, { type: "approved" });
        }
        if (!value.approve) {
          sockets.get(value.peerId)?.close();
          guests.delete(value.peerId);
          approved.delete(value.peerId);
        }
        return Response.json({ ok: true });
      }
      if (path === `/v1/rooms/${code}` && id === "host" && request.method === "DELETE") {
        closed = true;
        for (const socket of sockets.values()) socket.close();
        return Response.json({ closed: true });
      }
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        const id = socket.data.id;
        sockets.set(id, socket);
        send(id, {
          type: "welcome",
          protocolVersion: 1,
          roomId,
          peerId: id,
          peers: id === "host" ? [...guests.keys()] : ["host"],
          pending: [],
          ...(options.omitApproval ? {} : { approved: id === "host" || approved.has(id) }),
          heartbeatSeconds: 60,
        });
        if (id !== "host") send("host", { type: "peer-joined", peerId: id });
      },
      message(socket, raw) {
        const text = String(raw);
        const packet = JSON.parse(text);
        if (packet.type === "heartbeat") {
          send(socket.data.id, { type: "heartbeat", expiresAt: Date.now() + 180_000 });
          return;
        }
        if (packet.type !== "signal") throw Error("测试协调通道收到游戏数据");
        signals.push(text);
        send(packet.to, { type: "signal", from: socket.data.id, data: packet.data });
      },
      close(socket) {
        if (sockets.get(socket.data.id) === socket) sockets.delete(socket.data.id);
      },
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    code,
    signals,
    disconnect() {
      unavailable = true;
      for (const socket of sockets.values()) socket.close();
    },
    close: () => server.stop(true),
  };
}
