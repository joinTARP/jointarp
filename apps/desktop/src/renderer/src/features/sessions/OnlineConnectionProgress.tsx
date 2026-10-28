import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import type { OnlineStage } from "../../../../shared/online-progress";
import { desktopRpc } from "../../desktop-rpc";

const labels: Record<OnlineStage, string> = {
  service: "正在联系联机服务…",
  coordinator: "正在连接联机服务…",
  ice: "正在准备网络连接…",
  waiting: "正在联系房主，请稍候…",
  signaling: "已找到房主，正在交换连接信息…",
  connecting: "已联系上房主，正在建立游戏连接…",
  channels: "网络已连通，正在准备传输游戏数据…",
  authenticating: "连接已建立，正在确认你的玩家身份…",
  approval: "已提交加入申请，等待房主同意…申请两分钟内有效。",
  connected: "连接已建立，正在进入房间…",
};

export function OnlineConnectionProgress({
  target,
  hosting = false,
}: {
  target: string;
  hosting?: boolean;
}) {
  const progress = useQuery({
    queryKey: ["online-progress", target],
    queryFn: () => desktopRpc.lan.onlineProgress({ target }),
    refetchInterval: 500,
    refetchIntervalInBackground: true,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return (
    <div className="space-y-1 text-sm">
      <p role="status" className="flex items-center gap-2">
        <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        {progress.data
          ? hosting && progress.data.stage === "connected"
            ? "房间已准备好，可以邀请朋友了。"
            : labels[progress.data.stage]
          : "正在准备连接…"}
      </p>
      {progress.data ? (
        <p className="text-muted-foreground pl-6 text-xs">
          已等待{" "}
          {Math.max(0, Math.floor((progress.dataUpdatedAt - progress.data.startedAt) / 1000))} 秒
        </p>
      ) : null}
      {progress.data?.detail ? (
        <details className="text-muted-foreground pl-6 text-xs">
          <summary className="cursor-pointer">连接详情</summary>
          <p className="pt-2 break-words select-text">{progress.data.detail}</p>
        </details>
      ) : null}
      {progress.error ? (
        <p className="text-muted-foreground text-xs">暂时无法读取连接进度，仍在等待连接结果。</p>
      ) : null}
    </div>
  );
}
