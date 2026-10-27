import { test, expect } from "bun:test";

import { startSignaling } from "./signaling";

test("信令只允许持有凭证的单个加入者，并传送配置、就绪和协商", async () => {
  let readyResolve!: () => void;
  const ready = new Promise<void>((resolve) => (readyResolve = resolve));
  const signals: unknown[] = [];
  const host = startSignaling({
    iceServers: [],
    onSignal: (data) => signals.push(data),
    onReady: readyResolve,
    onResult: () => {},
    onClose: () => {},
  });
  let ws: WebSocket | undefined;
  try {
    const base = `http://127.0.0.1:${host.port}/signal`;
    expect((await fetch(base)).status).toBe(403);
    const config = await new Promise<unknown>((resolve, reject) => {
      ws = new WebSocket(base.replace("http:", "ws:") + "?token=" + host.token);
      ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
      ws.onerror = () => reject(Error("连接失败"));
    });
    expect(config).toEqual({ kind: "config", iceServers: [] });
    expect((await fetch(base + "?token=" + host.token)).status).toBe(409);
    ws!.send(
      JSON.stringify({ kind: "signal", data: { description: { type: "offer", sdp: "test" } } }),
    );
    ws!.send(JSON.stringify({ kind: "ready" }));
    await ready;
    expect(signals).toEqual([{ description: { type: "offer", sdp: "test" } }]);
    const response = new Promise<unknown>(
      (resolve) => (ws!.onmessage = (e) => resolve(JSON.parse(String(e.data)))),
    );
    host.send({ kind: "start" });
    expect(await response).toEqual({ kind: "start" });
    const closed = new Promise<number>((resolve) => (ws!.onclose = (e) => resolve(e.code)));
    ws!.send("{bad");
    expect(await closed).toBe(1008);
  } finally {
    ws?.close();
    host.stop();
  }
}, 5000);
