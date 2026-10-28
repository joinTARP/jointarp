import { expect, test, mock } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToReadableStream } from "react-dom/server";

import { ConnectionError } from "./ConnectionError";
mock.module("../../desktop-rpc", () => ({
  desktopRpc: { lan: { onlineProgress: async () => null } },
  desktopOrpc: {},
}));
const { OnlineConnectionProgress } = await import("./OnlineConnectionProgress");

test("直连超时显示行动提示，原始状态收在默认关闭的诊断详情中", async () => {
  const message = "联机握手超时；P2P=connecting，ICE=checking，通道=0/2";
  const stream = await renderToReadableStream(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionError message={message} />
      <ConnectionError message="本机已有同名存档，不能作为访客加入" />
    </QueryClientProvider>,
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("没能连上对方的电脑");
  expect(html).toContain("手机热点");
  expect(html).toContain("诊断详情");
  expect(html).toContain("复制诊断信息");
  expect(html).toContain("ICE=checking");
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  expect(html).not.toMatch(/role="alert"[^>]*>[^<]*ICE=/);
  expect(html).toContain("本机已有同名存档，不能作为访客加入");
});

test("连接进度解释当前动作，技术信息默认收起", async () => {
  const client = new QueryClient();
  client.setQueryData(["online-progress", "012345"], {
    stage: "connecting",
    startedAt: Date.now(),
    detail: "已收集 5 个本机候选，收到 3 个对方候选；数据通道 0/2",
  });
  const stream = await renderToReadableStream(
    <QueryClientProvider client={client}>
      <OnlineConnectionProgress target="012345" />
    </QueryClientProvider>,
  );
  await stream.allReady;
  const html = await new Response(stream).text();
  expect(html).toContain("已联系上房主，正在建立游戏连接");
  expect(html).toContain("已收集 5 个本机候选");
  expect(html).toContain("数据通道 0/2");
  expect(html).toContain("连接详情");
  expect(html).not.toMatch(/<details[^>]*\bopen/);
  expect(html).not.toMatch(/role="status"[^>]*>[^<]*候选/);
});
