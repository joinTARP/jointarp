import type { RouterClient } from "@orpc/server";

import type { ProbeRouter } from "./router";

export async function verify(client: RouterClient<ProbeRouter>) {
  const checks: string[] = [];
  const text = "TARP 中文跨进程 RPC 😀".repeat(4096);
  if ((await client.echo(text)) !== text) throw Error("大帧中文 RPC 返回不一致");
  checks.push("大帧中文 RPC 往返通过");
  const values: number[] = [];
  for await (const value of await client.events(3)) values.push(value);
  if (JSON.stringify(values) !== "[0,1,2]") throw Error("订阅顺序错误");
  checks.push("三条订阅事件有序到达并正常结束");
  const before = await client.stats();
  const controller = new AbortController();
  try {
    for await (const value of await client.events(100, { signal: controller.signal })) {
      if (value !== 0) throw Error("取消前收到多余事件");
      controller.abort();
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
  const deadline = Date.now() + 5_000;
  while (true) {
    const after = await client.stats();
    if (after.active === 0 && after.cancelled === before.cancelled + 1) break;
    if (Date.now() > deadline) throw Error("取消没有传到房主，订阅仍在运行");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  checks.push("取消订阅传至房主，房主停止生成事件");
  if ((await client.echo("取消后仍可请求")) !== "取消后仍可请求") throw Error("取消误关了共享连接");
  checks.push("取消单条订阅后共享连接仍可用");
  return checks;
}
