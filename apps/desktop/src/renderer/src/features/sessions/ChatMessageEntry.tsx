import { chatText, visibleAgentMessages } from "@jointarp/core/shared/agent-message";
import { parseCompanionPerformance } from "@jointarp/core/shared/companion";
import type { ChatMessage } from "@jointarp/core/shared/game";
import { parseNarrative, type NarrativeSegment } from "@jointarp/core/shared/narrative";
import { documentIdentity } from "@jointarp/module/document-path";
import { Flag } from "lucide-react";
import {
  createContext,
  createElement,
  lazy,
  memo,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
} from "react";
import type { Components, ExtraProps } from "react-markdown";

import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { MovementCard } from "../maps/MovementCard";
import { useDocumentImage, useDocumentPortrait } from "../modules/document-image";
import { documentReferencePath } from "../modules/document-preview";
import {
  DocumentReference,
  documentMarkdownComponents,
  useDocumentReferenceDocument,
} from "../modules/DocumentReferences";
import { ReadAloudButton } from "../tts/SpeechControls";
import { AgentDetails } from "./AgentDetails";
import { CharacterAvatarMenu } from "./CharacterAvatarMenu";
import { HostAvatar } from "./HostAvatar";
import type { NpcPortraitResolver } from "./npc-portrait";
import { playerLabel, PlayerRolesContext } from "./player-role";
import { useFrameText } from "./use-frame-text";

import styles from "./ChatPanel.module.css";

// 进入聊天模块即预加载，在等待首字期间准备好渲染器。
const markdownModule = import("./ChatMarkdown");
const Markdown = lazy(() => markdownModule.then((module) => ({ default: module.ChatMarkdown })));
const MentionNavigation = createContext<((id: string) => void) | null>(null);

function NarrativeLink(props: ComponentProps<"a"> & ExtraProps) {
  const openMention = useContext(MentionNavigation);
  const path = props.href ? documentReferencePath(props.href) : undefined;
  const document = useDocumentReferenceDocument(path);
  const wiki = props.node?.properties?.["data-document-reference"] === "wiki";
  if (props.href?.startsWith("#mention/"))
    return (
      <button
        type="button"
        className="text-primary rounded-sm font-medium hover:underline"
        onClick={() => openMention?.(props.href!.slice(9))}
      >
        {props.children}
      </button>
    );
  if (path && (wiki || document))
    return (
      <DocumentReference key={path} value={path} referenceStyle="link" preserveText>
        {wiki ? undefined : props.children}
      </DocumentReference>
    );
  const Link = documentMarkdownComponents.a;
  return typeof Link === "function" ? (
    createElement(Link, props)
  ) : (
    <a href={props.href}>{props.children}</a>
  );
}

// 渲染组件类型保持稳定；导航回调变化通过 Context 更新，不重建链接及其资料预览。
const narrativeMarkdownComponents: Components = {
  ...documentMarkdownComponents,
  a: NarrativeLink,
};

