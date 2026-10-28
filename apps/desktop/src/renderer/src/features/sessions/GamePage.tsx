import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useMatch, useNavigate, useParams } from "@tanstack/react-router";
import {
  Archive,
  BookOpen,
  Settings,
  NotebookText,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { GameSidebar } from "../../components/GameSidebar";
import { SidebarToggle } from "../../components/SidebarToggle";
import { Button, buttonVariants } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { LoadingIndicator } from "../../components/ui/loading-indicator";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { DocumentReferences } from "../modules/DocumentReferences";
import { CharacterSummary } from "./CharacterSummary";
import { ChatPanel, type ChatPanelHandle } from "./ChatPanel";
import { GameParty } from "./GameParty";
import { GameToolDialog } from "./GameToolDialog";
import { LanRoom, ReconnectRoom } from "./LanRoom";
import { RoomDocumentScope } from "./room-document";
import { RoomNotes } from "./RoomNotes";
import { useRoomLaunch, useRoomSession } from "./use-room-state";
import { WorldStateCard } from "./WorldStateCard";

/** 冒险与持续保存的游戏日志。 */
export function GamePage() {
  const chatActions = useRef<ChatPanelHandle>(null);
  const [activeTool, setActiveTool] = useState<"notes" | null>(null);
  const [atGate, setAtGate] = useState(false);
  const [chatSettled, setChatSettled] = useState(false);
  const [entranceSettled, setEntranceSettled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [peek, setPeek] = useState(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealSidebar = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    setPeek(true);
  };
  const hideSidebar = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => setPeek(false), 180);
  };
  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );
  const sidebarHidden = collapsed && !peek;
  const [panelOpen, setPanelOpen] = useState(false);
  const panelTrigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [chatStatusSlot, setChatStatusSlot] = useState<HTMLDivElement | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    const desktop = window.desktopEvents;
    desktop?.setGamePage(true);
    const stop = desktop?.onRequestLeaveRoom(() => setConfirmLeave(true));
    return () => {
      stop?.();
      desktop?.setGamePage(false);
    };
  }, []);
  const settingsPage = Boolean(useMatch({ from: "/game/$roomId/settings", shouldThrow: false }));
  const { roomId } = useParams({ from: "/game/$roomId" });
  const navigate = useNavigate();
  const lan = useQuery(desktopOrpc.lan.status.queryOptions({ input: { roomId } }));
  const openRoomSettings = () =>
    void navigate({ to: "/game/$roomId/settings", params: { roomId } });
  const display = useQuery(desktopOrpc.sessions.display.get.queryOptions({ input: { roomId } }));
  const session = useRoomSession(roomId);
  const launch = useRoomLaunch(roomId);
  const player = useQuery(desktopOrpc.player.get.queryOptions());
  const character = launch.data?.characters.find((c) => c.playerId === player.data?.id);
  const ready = launch.data
    ? launch.data.progress.confirmed && launch.data.room.opening === "complete"
    : launch.isSuccess;
  const active = session.data?.room.status !== "ended";
  const characterType = launch.data?.types.find((type) => type.id === character?.typeId);
  const characterError = player.error ?? launch.error;
  const shellPending = session.isPending || launch.isPending;
  const chatPending = session.isSuccess && active && !launch.isPending && !chatSettled;
  const booting = (shellPending || chatPending) && !session.error && !launch.error;
  const coverStage = atGate;

  const seenRoom = useRef(roomId);
  if (seenRoom.current !== roomId) {
    seenRoom.current = roomId;
    setActiveTool(null);
    setAtGate(false);
    setChatSettled(false);
    setEntranceSettled(false);
  }
  const finishBoot = useCallback((lobby: boolean) => {
    setAtGate(lobby);
    setChatSettled(true);
  }, []);
  useEffect(() => {
    if (booting) return;
    const frame = requestAnimationFrame(() => setEntranceSettled(true));
    return () => cancelAnimationFrame(frame);
  }, [booting]);
  useEffect(() => {
    if (session.data?.room.status !== "ended") return;
    void desktopRpc.windows.closeModule({ roomId });
  }, [roomId, session.data?.room.status]);
  useEffect(() => {
    return () => {
      void desktopRpc.windows.closeModule({ roomId });
    };
  }, [roomId]);
  const showGamePanel = panelOpen && ready && active;
  useEffect(() => {
    setPanelOpen(false);
  }, [roomId, ready, active]);
  const closeGamePanel = () => {
    setPanelOpen(false);
    panelTrigger.current?.focus();
  };
  return (
    <RoomDocumentScope roomId={roomId}>
      <DocumentReferences
        documents={session.data?.documents ?? []}
        types={session.data?.documentTypes ?? []}
        view="game"
      >
        <main className="text-foreground bg-background relative isolate flex h-full overflow-hidden">
          <div
            className="flex min-h-0 min-w-0 flex-1"
            inert={booting || undefined}
            aria-hidden={booting || undefined}
          >
            <SidebarToggle
              collapsed={collapsed}
              onToggle={() => {
                setPeek(false);
                setCollapsed((value) => !value);
              }}
              className={
                coverStage && collapsed
                  ? "bg-background/70 text-foreground backdrop-blur-md"
                  : undefined
              }
            />
            {ready && active ? (
              <Button
                ref={panelTrigger}
                variant="ghost"
                size="icon"
                className="text-muted-foreground aria-expanded:text-muted-foreground aria-expanded:hover:bg-muted aria-expanded:hover:text-foreground dark:aria-expanded:hover:bg-muted/50 absolute top-2 right-3 z-[60] [-webkit-app-region:no-drag] aria-expanded:bg-transparent"
                aria-label={showGamePanel ? "收起右侧栏" : "展开右侧栏"}
                tooltip={showGamePanel ? "收起右侧栏" : "展开右侧栏"}
                aria-expanded={Boolean(showGamePanel)}
                aria-controls={panelId}
                onClick={() => setPanelOpen((open) => !open)}
              >
                {showGamePanel ? (
                  <PanelRightClose className="size-4" />
                ) : (
                  <PanelRightOpen className="size-4" />
                )}
              </Button>
            ) : null}
            {collapsed ? (
              <div
                className="absolute inset-y-0 left-0 z-30 w-4"
                onPointerEnter={revealSidebar}
                onPointerLeave={hideSidebar}
              />
            ) : null}
            <aside
              inert={sidebarHidden || undefined}
              aria-hidden={sidebarHidden || undefined}
              onPointerEnter={collapsed ? revealSidebar : undefined}
              onPointerLeave={collapsed ? hideSidebar : undefined}
              className={`border-border/60 bg-sidebar text-sidebar-foreground flex w-60 shrink-0 flex-col border-r px-3 pt-14 pb-3 ${collapsed ? `absolute inset-y-0 left-0 z-40 shadow-[8px_0_24px_-12px_rgba(0,0,0,0.45)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${sidebarHidden ? "pointer-events-none -translate-x-full" : "translate-x-0"}` : ""}`}
            >
              <ScrollAreaPane
                className="min-h-0 flex-1"
                viewportClassName="overscroll-contain"
                // Base UI 的内联 min-width: fit-content 会让长名称撑宽侧栏。
                contentClassName="w-full min-w-0! max-w-full"
              >
                {session.data ? (
                  <>
                    <GameParty
                      key={roomId}
                      roomId={roomId}
                      session={session.data}
                      characters={launch.data?.characters ?? []}
                      player={player.data}
                      isHost={lan.data?.remote === false}
                      onMention={
                        ready && active ? (id) => chatActions.current?.mention(id) : undefined
                      }
                    />
                    {ready && active ? (
                      <div className="px-2 pt-2">
                        <WorldStateCard session={session.data} />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </ScrollAreaPane>
              <LanRoom roomId={roomId} />
              <nav
                aria-label="冒险导航"
                className="border-border/40 mt-auto grid shrink-0 grid-cols-3 items-center gap-1 border-t pt-3"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="模组设定"
                  tooltip="模组设定 · 在新窗口打开"
                  disabled={!session.data}
                  onClick={() => void desktopRpc.windows.openModule({ roomId })}
                  className="text-muted-foreground h-11 w-full rounded-xl"
                >
                  <BookOpen className="size-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="笔记"
                  tooltip={!ready || !active ? "笔记 · 开始冒险后可用" : "笔记"}
                  aria-haspopup="dialog"
                  aria-expanded={ready && activeTool === "notes"}
                  disabled={!ready || !active}
                  onClick={() => setActiveTool("notes")}
                  className="text-muted-foreground aria-expanded:text-sidebar-accent-foreground h-11 w-full rounded-xl"
                >
                  <NotebookText className="size-5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-11 w-full rounded-xl ${settingsPage ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`}
                  aria-label="冒险设置"
                  tooltip="冒险设置"
                  aria-haspopup="dialog"
                  aria-expanded={settingsPage}
                  onClick={openRoomSettings}
                  disabled={!session.data || lan.data?.remote !== false}
                >
                  <Settings className="size-5" />
                </Button>
              </nav>
              <Dialog open={confirmLeave} onOpenChange={setConfirmLeave}>
                <DialogContent className="z-[100]" overlayClassName="z-[100]">
                  <DialogHeader>
                    <DialogTitle>退出游戏？</DialogTitle>
                    <DialogDescription>
                      {lan.data?.remote
                        ? "退出后断开房间连接，可从首页记录重新加入；未被移除时无需重复审核。存档保存在房主电脑。"
                        : "这段冒险会保持进行中。退出会停止联机，其他玩家将断开连接。"}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
                    <Button
                      onClick={async () => {
                        await desktopRpc.lan.stop({ roomId });
                        setConfirmLeave(false);
                        void navigate({ to: "/" });
                      }}
                    >
                      退出游戏
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </aside>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <header
                aria-hidden={coverStage || undefined}
                inert={(coverStage && !session.error && !launch.error) || undefined}
                className={`relative flex shrink-0 items-center gap-3 overflow-hidden pr-14 motion-reduce:transition-none ${entranceSettled ? "transition-[height,opacity] duration-500 ease-out" : ""} ${collapsed ? "pl-32" : "pl-5"} ${coverStage ? "h-0 opacity-0" : "h-12 opacity-100"}`}
              >
                <h1 className="max-w-[50%] min-w-0 truncate text-xs font-medium">聊天</h1>
                <div ref={setChatStatusSlot} className="max-w-[70%] min-w-0" />
              </header>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {session.error || (launch.data === undefined && launch.error) ? (
                  <div role="alert" className="p-8">
                    <p className="text-destructive mb-4">
                      无法打开冒险：{session.error?.message ?? launch.error?.message}
                    </p>
                    {lan.data?.remote ? (
                      <ReconnectRoom roomId={roomId} />
                    ) : (
                      <Button
                        onClick={() => {
                          void launch.refetch();
                        }}
                      >
                        重试
                      </Button>
                    )}
                  </div>
                ) : null}
                {session.data && !active ? (
                  <section className="grid min-h-0 flex-1 place-items-center p-8">
                    <div className="max-w-sm text-center">
                      <div className="bg-muted mx-auto grid size-11 place-items-center rounded-xl">
                        <Archive className="text-muted-foreground size-5" />
                      </div>
                      <h2 className="mt-4 text-base font-semibold">这段冒险已经结束</h2>
                      <p className="text-muted-foreground mt-2 text-sm leading-6">
                        存档仍完整保留。可以在历史冒险里重新开启后继续。
                      </p>
                      <Link
                        data-ui-control
                        to="/history"
                        className={buttonVariants({ className: "mt-5" })}
                      >
                        前往历史冒险
                      </Link>
                    </div>
                  </section>
                ) : null}
                {session.data && active && !launch.isPending ? (
                  <>
                    <div className="flex min-h-0 min-w-0 flex-1">
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <ChatPanel
                          actionsRef={chatActions}
                          active={!booting && !settingsPage && activeTool === null && !confirmLeave}
                          roomId={roomId}
                          session={session.data}
                          characters={launch.data?.characters ?? []}
                          statusSlot={chatStatusSlot}
                          showReasoning={display.data?.showReasoning ?? false}
                          onOpenRoomSettings={openRoomSettings}
                          hostReady={!launch.data || ready}
                          module={session.data.module}
                          prelude={launch.data?.room.intro === "ready"}
                          onGateChange={setAtGate}
                          onViewReady={finishBoot}
                          roles={
                            launch.data?.characters.flatMap((item) =>
                              item.playerId
                                ? [
                                    {
                                      playerId: item.playerId,
                                      characterId: item.id,
                                      name: item.name,
                                      image: item.image,
                                      path: item.sourcePath,
                                      avatar: item.avatar,
                                    },
                                  ]
                                : [],
                            ) ?? []
                          }
                        />
                      </div>
                    </div>
                    <GameToolDialog
                      key={`notes:${roomId}`}
                      open={ready && activeTool === "notes"}
                      onOpenChange={(open) => {
                        if (!open) setActiveTool(null);
                      }}
                      title="笔记"
                      description="记录这段冒险的线索、人物和待办事项，内容自动保存。"
                      preserveState
                    >
                      {player.data ? (
                        <RoomNotes
                          key={`${roomId}:${player.data.id}`}
                          roomId={roomId}
                          playerId={player.data.id}
                        />
                      ) : (
                        <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
                          {player.isError
                            ? "无法读取玩家信息，请重新进入冒险。"
                            : "正在读取玩家信息…"}
                        </div>
                      )}
                    </GameToolDialog>
                  </>
                ) : null}
              </div>
            </div>
            {showGamePanel ? (
              <GameSidebar
                id={panelId}
                label="游戏面板"
                width={characterType?.layout?.sheet?.width ?? 360}
                reservedWidth={360 + (collapsed ? 0 : 240)}
                onClose={closeGamePanel}
              >
                <>
                  {characterError ? (
                    <div role="alert" className="mb-5 space-y-2">
                      <p className="text-destructive text-sm">角色数据刷新失败，请重试。</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={player.isFetching || launch.isFetching}
                        onClick={() => {
                          void player.refetch();
                          void launch.refetch();
                        }}
                      >
                        重试
                      </Button>
                    </div>
                  ) : null}
                  {character ? (
                    <CharacterSummary
                      character={character}
                      documentType={characterType}
                      session={session.data}
                      compact
                    />
                  ) : (
                    <p role="status" className="text-muted-foreground text-sm leading-6">
                      {player.isPending
                        ? "正在读取角色…"
                        : characterError
                          ? "暂时无法读取角色。"
                          : "当前玩家尚未绑定角色。"}
                    </p>
                  )}
                </>
              </GameSidebar>
            ) : null}
          </div>
          <Outlet />
          {booting ? (
            <div className="bg-background absolute inset-0 z-[80] grid place-items-center">
              <LoadingIndicator label="正在读取冒险…" />
            </div>
          ) : null}
        </main>
      </DocumentReferences>
    </RoomDocumentScope>
  );
}
