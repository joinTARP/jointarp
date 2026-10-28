import { afterAll, expect, test } from "bun:test";

import { useFakeTimers, advanceTimersByTime } from "@jointarp/module/testing/async";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import native from "node-datachannel";

import { createProbeRouter, type ProbeRouter } from "../../../scripts/p2p-probe/router";
import { verify } from "../../../scripts/p2p-probe/verify";
import { NativePeer, type PeerSignal } from "./native-peer";

afterAll(() => native.cleanup());

test("原生连接：中文大帧、订阅取消、关闭后拒绝调用，另一玩家仍可通信", async () => {
  function pair() {
    const pending: PeerSignal[] = [];
    let host: NativePeer | undefined;
    const player = new NativePeer({
      initiator: true,
      iceServers: [],
      onSignal: (signal) => {
        if (host) host.receiveSignal(signal);
        else pending.push(signal);
      },
    });
    host = new NativePeer({
      initiator: false,
      iceServers: [],
      onSignal: (signal) => player.receiveSignal(signal),
    });
    for (const signal of pending) host.receiveSignal(signal);
    return { host, player };
  }
  const first = pair();
  const second = pair();
  try {
    async function client(pair: { host: NativePeer; player: NativePeer }) {
      const [host, player] = await Promise.all([pair.host.ready, pair.player.ready]);
      new RPCHandler(createProbeRouter()).upgrade(host);
      return createORPCClient<RouterClient<ProbeRouter>>(new RPCLink({ port: player }));
    }
    const [a, b] = await Promise.all([client(first), client(second)]);
    const [resourcesOut, resourcesIn] = await Promise.all([
      first.player.resourcesReady,
      first.host.resourcesReady,
    ]);
    let resourcesComplete = false;
    const payload = new Uint8Array(2 * 1024 * 1024).fill(123);
    const transferred = new Promise<unknown>((resolve) =>
      resourcesIn.addEventListener(
        "message",
        (event) => {
          resourcesComplete = true;
          resolve((event as MessageEvent).data);
        },
        { once: true },
      ),
    );
    resourcesOut.postMessage(payload);
    expect(await a.echo("资源传输中仍可聊天")).toBe("资源传输中仍可聊天");
    expect(resourcesComplete).toBe(false);
    expect(await verify(a)).toHaveLength(4);
    expect(Buffer.from((await transferred) as Uint8Array).equals(Buffer.from(payload))).toBe(true);
    expect(first.player.selectedCandidatePair()?.local.type).toBe("host");
    first.host.close();
    await expect(a.echo("已断线", { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    expect(await b.echo("另一玩家仍在线")).toBe("另一玩家仍在线");
    expect(() =>
      second.player.receiveSignal({ kind: "description", type: "answer", sdp: "x" }),
    ).toThrow("重复握手");
  } finally {
    first.host.close();
    first.player.close();
    second.host.close();
    second.player.close();
  }
}, 15_000);

test("握手前限制非法信令和候选队列，主动关闭结束等待", async () => {
  const peer = new NativePeer({ initiator: false, iceServers: [], onSignal: () => {} });
  try {
    expect(() =>
      peer.receiveSignal({ kind: "description", type: "answer", sdp: "x".repeat(64_001) }),
    ).toThrow();
    for (let i = 0; i < 128; i++)
      peer.receiveSignal({ kind: "candidate", candidate: "pending", mid: "0" });
    expect(() =>
      peer.receiveSignal({ kind: "candidate", candidate: "overflow", mid: "0" }),
    ).toThrow("数量超限");
    peer.close();
    await expect(peer.ready).rejects.toThrow("已关闭");
  } finally {
    peer.close();
  }
});

test("原生通道承载最大房间状态编码帧，分块重组不损坏内容", async () => {
  const pending: PeerSignal[] = [];
  let host: NativePeer | undefined;
  const player = new NativePeer({
    initiator: true,
    iceServers: [],
    onSignal: (signal) => {
      if (host) host.receiveSignal(signal);
      else pending.push(signal);
    },
  });
  host = new NativePeer({
    initiator: false,
    iceServers: [],
    onSignal: (signal) => player.receiveSignal(signal),
  });
  try {
    for (const signal of pending) host.receiveSignal(signal);
    const [sender, receiver] = await Promise.all([player.ready, host.ready]);
    const payload = JSON.stringify({
      payload: Buffer.alloc(10 * 1024 * 1024, 123).toString("base64"),
    });
    const received = new Promise<unknown>((resolve) =>
      receiver.addEventListener("message", (event) => resolve((event as MessageEvent).data), {
        once: true,
      }),
    );
    sender.postMessage(payload);
    expect(await received).toBe(payload);
  } finally {
    host.close();
    player.close();
  }
}, 10_000);

test("握手超时保留诊断状态，错误不泄漏候选地址", async () => {
  useFakeTimers();
  const peer = new NativePeer({ initiator: false, iceServers: [], onSignal: () => {} });
  try {
    peer.receiveSignal({ kind: "candidate", candidate: "private-address", mid: "0" });
    const error = peer.ready.catch((error: Error) => error);
    advanceTimersByTime(30_000);
    const failure = await error;
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("联机握手超时");
    expect(message).toContain("候选发送/接收=0/1");
    expect(message).toContain("描述发送/接收=0/0");
    expect(message).toContain("通道=0/2");
    expect(message).not.toContain("private-address");
    await expect(peer.resourcesReady).rejects.toThrow("联机握手超时");
  } finally {
    peer.close();
  }
});