const CompanionLines = memo(function CompanionLines({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const parts = parseCompanionPerformance(text);
  if (!parts.some((part) => part.kind === "action"))
    return <NarrativeText text={text} streaming={streaming} />;
  return parts.map((part, index) =>
    part.kind === "action" ? (
      <div key={index} className="text-muted-foreground">
        <NarrativeText text={part.text} streaming={streaming} />
      </div>
    ) : (
      <NarrativeText key={index} text={part.text} streaming={streaming} />
    ),
  );
});

const NarrativeText = memo(function NarrativeText({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  // 点名链接的目标只用于导航，流式中断也先收束链接，避免把地址显示成正文。
  const markdown = text.replace(/(\[((?:\\.|[^\]\\])*)\]\(#mention\/[^)\s]*)$/u, "$1)");
  const fallback = markdown.replace(/\[((?:\\.|[^\]\\])*)\]\(#mention\/[^)]*\)/gu, "$1");
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{fallback}</p>}>
      <Markdown components={narrativeMarkdownComponents} streaming={streaming}>
        {markdown}
      </Markdown>
    </Suspense>
  );
});

const statusLabels = {
  queued: "等待响应…",
  running: "正在续写…",
  complete: "",
  cancelled: "已停止",
  failed: "生成失败",
  interrupted: "生成已中断",
};

const hostWaitingLines = [
  "主持人正在假装一切尽在掌握…",
  "有个 NPC 临时决定给自己加戏…",
  "骰子滚到了桌子底下，稍等…",
  "正在劝反派别把计划全说出来…",
  "主持人翻开了那本「绝对没准备」的笔记…",
  "门后是什么？主持人也在紧张地翻页…",
  "正在给这次行动找一个体面的后果…",
  "某位路人正在争取成为重要角色…",
  "主持人正在确认你的队友有没有闯祸…",
  "剧情拐了个弯，主持人正在追它…",
] as const;

function WaitingLine({ host }: { host: boolean }) {
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * hostWaitingLines.length),
  );

  useEffect(() => {
    if (!host) return;
    const timer = window.setInterval(() => {
      setLineIndex(
        (current) =>
          (current + 1 + Math.floor(Math.random() * (hostWaitingLines.length - 1))) %
          hostWaitingLines.length,
      );
    }, 7000);
    return () => window.clearInterval(timer);
  }, [host]);

  return (
    <div
      role="status"
      aria-label={host ? "主持人正在回应" : "正在思考"}
      className="flex min-h-7 items-center gap-2.5"
    >
      <span
        aria-hidden="true"
        className={`${styles.thinkingDot} size-2 shrink-0 rounded-full bg-current`}
      />
      <span
        key={host ? lineIndex : "companion"}
        aria-hidden="true"
        className={`${styles.thinkingLabel} text-muted-foreground text-sm`}
      >
        {host ? hostWaitingLines[lineIndex] : "正在思考…"}
      </span>
    </div>
  );
}

interface MessageEntryProps {
  currentPlayerId?: string;
  speechOwner: string;
  speechId: string;
  speechEnabled: boolean;
  message: Exclude<ChatMessage, { kind: "dice" }>;
  grouped: boolean;
  onOpenCharacterCard: (characterId: string) => void;
  onQuickMention: (id: string) => void;
  onConvertToChat?: (id: string) => void;
  convertingMessageId?: string | null;
  detailsMessage?: ChatMessage;
  hostName?: string;
  hostAvatar?: string;
  resolveNpcPortrait: NpcPortraitResolver;
}

export const MessageEntry = memo(function MessageEntry(props: MessageEntryProps) {
  const { message } = props;
  const roles = useContext(PlayerRolesContext);
  const playerCharacterNames = useMemo(
    () => new Set(Array.from(roles.values(), (role) => role.name)),
    [roles],
  );
  const playerCharacterPaths = useMemo(
    () =>
      new Set(
        [...roles.values()].flatMap((role) => (role.path ? [documentIdentity(role.path)] : [])),
      ),
    [roles],
  );
  if (message.kind !== "assistant" || message.companionId) return <MessageSegment {...props} />;
  // 开场初始化复用普通主持消息的等待与运行状态，不把内部回复当作剧情展示。
  if (message.internal && message.status === "running")
    return <MessageSegment {...props} textOverride="" />;
  const sources = visibleAgentMessages(message).map((item) =>
    item.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  );
  const segments = sources.flatMap((text, index) =>
    parseNarrative(text, playerCharacterNames, playerCharacterPaths).map((segment) => ({
      ...segment,
      renderKey: `${index}:${segment.key}`,
    })),
  );
  // 首字沿用等待行的实例，避免头像与正文卸载重建、丢失流式缓冲。
  if (!segments.length) return [<MessageSegment key="0:0" {...props} textOverride="" />];
  return segments.map((segment, index) => (
    <MessageSegment
      {...props}
      key={segment.renderKey}
      speechId={`${props.speechId}:${segment.renderKey}`}
      message={index === segments.length - 1 ? message : { ...message, status: "complete" }}
      speaker={segment}
      textOverride={segment.text}
      detailsMessage={index === 0 ? props.detailsMessage : undefined}
    />
  ));
});

const MessageSegment = memo(function MessageSegment({
  currentPlayerId,
  message,
  grouped,
  onOpenCharacterCard,
  onQuickMention,
  onConvertToChat,
  convertingMessageId,
  detailsMessage,
  speaker,
  textOverride,
  hostName,
  hostAvatar,
  resolveNpcPortrait,
  speechOwner,
  speechId,
  speechEnabled,
}: MessageEntryProps & {
  speaker?: NarrativeSegment;
  textOverride?: string;
}) {
  const companionMessage =
    message.kind === "assistant" && message.companionId ? message : undefined;
  const speechSource = textOverride ?? chatText(message);
  const live =
    (message.kind === "assistant" || message.kind === "scripted") && message.status === "running";
  const buffered = useFrameText(speechSource, live, !live && message.status !== "complete");
  const revealing = buffered !== speechSource;
  const text = buffered;
  const npc = speaker?.kind === "npc";
  const scriptedNpc = message.kind === "scripted" && Boolean(message.speakerPath);
  const scriptedHost = message.kind === "scripted" && !scriptedNpc;
  const companion = Boolean(companionMessage);
  const host = (message.kind === "assistant" && !npc && !companion) || scriptedHost;
  const roles = useContext(PlayerRolesContext);
  const speakerId =
    message.kind === "assistant" && message.companionId ? message.companionId : message.senderId;
  const role = host ? undefined : roles.get(speakerId);
  const characterId = message.kind === "player" || companion ? role?.characterId : undefined;
  const npcPath = npc ? speaker.path : scriptedNpc ? message.speakerPath : undefined;
  const npcPortrait = npcPath ? resolveNpcPortrait(npcPath) : undefined;
  const portrait = npcPath ? npcPortrait : role;
  const name =
    npc || scriptedNpc
      ? (npc ? speaker.name : message.nickname === "NPC" ? "" : message.nickname) ||
        npcPortrait?.title ||
        "NPC"
      : (speaker?.name ??
        (companion
          ? message.nickname
          : host || message.kind === "assistant"
            ? (hostName ?? "主持人")
            : playerLabel(message.nickname, role)));
  const time = new Date(message.createdAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const openMention = useMemo(
    () => (id: string) => {
      const selected = roles.get(id);
      if (selected?.characterId) onOpenCharacterCard(selected.characterId);
      else onQuickMention(id);
    },
    [roles, onOpenCharacterCard, onQuickMention],
  );
  const avatar = (
    <MessagePortrait
      host={host}
      active={live}
      assistant={message.kind === "assistant"}
      name={name}
      image={portrait?.image}
      path={portrait?.path}
      avatar={portrait?.avatar}
      hostAvatar={host ? hostAvatar : undefined}
      roomId={speechOwner}
    />
  );
  return (
    <MentionNavigation.Provider value={openMention}>
      <article
        className={`group/message relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 px-4 py-1 sm:grid-cols-[40px_minmax(0,1fr)] sm:gap-x-4 sm:px-6 ${grouped ? "" : "mt-4"} ${message.pendingAgent ? styles.pendingMessage : ""}`}
        aria-label={`${name}，${time}`}
        data-speaker-id={npc ? undefined : message.senderId}
      >
        {!live && !revealing && !(message.kind === "assistant" && message.internal) ? (
          <div className="absolute top-0 right-4 z-10 sm:right-6">
            <ReadAloudButton
              owner={speechOwner}
              id={speechId}
              text={speechSource}
              enabled={speechEnabled}
              speaker={
                message.kind === "assistant"
                  ? message.companionId
                    ? { roomId: message.roomId, kind: "companion", id: message.companionId }
                    : {
                        roomId: message.roomId,
                        kind: npc ? "npc" : "host",
                        id: npc ? speaker!.path! : "",
                      }
                  : message.kind === "scripted"
                    ? {
                        roomId: message.roomId,
                        kind: message.speakerPath ? "npc" : "host",
                        id: message.speakerPath ?? "",
                      }
                    : undefined
              }
            />
          </div>
        ) : null}
        {grouped ? (
          <time
            dateTime={message.createdAt}
            className="text-muted-foreground pt-1.5 text-center text-[10px] tabular-nums opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100"
          >
            {time}
          </time>
        ) : (
          <div className="mt-0.5">
            {characterId ? (
              <CharacterAvatarMenu
                name={role?.name ?? name}
                onMention={
                  (companion || message.kind === "player") &&
                  role &&
                  currentPlayerId &&
                  speakerId !== currentPlayerId
                    ? () => onQuickMention(speakerId)
                    : undefined
                }
                onOpenCard={() => onOpenCharacterCard(characterId)}
                className="rounded-full outline-none"
              >
                {avatar}
              </CharacterAvatarMenu>
            ) : (npc || scriptedNpc) && portrait?.path ? (
              <div className="rounded-full">
                <DocumentReference value={portrait.path} variant="card">
                  <span className="sr-only">查看{name}的文档</span>
                  {avatar}
                </DocumentReference>
              </div>
            ) : (
              avatar
            )}
          </div>
        )}
        <div className="min-w-0">
          {!grouped ? (
            <div className="mb-0.5 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-foreground text-sm font-semibold">{name}</span>
              {message.kind === "player" && currentPlayerId && speakerId === currentPlayerId ? (
                <span className="rounded bg-blue-100 px-1 py-px text-[10px] leading-3 font-semibold text-blue-700 dark:bg-blue-400/20 dark:text-blue-300">
                  你
                </span>
              ) : null}
              {scriptedNpc || npc ? (
                <span className="bg-muted text-muted-foreground rounded px-1 py-px text-[9px] leading-3 font-medium">
                  NPC
                </span>
              ) : null}
              {message.pendingAgent ? (
                <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] leading-3 font-medium text-amber-700 dark:text-amber-300">
                  待提交给主持人
                </span>
              ) : null}
              {(message.kind === "player" && !message.chatOnly) ||
              companionMessage?.chatOnly === false ? (
                <Tooltip content="行动 · 交给主持裁定">
                  <span
                    role="img"
                    aria-label="行动"
                    tabIndex={0}
                    className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-blue-600 outline-none focus-visible:ring-1 focus-visible:ring-current dark:text-blue-400"
                  >
                    <Flag aria-hidden="true" className="size-3 fill-current" />
                  </span>
                </Tooltip>
              ) : null}
              {message.kind === "player" &&
              message.senderId === currentPlayerId &&
              message.pendingAgent &&
              onConvertToChat ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  tooltip="撤回这条待提交行动，正文保留为聊天"
                  disabled={Boolean(convertingMessageId)}
                  onClick={() => onConvertToChat(message.id)}
                >
                  {convertingMessageId === message.id ? "正在修改…" : "改为聊天"}
                </Button>
              ) : null}
              <time
                className="text-muted-foreground ml-1 text-[11px] opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100"
                dateTime={message.createdAt}
              >
                {time}
              </time>
            </div>
          ) : null}
          {detailsMessage ? (
            <AgentDetails key={detailsMessage.id} message={detailsMessage} />
          ) : null}
          {message.kind === "assistant" || message.kind === "scripted" ? (
            <div
              aria-busy={live}
              className="[&_a]:text-ring [&_pre]:bg-muted text-foreground [&_blockquote]:border-border [&_blockquote]:bg-muted [&_strong]:text-foreground min-h-7 space-y-3 text-[15px] leading-7 break-words [&_a]:underline [&_blockquote]:rounded-r-md [&_blockquote]:border-l-2 [&_blockquote]:px-4 [&_blockquote]:py-1 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:font-semibold [&_img]:max-h-96 [&_img]:rounded-xl [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:p-3 [&_strong]:font-semibold [&_ul]:list-disc"
            >
              {message.status === "queued" ? (
                <p className="text-muted-foreground">等待响应…</p>
              ) : (live || revealing) && !text.trim() ? (
                <WaitingLine host={host} />
              ) : companion ? (
                text.trim() ? (
                  <CompanionLines text={text} streaming={live || revealing} />
                ) : null
              ) : (
                <NarrativeText text={text || "本次未生成内容。"} streaming={live || revealing} />
              )}
            </div>
          ) : message.kind === "player" ? (
            <>
              {message.text ? (
                <div className="text-foreground text-[15px] leading-7 break-words [&_p]:whitespace-pre-wrap">
                  <NarrativeText text={message.text} />
                </div>
              ) : null}
              {message.movement ? (
                <MovementCard
                  roomId={message.roomId}
                  messageId={message.id}
                  sequence={message.sequence}
                  intent={message.movement}
                  submitted={!message.chatOnly}
                />
              ) : null}
            </>
          ) : null}
          {message.status !== "complete" && message.status !== "queued" && !live ? (
            <p role="status" className="text-muted-foreground mt-1 text-xs">
              {message.error || statusLabels[message.status]}
            </p>
          ) : null}
        </div>
      </article>
    </MentionNavigation.Provider>
  );
});

