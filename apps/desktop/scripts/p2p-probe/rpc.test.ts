import { expect, test } from "bun:test";

import { protocol } from "./peer";
import { startSession } from "./session";
import { verify } from "./verify";

test("独立房主进程：RPC 大帧、订阅取消与共享连接存续", async () => {
  const session = await startSession();
  try {
    expect(await verify(session.client)).toHaveLength(4);
  } finally {
    session.port.close();
    await session.stop();
  }
}, 15_000);

test("畸形或截断数据帧只关闭该流，不拖垮房主与其他 RPC", async () => {
  const session = await startSession();
  try {
    const connection = session.peer.getConnections()[0];
    for (const frame of [
      [0, 0, 0, 0], // 零长度。
      [1, 0, 0, 1], // 声明超过 16 MiB，不能等待正文或分配巨大内存。
      [0, 0, 0, 1, 2], // 未知类型。
      [0, 0, 0, 9, 0, 65], // 正文未完成就半关闭。
    ]) {
      const stream = await connection.newStream(protocol);
      const closed = new Promise<void>((resolve) =>
        stream.addEventListener("close", () => resolve(), { once: true }),
      );
      stream.send(new Uint8Array(frame));
      await stream.close();
      await closed;
      expect(await session.client.echo("正常连接仍可用")).toBe("正常连接仍可用");
    }
    expect(() => session.port.postMessage(new Uint8Array(16 * 1024 * 1024))).toThrow("超过上限");
    await expect(session.client.echo("已关闭的流")).rejects.toThrow();
  } finally {
    session.port.close();
    await session.stop();
  }
}, 15_000);
