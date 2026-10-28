import type { ChatMessage } from "@jointarp/core/shared/game";
import type { GameSession, SessionModule } from "@jointarp/core/shared/session";
import type { Character } from "@jointarp/module/character";
import { documentIdentity } from "@jointarp/module/document-path";
import type { SpeechPart } from "@shared/speech-text";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import { Tooltip } from "../../components/ui/tooltip";
import { desktopRpc } from "../../desktop-rpc";
import { speechPlayer, useSpeech } from "../tts/use-speech";
import { CharacterCardDialog } from "./CharacterCardDialog";
import { chatTimeline } from "./chat-timeline";
import { ChatComposer } from "./ChatComposer";
import { MessageEntry } from "./ChatMessageEntry";
import { ChatMessageList, type ChatMessageListHandle } from "./ChatMessageList";
import { DiceCard } from "./DiceCard";
import type { GameClient } from "./game-client";
import { LaunchCard } from "./LaunchCard";
import { createNpcPortraitResolver } from "./npc-portrait";
import { PlayerRolesContext, type PlayerRole } from "./player-role";
import { ReadyLobby } from "./ReadyLobby";
import { useChatComposer } from "./use-chat-composer";
import { useChatLog } from "./use-chat-log";
import { useComposerFocus } from "./use-composer-focus";
import { usePlayerProfile } from "./use-player-profile";
import { useRoomCompanions } from "./use-room-companions";
import { useRoomNpcDocuments } from "./use-room-visible-documents";

import styles from "./ChatPanel.module.css";
const emptyCharacters: readonly Character[] = [];
const emptyRoles: readonly PlayerRole[] = [];

async function isHostModelReady(roomId: string, signal?: AbortSignal) {
  const settings = await desktopRpc.sessions.ai.get({ roomId }, { signal });
  return Boolean(settings.selection && settings.ready);
}

export interface ChatPanelHandle {
  mention(id: string): void;
}

interface ChatPanelProps {
  actionsRef?: Ref<ChatPanelHandle>;
  /** 进入遮罩已撤下、工具对话框已关闭时接管直接输入。 */
  active: boolean;
  roomId: string;
  session: GameSession;
  characters?: readonly Character[];
  client?: GameClient;
  statusSlot?: HTMLDivElement | null;
  onOpenRoomSettings: () => void;
  showReasoning?: boolean;
  /** 角色已确认且开场已讲完。未完成时不把正式行动发给主持人。 */
  hostReady?: boolean;
  module: SessionModule;
  /** 房间仍停在准备确认，封面页可以先于聊天记录出现。 */
  prelude?: boolean;
  onGateChange?: (open: boolean) => void;
  /** 首屏日志已有结果，父级可以撤下进入遮罩。 */
  onViewReady?: (lobby: boolean) => void;
  onAssistantSettled?: () => void;
  roles?: readonly PlayerRole[];
}

export function ChatPanel(props: ChatPanelProps) {
  // 房间切换时完整重置订阅和草稿；设置弹层不卸载房间。
  return <RoomChat key={props.roomId} {...props} />;
}

function findReadyCard(messages: readonly ChatMessage[]) {
  for (const message of messages) {
    if (message.kind === "card" && message.card.type === "ready") return message;
  }
  return undefined;
}