function MessagePortrait({
  roomId,
  host,
  assistant,
  name,
  image,
  path,
  avatar,
  hostAvatar,
  active,
}: {
  active: boolean;
  host: boolean;
  assistant: boolean;
  name: string;
  image?: string;
  path?: string | null;
  avatar?: string;
  hostAvatar?: string;
  roomId: string;
}) {
  const portrait = useDocumentPortrait(path, avatar, image);
  const hostSrc = useDocumentImage("", hostAvatar, `room-module:${roomId}`);
  const [failedHostSrc, setFailedHostSrc] = useState<string>();
  const resolvedHostSrc = hostSrc && hostSrc !== failedHostSrc ? hostSrc : undefined;
  const defaultHost = host && !resolvedHostSrc;
  return (
    <span
      className={`flex size-9 items-center justify-center sm:size-10 ${defaultHost ? "" : `overflow-hidden rounded-full ${host || assistant ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground"}`}`}
    >
      {defaultHost ? (
        <HostAvatar active={active} />
      ) : host ? (
        <img
          src={resolvedHostSrc}
          onError={() => setFailedHostSrc(hostSrc)}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : portrait.src ? (
        <img {...portrait} alt="" draggable={false} className="size-full object-cover" />
      ) : (
        <span className="text-sm font-medium">{Array.from(name.trim())[0] || "玩"}</span>
      )}
    </span>
  );
}
