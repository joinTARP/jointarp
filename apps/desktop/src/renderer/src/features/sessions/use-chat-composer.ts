import type {
  ChatMessage,
  Player,
  SendInput,
  SubmissionMode,
  SteeringSnapshot,
} from "@jointarp/core/shared/game";
import { parseMentionRefs } from "@jointarp/core/shared/mentions";
import type { ChatActivitySnapshot } from "@jointarp/core/shared/room-state";
import { useCallback, useEffect, useRef, useState } from "react";

import { errorMessage, type GameClient } from "./game-client";
import {
  draftText,
  draftMarkdown,
  trimDraft,
  type MentionCandidate,
  type MentionDraft,
} from "./mention";
import type { MentionFieldHandle } from "./MentionField";
import type { ChatLogActions } from "./use-chat-log";
interface ChatComposerOptions {
  roomId: string;
  client: GameClient;
  isHostModelReady(roomId: string, signal?: AbortSignal): Promise<boolean>;
  player: Player | null;
  ready: boolean;
  relayActive?: boolean;
  hostReady: boolean;
  mentions: readonly MentionCandidate[];
  log: {
    messages: readonly ChatMessage[];
    submissionMode: SubmissionMode;
    steering: SteeringSnapshot;
    isHost: boolean;
    chatActivity?: ChatActivitySnapshot;
    pendingIds: ReadonlySet<string>;
    actions: ChatLogActions;
  };
  onOpenRoomSettings(): void;
  onSent(): void;
}

