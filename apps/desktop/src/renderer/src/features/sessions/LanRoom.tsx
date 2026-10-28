import { privacyPolicyUrl } from "@shared/brand";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, Globe, LoaderCircle, Network } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { ConnectionError } from "./ConnectionError";
import { OnlineConnectionProgress } from "./OnlineConnectionProgress";

function OnlinePrivacyNotice() {
  return (
    <p className="text-muted-foreground text-xs leading-relaxed">
      互联网联机会连接协调服务及第三方网络连接服务，并与其他玩家交换网络地址。
      游戏数据会传给房主和获准加入的玩家。详情见
      <a href={privacyPolicyUrl} className="underline underline-offset-4">
        《隐私政策》
      </a>
      。
    </p>
  );
}

export function LanJoin() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-5 flex justify-end">
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Network className="size-4" />
        加入房间
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>加入房间</DialogTitle>
            <DialogDescription>
              输入房主提供的六位房间码，或同一局域网内的房间地址。
            </DialogDescription>
          </DialogHeader>
          {open ? <JoinForm /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function JoinForm() {
  const [address, setAddress] = useState("");
  const [submitted, setSubmitted] = useState("");
  const id = useId();
  const navigate = useNavigate();
  const client = useQueryClient();
  const join = useQuery({
    queryKey: ["lan-join", submitted],
    queryFn: ({ signal }) =>
      /^\d{6}$/.test(submitted)
        ? desktopRpc.lan.onlineJoin({ code: submitted }, { signal })
        : desktopRpc.lan.join({ address: submitted }, { signal }),
    enabled: Boolean(submitted),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 1500 : false),
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (join.data?.status !== "approved") return;
    const roomId = join.data.roomId;
    client.setQueryData(desktopOrpc.lan.status.queryOptions({ input: { roomId } }).queryKey, {
      remote: true,
      connection: "connected",
      hosting: false,
      online: null,
      addresses: [],
      pending: [],
    });
    void navigate({ to: "/game/$roomId", params: { roomId } });
  }, [join.data, client, navigate]);
  useEffect(() => {
    if (!/^\d{6}$/.test(submitted)) return;
    return () => {
      void desktopRpc.lan.cancelOnlineJoin({ code: submitted }).catch(() => undefined);
    };
  }, [submitted]);
  const waiting = Boolean(submitted) && !join.error && join.data?.status !== "rejected";
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (submitted === address.trim()) void join.refetch();
        else setSubmitted(address.trim());
      }}
    >
      <label htmlFor={id} className="block space-y-2 text-sm">
        <span>房间码或内网地址</span>
        <Input
          id={id}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="六位房间码 / 192.168.1.10:8765"
          autoComplete="off"
          spellCheck={false}
          disabled={waiting}
          required
        />
      </label>
      {waiting && /^\d{6}$/.test(submitted) ? (
        <OnlineConnectionProgress target={submitted} />
      ) : waiting ? (
        <p role="status" className="text-muted-foreground text-sm">
          {join.data?.status === "pending" ? "等待房主同意…申请两分钟内有效。" : "正在连接…"}
        </p>
      ) : null}
      {join.error ? (
        <ConnectionError key={join.error.message} message={join.error.message} />
      ) : null}
      {join.data?.status === "rejected" ? (
        <p role="alert" className="text-destructive text-sm">
          房主拒绝了本次申请。
        </p>
      ) : null}
      {/^\d{6}$/.test(address.trim()) && !waiting ? <OnlinePrivacyNotice /> : null}
      <div className="flex gap-2">
        <Button type="submit" disabled={!address.trim() || waiting}>
          申请加入
        </Button>
        {waiting ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (/^\d{6}$/.test(submitted))
                void desktopRpc.lan.cancelOnlineJoin({ code: submitted }).catch(() => undefined);
              setSubmitted("");
            }}
          >
            取消申请
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function RoomInvite({ value, online }: { value: string; online: boolean }) {
  const copy = useMutation({ mutationFn: () => navigator.clipboard.writeText(value) });
  return (
    <div className="space-y-3">
      <Input
        aria-label={online ? "房间码" : "内网地址"}
        className={online ? "h-16 text-center font-mono text-3xl tracking-[0.3em]" : "font-mono"}
        value={value}
        readOnly
        onFocus={(event) => event.target.select()}
      />
      <Button className="w-full" onClick={() => copy.mutate()} disabled={copy.isPending}>
        {copy.isSuccess ? <Check /> : <Copy />}
        {copy.isSuccess ? "已复制，发给朋友吧" : online ? "复制房间码" : "复制内网地址"}
      </Button>
      {copy.error ? (
        <p role="alert" className="text-destructive text-xs">
          复制失败，请选中上方内容后手动复制。
        </p>
      ) : null}
    </div>
  );
}

