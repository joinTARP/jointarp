import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { desktopOrpc, desktopRpc, queryClient } from "../../desktop-rpc";

export function ModuleImportNotice() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const reference = pathname.startsWith("/reference/");
  const navigate = useNavigate();
  const query = useQuery({
    ...desktopOrpc.modules.importState.queryOptions(),
    enabled: !reference,
    refetchInterval: 1000,
  });
  const state = query.data;
  const handled = useRef(0);
  const [dismissedBusy, setDismissedBusy] = useState("");
  const action = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => {
      await run();
      await query.refetch();
    },
  });
  useEffect(() => {
    if (reference || state?.status !== "success" || !state.result || handled.current === state.id)
      return;
    handled.current = state.id;
    void queryClient.invalidateQueries({ queryKey: desktopOrpc.modules.key() });
    if (!pathname.startsWith("/game/"))
      void navigate({ to: "/module", search: { path: state.result.path } });
  }, [state, pathname, reference, navigate]);
  if (reference || !state || state.status === "idle" || state.status === "selecting") return null;
  const busyKey = `${state.id}:${state.busyNotice}`;
  const busy = Boolean(state.busyNotice) && dismissedBusy !== busyKey;
  const run = (task: () => Promise<unknown>) => action.mutate(task);
  return (
    <>
      <aside
        aria-label="模组导入"
        role="status"
        className="border-border bg-background fixed right-5 bottom-5 z-50 w-80 max-w-[calc(100vw-40px)] rounded-xl border p-4 shadow-lg"
      >
        <p className="text-sm font-medium">
          {state.status === "running"
            ? state.canRetry
              ? "正在下载并校验模组…"
              : "正在导入并校验模组…"
            : state.status === "success"
              ? `已导入「${state.result?.name}」`
              : state.status === "confirm"
                ? "该模组已在模组库中"
                : "导入失败"}
        </p>
        {state.source ? (
          <p className="text-muted-foreground mt-2 text-xs break-all">{state.source}</p>
        ) : null}
        {state.status === "error" ? (
          <p role="alert" className="text-destructive mt-2 text-xs whitespace-pre-wrap">
            {state.message}
          </p>
        ) : null}
        {state.mismatch ? (
          <p className="text-muted-foreground mt-2 text-xs leading-5">
            已导入默认分支最新内容，与官网记录的版本不同。官网介绍和测试信息可能尚未同步。
          </p>
        ) : null}
        {busy ? (
          <div className="mt-2 text-xs">
            <p>当前任务处理期间收到的新请求未受理，请重新点击导入。</p>
            <Button size="xs" variant="ghost" onClick={() => setDismissedBusy(busyKey)}>
              知道了
            </Button>
          </div>
        ) : null}
        {action.error ? (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {action.error.message}
          </p>
        ) : null}
        {state.status === "success" || state.status === "error" ? (
          <div className="mt-3 flex gap-2">
            {state.result ? (
              <Button
                size="sm"
                onClick={() =>
                  void navigate({ to: "/module", search: { path: state.result!.path } })
                }
              >
                打开模组
              </Button>
            ) : null}
            {state.status === "error" && state.canRetry ? (
              <Button
                size="sm"
                disabled={action.isPending}
                onClick={() => run(() => desktopRpc.modules.retryImport({ id: state.id }))}
              >
                重试
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => run(() => desktopRpc.modules.dismissImport({ id: state.id }))}
            >
              关闭
            </Button>
          </div>
        ) : null}
      </aside>
      <Dialog
        open={state.status === "confirm"}
        onOpenChange={(open) => {
          if (!open && !action.isPending)
            run(() => desktopRpc.modules.confirmImport({ id: state.id, replace: false }));
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>替换已有模组？</DialogTitle>
            <DialogDescription>{state.message}</DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-xs break-all">{state.existingPath}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={action.isPending}
              onClick={() =>
                run(() => desktopRpc.modules.confirmImport({ id: state.id, replace: false }))
              }
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() =>
                run(() => desktopRpc.modules.confirmImport({ id: state.id, replace: true }))
              }
            >
              替换并丢弃本地修改
            </Button>
          </div>
          {action.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error.message}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