/** 输入状态与提交请求共用幂等标识；界面组件只消费操作和可见状态。 */
export function useChatComposer({
  roomId,
  client,
  isHostModelReady,
  player,
  ready,
  relayActive = false,
  hostReady,
  mentions,
  log,
  onOpenRoomSettings,
  onSent: scrollToBottom,
}: ChatComposerOptions) {
  const { messages, submissionMode, pendingIds, actions, steering, isHost, chatActivity } = log;
  const { reportError } = actions;
  const [draft, setDraft] = useState<MentionDraft>([]);
  const visibleDraft = draftText(draft);
  const currentText = draftMarkdown(trimDraft(draft));
  const draftRefs = parseMentionRefs(currentText);
  const playerId = player?.id;
  const mentionField = useRef<MentionFieldHandle>(null);
  const quickMention = useCallback((id: string) => mentionField.current?.mention(id), []);
  const [chatOnly, setChatOnly] = useState(false);
  const automaticChat = draftRefs.some((part) => mentions.some((target) => target.id === part.id));
  const effectiveChatOnly = chatOnly || automaticChat;
  const [sending, setSending] = useState(false);
  const [modeChanging, setModeChanging] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [convertingMessageId, setConvertingMessageId] = useState<string | null>(null);
  const convertLock = useRef(false);
  const [failedSends, setFailedSends] = useState<SendInput[]>([]);
  const draftRetryPayload = failedSends.find(
    (item) => item.text === currentText.trim() && item.chatOnly === chatOnly,
  );
  const retryingDraft = Boolean(draftRetryPayload);
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const [openingPending, setOpeningPending] = useState(false);
  const steeringRequest = useRef<{ text: string; id: string } | null>(null);
  const steeringSubmitRequest = useRef<string | null>(null);
  const [steeringWorking, setSteeringWorking] = useState(false);
  const steeringLock = useRef(false);
  const sendingLock = useRef(false);
  const continueLock = useRef(false);
  const continueRequest = useRef<{ id: string; pendingIds: Set<string> } | null>(null);
  const runLock = useRef(false);
  const pendingInput = chatActivity?.pendingInput;
  const activeMessage = chatActivity?.running;
  const queuedMessage = chatActivity?.queued;
  const busy = Boolean(activeMessage);
  const canSteer =
    steering.enabled && busy && !activeMessage?.companionId && !activeMessage?.chatOnly;
  const steeringMode = canSteer && !effectiveChatOnly && !retryingDraft;
  useEffect(() => {
    const request = continueRequest.current;
    if (request && ![...request.pendingIds].some((id) => pendingIds.has(id)))
      continueRequest.current = null;
  }, [pendingIds]);
  const chatStatus = continuing
    ? "正在提交给主持人…"
    : sending
      ? "正在发送…"
      : busy
        ? activeMessage?.companionId
          ? `${activeMessage.nickname} 正在思考，你可以插话`
          : "主持人正在回应"
        : "";
  const lastAssistant = messages.filter((message) => message.kind === "assistant").at(-1);
  const canContinueOpening =
    ready &&
    !hostReady &&
    !busy &&
    !messages.some(
      (message) =>
        message.kind === "card" &&
        message.card.type === "companions" &&
        message.status === "running",
    ) &&
    lastAssistant &&
    !lastAssistant.companionId &&
    ["failed", "interrupted", "cancelled"].includes(lastAssistant.status);

  async function continueOpening() {
    if (!ready || openingPending) return;
    setOpeningPending(true);
    reportError("");
    const signal = actions.requestSignal();
    try {
      await client.launch.open({ roomId }, { signal });
    } catch (reason) {
      if (signal?.aborted) return;
      reportError(`无法继续开场：${errorMessage(reason)}`);
    } finally {
      if (!signal?.aborted) setOpeningPending(false);
    }
  }

  useEffect(() => {
    if (!playerId) return;
    try {
      setChatOnly(
        localStorage.getItem(`tarp:chat-only:experimental:${playerId}:${roomId}`) === "true",
      );
    } catch {
      setChatOnly(false);
    }
  }, [playerId, roomId]);

  async function send(retry?: SendInput) {
    if (relayActive || sendingLock.current || continuing || modeChanging || !player || !ready)
      return;
    const text = (retry?.text ?? currentText).trim();
    if (!text) return;
    const refs = parseMentionRefs(text);
    const only = retry?.chatOnly ?? chatOnly;
    const submittedDraft = currentText === text && chatOnly === only ? draft : undefined;
    const directed = refs.some((part) => mentions.some((target) => target.id === part.id));
    const effectiveOnly = only || directed;
    const retryPayload = retry ?? draftRetryPayload;
    if (!effectiveOnly && pendingInput) {
      reportError("有尚未送达主持的行动，请房主先重试或放弃；期间可以仅聊天。");
      return;
    }
    if (!retryPayload && !effectiveOnly && !hostReady) {
      reportError(
        "开场还没完成，主持人暂时不会回应。输入已保留。想先和同伴说话，请切换到「聊天」模式。",
      );
      return;
    }
    if (!retryPayload && !effectiveOnly && (canSteer || steeringRequest.current?.text === text)) {
      sendingLock.current = true;
      setSending(true);
      reportError("");
      const signal = actions.requestSignal();
      const request =
        steeringRequest.current?.text === text
          ? steeringRequest.current
          : { text, id: crypto.randomUUID() };
      steeringRequest.current = request;
      try {
        const snapshot = await client.steering.enqueue(
          {
            roomId,
            text,
            clientRequestId: request.id,
          },
          { signal },
        );
        if (signal?.aborted) return;
        actions.acceptSteering(snapshot);
        steeringRequest.current = null;
        setDraft((current) => (current === submittedDraft ? [] : current));
      } catch (reason) {
        if (!signal?.aborted) {
          if (
            reason &&
            typeof reason === "object" &&
            "code" in reason &&
            [
              "BAD_REQUEST",
              "CONFLICT",
              "PRECONDITION_FAILED",
              "TOO_MANY_REQUESTS",
              "FORBIDDEN",
            ].includes(String(reason.code))
          )
            steeringRequest.current = null;
          reportError(`${errorMessage(reason)} 输入已保留。`);
        }
      } finally {
        sendingLock.current = false;
        if (!signal?.aborted) setSending(false);
      }
      return;
    }
    if (!retryPayload && !effectiveOnly && busy && !activeMessage?.companionId) {
      reportError("AI 主持人正在运行。请稍后发送，或切换到「聊天」模式。输入已保留。");
      return;
    }
    sendingLock.current = true;
    setSending(true);
    reportError("");
    const signal = actions.requestSignal();
    let payload: SendInput | undefined;
    try {
      if (!retryPayload && !effectiveOnly && submissionMode === "auto") {
        const modelReady = await isHostModelReady(roomId, signal);
        if (signal?.aborted) return;
        if (!modelReady) {
          onOpenRoomSettings();
          return;
        }
      }
      payload = retryPayload ?? {
        roomId,
        text,
        chatOnly: only,
        clientMessageId: crypto.randomUUID(),
      };
      if (submittedDraft !== undefined)
        setDraft((current) => (current === submittedDraft ? [] : current));
      const sent = await client.chat.send(payload, { signal });
      if (signal?.aborted) return;
      actions.acceptMessage(sent);
      const sentId = payload.clientMessageId;
      setFailedSends((current) => current.filter((item) => item.clientMessageId !== sentId));
      scrollToBottom();
    } catch (reason) {
      if (signal?.aborted) return;
      if (payload) {
        if (submittedDraft !== undefined)
          setDraft((current) => (current.length ? current : submittedDraft));
        const failed = payload;
        setFailedSends((current) =>
          current.some((item) => item.clientMessageId === failed.clientMessageId)
            ? current
            : [...current, failed],
        );
      }
      reportError(`${errorMessage(reason)} 输入已保留。`);
    } finally {
      sendingLock.current = false;
      if (!signal?.aborted) setSending(false);
    }
  }

  async function changeSubmissionMode(mode: SubmissionMode) {
    if (!isHost || modeChanging || mode === submissionMode) return;
    setModeChanging(true);
    reportError("");
    const signal = actions.requestSignal();
    try {
      const confirmed = await client.chat.setSubmissionMode({ roomId, mode }, { signal });
      if (signal?.aborted) return;
      actions.confirmSubmissionMode(confirmed);
    } catch (reason) {
      if (signal?.aborted) return;
      reportError(`切换提交方式失败：${errorMessage(reason)}`);
    } finally {
      if (!signal?.aborted) setModeChanging(false);
    }
  }

  async function continueTurn() {
    if (
      !isHost ||
      !ready ||
      continueLock.current ||
      sending ||
      modeChanging ||
      !pendingIds.size ||
      !player ||
      busy ||
      !hostReady
    )
      return;
    continueLock.current = true;
    setContinuing(true);
    reportError("");
    const signal = actions.requestSignal();
    const request = (continueRequest.current ??= {
      id: crypto.randomUUID(),
      pendingIds: new Set(pendingIds),
    });
    try {
      const host = await client.chat.continue({ roomId, clientRequestId: request.id }, { signal });
      if (signal?.aborted) return;
      continueRequest.current = null;
      actions.acceptMessage(host);
      scrollToBottom();
    } catch (reason) {
      if (signal?.aborted) return;
      reportError(`继续失败：${errorMessage(reason)}`);
    } finally {
      continueLock.current = false;
      if (!signal?.aborted) setContinuing(false);
    }
  }

  async function resolveInput(action: "retry" | "abandon") {
    if (!isHost || !pendingInput || continueLock.current || busy) return;
    continueLock.current = true;
    setContinuing(true);
    reportError("");
    const signal = actions.requestSignal();
    try {
      const message = await client.chat.resolveInput(
        { roomId, ...pendingInput, action },
        { signal },
      );
      if (!signal?.aborted) actions.acceptMessage(message);
    } catch (reason) {
      if (!signal?.aborted) reportError(`处理未送达行动失败：${errorMessage(reason)}`);
    } finally {
      continueLock.current = false;
      if (!signal?.aborted) setContinuing(false);
    }
  }

  async function convertToChat(messageId: string) {
    if (!player || convertLock.current || continueLock.current) return;
    convertLock.current = true;
    setConvertingMessageId(messageId);
    reportError("");
    const signal = actions.requestSignal();
    try {
      const message = await client.chat.convertToChat({ roomId, messageId }, { signal });
      if (!signal?.aborted) actions.acceptMessage(message);
    } catch (reason) {
      if (!signal?.aborted) reportError(`改为聊天失败：${errorMessage(reason)}`);
    } finally {
      convertLock.current = false;
      if (!signal?.aborted) setConvertingMessageId(null);
    }
  }

  const actOnRun = useCallback(
    async (messageId: string) => {
      if (!isHost || runLock.current) return;
      runLock.current = true;
      setPendingRun(messageId);
      reportError("");
      const signal = actions.requestSignal();
      try {
        await client.agent.cancel({ roomId, messageId }, { signal });
      } catch (reason) {
        if (signal?.aborted) return;
        reportError(`停止失败：${errorMessage(reason)}`);
      } finally {
        runLock.current = false;
        if (!signal?.aborted) setPendingRun(null);
      }
    },
    [actions, client, roomId, isHost],
  );

  async function removeSteering(entryId: string) {
    if (steeringLock.current) return;
    steeringLock.current = true;
    setSteeringWorking(true);
    reportError("");
    const signal = actions.requestSignal();
    try {
      actions.acceptSteering(await client.steering.remove({ roomId, entryId }, { signal }));
    } catch (reason) {
      if (!signal?.aborted) {
        reportError(errorMessage(reason));
        try {
          actions.acceptSteering((await client.steering.get({ roomId }, { signal })).snapshot);
        } catch {
          /* 订阅重连恢复。 */
        }
      }
    } finally {
      steeringLock.current = false;
      if (!signal?.aborted) setSteeringWorking(false);
    }
  }
  async function submitSteering(interrupt: boolean) {
    if (!isHost || steeringLock.current) return;
    steeringLock.current = true;
    setSteeringWorking(true);
    reportError("");
    const signal = actions.requestSignal();
    const id = (steeringSubmitRequest.current ??= crypto.randomUUID());
    try {
      actions.acceptSteering(
        await client.steering.submit({ roomId, clientRequestId: id, interrupt }, { signal }),
      );
      steeringSubmitRequest.current = null;
      scrollToBottom();
    } catch (reason) {
      if (!signal?.aborted) reportError(errorMessage(reason));
    } finally {
      steeringLock.current = false;
      if (!signal?.aborted) setSteeringWorking(false);
    }
  }
  const toggleChatOnly = useCallback(() => {
    const value = !chatOnly;
    setChatOnly(value);
    if (playerId) {
      try {
        localStorage.setItem(`tarp:chat-only:experimental:${playerId}:${roomId}`, String(value));
      } catch {
        /* 无法持久化时仍可使用开关。 */
      }
    }
  }, [chatOnly, playerId, roomId]);

  return {
    steering,
    isHost,
    steeringMode,
    retryingDraft,
    steeringWorking,
    removeSteering,
    submitSteering,
    draft,
    draftText: visibleDraft,
    setDraft,
    mentionField,
    quickMention,
    chatOnly,
    effectiveChatOnly,
    automaticChat,
    queuedMessage,
    toggleChatOnly,
    sending,
    continuing,
    modeChanging,
    failedSends,
    pendingRun,
    openingPending,
    activeMessage,
    busy,
    chatStatus,
    canContinueOpening,
    continueOpening,
    send,
    changeSubmissionMode,
    continueTurn,
    pendingInput,
    canResolveInput: isHost,
    resolveInput,
    convertToChat,
    convertingMessageId,
    actOnRun,
    submissionMode,
    pendingIds,
    continueDisabled:
      !isHost ||
      !ready ||
      continuing ||
      Boolean(convertingMessageId) ||
      sending ||
      modeChanging ||
      busy ||
      !player ||
      !hostReady ||
      Boolean(pendingInput),
    submissionDisabled: !isHost || modeChanging || sending || continuing || !ready,
    sendDisabled:
      relayActive ||
      sending ||
      continuing ||
      modeChanging ||
      !player ||
      !ready ||
      !visibleDraft.trim() ||
      (!effectiveChatOnly && Boolean(pendingInput)) ||
      (!retryingDraft && !effectiveChatOnly && busy && !activeMessage?.companionId && !canSteer),
  };
}
export type ChatComposerController = ReturnType<typeof useChatComposer>;