export function LanRoom({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const query = desktopOrpc.lan.status.queryOptions({ input: { roomId } });
  const status = useQuery({ ...query, refetchInterval: 1500, refetchIntervalInBackground: true });
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: async (
      operation: "host" | "onlineHost" | "stop" | { id: string; approve: boolean },
    ) => {
      if (typeof operation === "object") return desktopRpc.lan.decide({ roomId, ...operation });
      if (operation === "host") return desktopRpc.lan.host({ roomId });
      if (operation === "onlineHost") return desktopRpc.lan.onlineHost({ roomId });
      await desktopRpc.lan.stop({ roomId });
      return desktopRpc.lan.status({ roomId });
    },
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey: query.queryKey });
      client.setQueryData(query.queryKey, value);
      setConfirmStop(false);
    },
    onError: () => client.invalidateQueries({ queryKey: query.queryKey }),
  });
  if (status.data?.remote)
    return (
      <p className="text-muted-foreground px-2 py-2 text-xs">
        {status.data.connection === "disconnected"
          ? "房间连接已断开，请离开后重新加入"
          : "已加入房间 · 存档保存在房主电脑"}
      </p>
    );
  const pending = status.data?.pending ?? [];
  const online = status.data?.online;
  const unavailable = online && !online.connected;
  const opening =
    action.isPending && (action.variables === "host" || action.variables === "onlineHost");
  const hosting = status.data?.hosting && !opening;
  return (
    <>
      <Button
        variant="outline"
        className="mx-1 mb-3"
        onClick={() => {
          if (!action.isPending) action.reset();
          setConfirmStop(false);
          setOpen(true);
        }}
      >
        <Network className="size-4" />
        {pending.length
          ? `加入申请 (${pending.length})`
          : unavailable
            ? "联机连接异常"
            : hosting
              ? "管理联机"
              : "邀请玩家"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{hosting ? "邀请与加入申请" : "邀请朋友一起玩"}</DialogTitle>
            <DialogDescription>
              {hosting
                ? online
                  ? "把房间码发给朋友，对方在首页点击「加入房间」即可申请。"
                  : "把内网地址发给同一局域网的朋友，对方在首页点击「加入房间」即可申请。"
                : "你来保存冒险和主持游戏，朋友无需提前导入模组。"}
            </DialogDescription>
          </DialogHeader>
          {opening && action.variables === "onlineHost" ? (
            <OnlineConnectionProgress target={roomId} hosting />
          ) : null}
          {hosting ? (
            <>
              <section className="space-y-4" aria-label="邀请信息">
                <div className="flex items-center gap-2 text-sm font-medium" role="status">
                  {online ? <Globe className="size-4" /> : <Network className="size-4" />}
                  {unavailable ? "邀请暂不可用" : online ? "互联网房间已开放" : "内网房间已开放"}
                </div>
                {online?.code && online.connected ? (
                  <RoomInvite key={online.code} value={online.code} online />
                ) : null}
                {unavailable ? (
                  <div className="space-y-2 text-sm">
                    <ConnectionError message={online.error ?? "联机服务连接已断开"} />
                    <p className="text-muted-foreground">
                      已连上的玩家仍可继续游戏。需要邀请新玩家时，请关闭联机后重新生成房间码。
                    </p>
                  </div>
                ) : null}
                {(status.data?.addresses ?? []).map((address) => (
                  <RoomInvite key={address} value={address} online={false} />
                ))}
                {!online && !status.data?.addresses.length ? (
                  <p role="status" className="text-sm">
                    未找到内网地址，请检查是否已连接 Wi-Fi 或网线。
                  </p>
                ) : null}
              </section>
              <section className="space-y-3 border-t pt-4" aria-label="加入申请">
                <h3 className="flex items-center justify-between text-sm font-medium">
                  加入申请{" "}
                  <span className="text-muted-foreground tabular-nums">{pending.length}</span>
                </h3>
                {pending.length ? (
                  pending.map((request) => (
                    <div key={request.id} className="flex items-center gap-2 py-2">
                      <span className="min-w-0 flex-1 text-sm break-words">{request.nickname}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: request.id, approve: false })}
                      >
                        拒绝
                      </Button>
                      <Button
                        size="sm"
                        disabled={action.isPending}
                        onClick={() => action.mutate({ id: request.id, approve: true })}
                      >
                        同意加入
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground py-2 text-sm" role="status">
                    等待朋友申请，收到后会在这里显示。
                  </p>
                )}
                <p className="text-muted-foreground text-xs">
                  可以关掉这个窗口继续游戏，有新申请时侧栏会显示数量。
                </p>
              </section>
              <div className="space-y-3 border-t pt-4">
                {confirmStop ? (
                  <div className="space-y-3">
                    <p className="text-sm">
                      关闭联机会断开所有玩家，再次开放后需要重新邀请。冒险和存档会保留。
                    </p>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        disabled={action.isPending}
                        onClick={() => setConfirmStop(false)}
                      >
                        继续联机
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={action.isPending}
                        onClick={() => action.mutate("stop")}
                      >
                        {action.isPending ? "正在关闭…" : "确认关闭联机"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-muted-foreground text-xs">退出冒险也会断开玩家。</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={action.isPending}
                      onClick={() => setConfirmStop(true)}
                    >
                      关闭联机
                    </Button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <Globe className="mt-0.5 size-5 shrink-0" />
                  <div className="space-y-1">
                    <h3 className="font-medium">用房间码邀请</h3>
                    <p className="text-muted-foreground text-sm">
                      生成六位房间码，发给异地的朋友。每位玩家都需要你同意才能进入。
                    </p>
                  </div>
                </div>
                <OnlinePrivacyNotice />
                <Button
                  className="w-full"
                  disabled={action.isPending || status.isPending || status.isError}
                  onClick={() => action.mutate("onlineHost")}
                >
                  {opening && action.variables === "onlineHost" ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Globe />
                  )}
                  {opening && action.variables === "onlineHost" ? "正在生成房间码…" : "生成房间码"}
                </Button>
                <p className="text-muted-foreground text-xs">
                  需要联网。当前使用直连，部分网络可能无法连接。
                </p>
              </div>
              <details className="border-t pt-4">
                <summary className="cursor-pointer text-sm font-medium">
                  在同一 Wi-Fi 下？使用内网联机
                </summary>
                <div className="space-y-3 pt-3">
                  <p className="text-muted-foreground text-sm">
                    同一局域网内可以通过地址加入，无需连接互联网。
                  </p>
                  <Button
                    variant="outline"
                    disabled={action.isPending || status.isPending || status.isError}
                    onClick={() => action.mutate("host")}
                  >
                    {opening && action.variables === "host" ? (
                      <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                    ) : (
                      <Network />
                    )}
                    {opening && action.variables === "host" ? "正在开放…" : "开放内网房间"}
                  </Button>
                </div>
              </details>
            </div>
          )}
          {action.error || status.error ? (
            <div className="space-y-2 text-sm">
              <ConnectionError
                message={action.error?.message ?? status.error?.message ?? "联机操作失败"}
              />
              {status.error ? (
                <Button variant="outline" onClick={() => void status.refetch()}>
                  重新读取状态
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