function RoomChat({
  actionsRef,
  active,
  roomId,
  session,
  characters = emptyCharacters,
  client = desktopRpc.game,
  statusSlot = null,
  onOpenRoomSettings,
  showReasoning = false,
  hostReady = true,
  module,
  prelude = false,
  onGateChange,
  onViewReady,
  onAssistantSettled,
  roles = emptyRoles,
}: ChatPanelProps) {
  const [openCharacterId, setOpenCharacterId] = useState<string | null>(null);
  const messageList = useRef<ChatMessageListHandle>(null);
  const bottom = useRef(true);
  const speech = useSpeech(roomId);
  const speechPlayerNames = useMemo(() => new Set(roles.map((role) => role.name)), [roles]);
  const speechPlayerPaths = useMemo(
    () => new Set(roles.flatMap((role) => (role.path ? [documentIdentity(role.path)] : []))),
    [roles],
  );
  const onSpeechMessage = useCallback(
    (id: string, parts: SpeechPart[]) => {
      if (speech.available && speech.settings.data?.automatic)
        for (const part of parts)
          speechPlayer.enqueue({
            owner: roomId,
            key: `${roomId}:${id}:${part.key}`,
            text: part.text,
            speaker: part.speaker,
          });
    },
    [roomId, speech.available, speech.settings.data?.automatic],
  );
  const log = useChatLog({
    client,
    roomId,
    bottom,
    onAssistantSettled,
    onSpeechMessage,
    playerCharacterNames: speechPlayerNames,
    playerCharacterPaths: speechPlayerPaths,
  });
  const {
    messages,
    error,
    reportError,
    connection,
    hasMore,
    loadingHistory,
    ready,
    viewReady,
    unread,
    clearUnread,
    loadOlder,
  } = log;
  const profile = usePlayerProfile(reportError);
  const { player } = profile;
  const party = useRoomCompanions(roomId);
  const relayActive = Boolean(
    party.data?.members.find((member) => member.id === player?.id)?.relay,
  );
  const reclaim = useMutation({
    mutationFn: () => desktopRpc.sessions.companion.reclaim({ roomId }),
    onSuccess: () => party.refetch(),
  });
  const openCharacter =
    characters.find((item) => item.id === openCharacterId) ??
    party.data?.characters.find((item) => item.id === openCharacterId)?.card;
  const roleMap = useMemo(() => {
    const map = new Map(roles.map((role) => [role.playerId, role]));
    for (const seat of party.data?.seats ?? []) {
      if (!seat.companion) continue;
      const character = party.data?.characters.find(
        (item) => item.id === seat.companion?.characterId,
      );
      if (!character) continue;
      const current = map.get(seat.id);
      map.set(seat.id, {
        playerId: seat.id,
        characterId: character.id,
        name: character.name,
        image: character.image ?? current?.image,
        path: character.card?.sourcePath,
        avatar: character.avatar,
      });
    }
    return map;
  }, [roles, party.data]);
  const npcViews = useRoomNpcDocuments(roomId, messages, session.documents, speechPlayerNames);
  const resolveNpcPortrait = useMemo(() => createNpcPortraitResolver(npcViews), [npcViews]);
  const timeline = useMemo(() => chatTimeline(messages, showReasoning), [messages, showReasoning]);
  const onBottomChange = useCallback(
    (atBottom: boolean) => {
      bottom.current = atBottom;
      if (atBottom) clearUnread();
    },
    [clearUnread],
  );
  const lastPlayerSequence =
    messages.filter((message) => message.kind === "player").at(-1)?.sequence ?? 0;
  const mentionTargets = useQuery({
    queryKey: [
      "chat-mention-targets",
      roomId,
      party.dataUpdatedAt,
      lastPlayerSequence,
      findReadyCard(messages)?.revision ?? 0,
      player?.id,
      player?.nickname,
    ],
    queryFn: ({ signal }) => client.chat.mentionTargets({ roomId }, { signal }),
    enabled: ready && Boolean(player),
    // 此键含当前身份版本；旧版本无需按普通查询缓存保留半小时。
    gcTime: 0,
  });
  const mentions = useMemo(
    () =>
      (mentionTargets.data ?? [])
        .filter((target) => target.id !== player?.id)
        .map((target) => ({ ...target, name: target.label })),
    [mentionTargets.data, player?.id],
  );
  const [dockHeight, setDockHeight] = useState(0);
  const dockRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => setDockHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const announcedView = useRef(false);
  const onGateChangeRef = useRef(onGateChange);
  const onViewReadyRef = useRef(onViewReady);
  onGateChangeRef.current = onGateChange;
  onViewReadyRef.current = onViewReady;
  const composer = useChatComposer({
    roomId,
    client,
    isHostModelReady,
    player,
    ready,
    hostReady,
    relayActive,
    mentions,
    log,
    onOpenRoomSettings,
    onSent: () => {
      bottom.current = true;
      clearUnread();
      messageList.current?.scrollToBottom();
    },
  });
  const { chatStatus, quickMention } = composer;
  useImperativeHandle(actionsRef, () => ({ mention: quickMention }), [quickMention]);
  const readyCard = findReadyCard(messages);
  const storyStarted = messages.some(
    (message) =>
      message.kind === "scripted" || (message.kind === "card" && message.card.type !== "ready"),
  );
  const showLobby = !storyStarted && (readyCard !== undefined || (prelude && !ready));
  useComposerFocus(
    composer.mentionField,
    active && viewReady && !showLobby,
    composer.toggleChatOnly,
  );
  useEffect(() => {
    onGateChangeRef.current?.(showLobby);
    if (viewReady && !announcedView.current) {
      announcedView.current = true;
      onViewReadyRef.current?.(showLobby);
    }
    return () => onGateChangeRef.current?.(false);
  }, [showLobby, viewReady]);

  return (
    <PlayerRolesContext.Provider value={roleMap}>
      {statusSlot
        ? createPortal(
            <Tooltip content={chatStatus || undefined} overflowOnly>
              <p
                role="status"
                aria-atomic="true"
                className="text-muted-foreground flex min-w-0 items-center gap-2 text-[11px] leading-4"
              >
                {chatStatus ? (
                  <span aria-hidden="true" className={`${styles.typingDots} shrink-0`}>
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                  </span>
                ) : null}
                <span data-overflow-text className="truncate">
                  {chatStatus}
                </span>
              </p>
            </Tooltip>,
            statusSlot,
          )
        : null}
      <section className="flex min-h-0 flex-1 flex-col" aria-label="冒险聊天">
        {connection !== "已连接" && connection !== "正在连接…" ? (
          <p
            role="status"
            className="text-muted-foreground mx-auto w-full max-w-[840px] shrink-0 px-5 py-2 text-xs sm:px-7"
          >
            {connection}
          </p>
        ) : null}
        {showLobby ? (
          <>
            <ReadyLobby module={module} message={readyCard} roomId={roomId} playerId={player?.id} />
          </>
        ) : (
          <div className="motion-safe:animate-in motion-safe:fade-in relative flex min-h-0 min-w-0 flex-1 flex-col motion-safe:duration-500">
            <ChatMessageList
              ref={messageList}
              entries={timeline}
              hasMore={hasMore}
              loadingHistory={loadingHistory}
              onLoadOlder={() => void loadOlder()}
              onBottomChange={onBottomChange}
              unread={unread}
              bottomInset={dockHeight}
              emptyState={
                !messages.length ? (
                  <div className="flex min-h-72 flex-col items-center justify-center py-16 text-center">
                    <BookOpen className="text-ring mx-auto mb-5 size-8" strokeWidth={1.3} />
                    <h3 className="text-xl font-semibold">
                      {ready ? "开始这场冒险" : "正在加载消息"}
                    </h3>
                    <p className="text-muted-foreground mt-3 text-sm">
                      {ready ? "发条消息，和主持人一起开始故事。" : "正在同步这段冒险的记录…"}
                    </p>
                  </div>
                ) : null
              }
              renderMessage={({ message, key, grouped, detailsMessage }) => {
                if (message.kind === "card")
                  return (
                    <LaunchCard
                      message={message}
                      roomId={roomId}
                      onOpenCharacterCard={setOpenCharacterId}
                    />
                  );
                if (message.kind === "dice")
                  return <DiceCard message={message} player={player} client={client} />;
                return (
                  <MessageEntry
                    currentPlayerId={player?.id}
                    speechOwner={roomId}
                    speechId={`${roomId}:${key}`}
                    speechEnabled={speech.available}
                    message={message}
                    hostName={session.module.hostName}
                    hostAvatar={session.module.hostAvatar}
                    resolveNpcPortrait={resolveNpcPortrait}
                    grouped={grouped}
                    onOpenCharacterCard={setOpenCharacterId}
                    onQuickMention={quickMention}
                    onConvertToChat={(id) => void composer.convertToChat(id)}
                    convertingMessageId={composer.convertingMessageId}
                    detailsMessage={showReasoning ? detailsMessage : undefined}
                  />
                );
              }}
            />
            <ChatComposer
              roomId={roomId}
              composer={composer}
              error={error}
              profile={profile}
              speech={speech}
              mentions={mentions}
              dockRef={dockRef}
              showReasoning={showReasoning}
              relay={
                relayActive
                  ? {
                      pending: reclaim.isPending,
                      error: reclaim.error?.message,
                      reclaim: () => reclaim.mutate(),
                    }
                  : undefined
              }
            />
          </div>
        )}
        <CharacterCardDialog
          character={openCharacter}
          session={session}
          open={Boolean(openCharacterId)}
          onOpenChange={(open) => {
            if (!open) setOpenCharacterId(null);
          }}
        />
      </section>
    </PlayerRolesContext.Provider>
  );
}
