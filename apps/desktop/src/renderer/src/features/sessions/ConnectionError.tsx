import { useMutation } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";

import { Button } from "../../components/ui/button";

export function ConnectionError({ message }: { message: string }) {
  const copy = useMutation({ mutationFn: () => navigator.clipboard.writeText(message) });
  const summary = message.startsWith("联机握手超时；")
    ? "没能连上对方的电脑，请尝试让一方切换到手机热点后重试。"
    : message.startsWith("等待房主协商超时；")
      ? "未收到房主响应，请让房主重新开放房间后再加入。"
      : message.startsWith("协调连接超时（")
        ? "连接联机服务超时，请检查网络后重试。"
        : message.startsWith("对端连接已断开；")
          ? "与对方的连接已断开，请重新加入房间。"
          : undefined;
  return (
    <div className="space-y-2 text-sm">
      <p role="alert" className="text-destructive break-words">
        {summary ?? message}
      </p>
      {summary ? (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">诊断详情</summary>
          <div className="space-y-2 pt-2">
            <p className="max-h-40 overflow-auto rounded-md border p-3 text-xs break-words whitespace-pre-wrap select-text">
              {message.replaceAll("；", "；\n").replaceAll("，", "，\n")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copy.mutate()}
              disabled={copy.isPending}
            >
              {copy.isSuccess ? <Check /> : <Copy />}
              {copy.isSuccess ? "已复制" : "复制诊断信息"}
            </Button>
            {copy.error ? (
              <p role="alert" className="text-xs">
                复制失败，请选中详情手动复制。
              </p>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
