import { ArrowLeftRight, ArrowUp, CornerUpLeft, Play, Square, X } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "../../components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "../../components/ui/select";
import { SpeechControls } from "../tts/SpeechControls";
import type { useSpeech } from "../tts/use-speech";
import type { MentionCandidate } from "./mention";
import { MentionField } from "./MentionField";
import type { ChatComposerController } from "./use-chat-composer";
import type { PlayerProfile } from "./use-player-profile";

import styles from "./ChatPanel.module.css";
const submissionModeOptions = [
  { value: "auto", label: "自动提交" },
  { value: "manual", label: "手动提交" },
] as const;
function CompanionActivity({ name }: { name: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="text-muted-foreground mb-2 flex min-h-6 items-center gap-2 px-1 text-xs"
    >
      <span
        aria-hidden="true"
        className={`${styles.thinkingDot} size-1.5 shrink-0 rounded-full bg-current`}
      />
      <span>{name}正在考虑是否回应…</span>
    </div>
  );
}

/** 聊天输入区域，包括发送反馈、提交控制与语音开关。 */
export function ChatComposer({
  roomId,
  composer,
  error,
  profile,
  speech,
  mentions,
  dockRef,
  showReasoning,
  relay,
}: {
  roomId: string;
  composer: ChatComposerController;
  error: string;
  profile: PlayerProfile;
  speech: ReturnType<typeof useSpeech>;
  mentions: readonly MentionCandidate[];
  dockRef(node: HTMLDivElement | null): (() => void) | undefined;
  showReasoning: boolean;
  relay?: { pending: boolean; error?: string; reclaim(): void };
}) {
  const { player } = profile;
  const {
    draft,
    draftText,
    setDraft,
    mentionField,
    chatOnly,
    toggleChatOnly,
    sending,
    continuing,
    failedSends,
    pendingRun,
    openingPending,
    activeMessage,
    busy,
    canContinueOpening,
    continueOpening,
    send,
    changeSubmissionMode,
    continueTurn,
    actOnRun,
    submissionMode,
    pendingIds,
    continueDisabled,
    submissionDisabled,
    sendDisabled,
  } = composer;
  function focusComposer() {
    mentionField.current?.focus();
  }
  function keepComposerFocus(event: MouseEvent) {
    if (event.button !== 0 || !mentionField.current?.isFocused()) return;
    event.preventDefault();
  }
  function submit() {
    focusComposer();
    void send();
  }
  const backgroundCompanion =
    activeMessage?.companionId && activeMessage.internal && !showReasoning
      ? activeMessage
      : undefined;
  const canStop = (busy || Boolean(composer.queuedMessage)) && composer.isHost;
  const stopping = pendingRun !== null;
  const canSendWhileRunning =
    composer.retryingDraft ||
    composer.effectiveChatOnly ||
    Boolean(activeMessage?.companionId) ||
    composer.steeringMode;
  const sendLabel = sending
    ? "发送中"
    : composer.retryingDraft
      ? "重试发送"
      : composer.steeringMode
        ? "插话"
        : "发送消息";
  const stopLabel = stopping ? "正在停止生成" : "停止生成";
  function stop() {
    const messageId = activeMessage?.runId ?? composer.queuedMessage?.messageId;
    if (messageId) void actOnRun(messageId);
  }
  if (relay)
    return (
      <div ref={dockRef} className={styles.composerDock}>
        <div aria-hidden="true" className={styles.composerVeil} />
        <div className="relative mx-auto w-full max-w-5xl px-4 pb-4 sm:px-6">
          <div className={`${styles.composerSurface} space-y-2 rounded-2xl p-4`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p role="status" className="text-muted-foreground text-sm">
                {relay.pending
                  ? "等待当前 AI 行动结束后交还控制权…"
                  : "AI 正在接力操控你的角色，接回后即可发言。"}
              </p>
              <Button type="button" size="sm" disabled={relay.pending} onClick={relay.reclaim}>
                {relay.pending ? "正在接回…" : "接回角色"}
              </Button>
            </div>
            {relay.error ? (
              <p role="alert" className="text-destructive text-sm">
                {relay.error}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  return (
    <div ref={dockRef} className={styles.composerDock}>
      <div aria-hidden="true" className={styles.composerVeil} />
      <div className="relative mx-auto w-full max-w-5xl px-4 pb-4 sm:px-6">
        {backgroundCompanion ? <CompanionActivity name={backgroundCompanion.nickname} /> : null}
        {composer.steering.entries.length ? (
          <section
            aria-label="插话队列"
            className={`${styles.composerSurface} mb-2 overflow-hidden rounded-xl`}
          >
            <div className="border-border flex items-center justify-between gap-3 border-b px-3.5 py-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-xs font-medium">
                  <CornerUpLeft className="size-3.5" />
                  插话队列{" "}
                  <span className="text-muted-foreground font-normal">
                    {composer.steering.entries.length} / 5
                  </span>
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {composer.steering.entries.some((e) => e.state === "pending")
                    ? "当前回应与工具结束后接收"
                    : "等待房主提交"}
                </p>
              </div>
              {composer.isHost ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    composer.steeringWorking ||
                    composer.steering.entries.some((e) => e.state === "claimed") ||
                    Boolean(activeMessage?.companionId)
                  }
                  onClick={() => void composer.submitSteering(busy)}
                >
                  {composer.steeringWorking ? "正在处理…" : busy ? "直接打断并提交" : "提交给主持"}
                </Button>
              ) : null}
            </div>
            <ol className="max-h-48 divide-y divide-(--border) overflow-y-auto">
              {composer.steering.entries.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground mb-1 text-xs">
                      {entry.nickname}
                      <span className="ml-2">
                        {entry.state === "claimed"
                          ? "接收中"
                          : entry.state === "manual"
                            ? "待提交"
                            : "待接收"}
                      </span>
                    </p>
                    <p className="text-sm leading-5 break-words whitespace-pre-wrap">
                      {entry.text}
                    </p>
                  </div>
                  {composer.isHost || entry.playerId === player?.id ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground size-7 shrink-0"
                      aria-label={`删除 ${entry.nickname} 的插话`}
                      disabled={composer.steeringWorking || entry.state === "claimed"}
                      onClick={() => void composer.removeSteering(entry.id)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          </section>
        ) : null}
        {composer.pendingInput ? (
          <div
            role="status"
            className={`${styles.composerSurface} mb-2 flex flex-wrap items-center gap-2 rounded-xl p-3`}
          >
            <p className="text-muted-foreground flex-1 text-xs">
              上次行动尚未送达主持。请房主先重试或放弃，期间可以仅聊天。
            </p>
            {composer.canResolveInput ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || continuing || sending}
                  onClick={() => void composer.resolveInput("retry")}
                >
                  重试提交
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || continuing || sending}
                  onClick={() => void composer.resolveInput("abandon")}
                >
                  放弃该批次
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {pendingIds.size && !composer.pendingInput ? (
          <div
            className={`${styles.composerSurface} mb-2 flex items-center justify-between gap-3 rounded-xl py-1.5 pr-1.5 pl-3.5`}
          >
            <p role="status" className="text-muted-foreground text-xs">
              已标记 {pendingIds.size} 条消息，等待交给主持人
            </p>
            <Button
              type="button"
              size="sm"
              className="rounded-full"
              disabled={continueDisabled}
              onMouseDown={keepComposerFocus}
              onClick={() => {
                focusComposer();
                void continueTurn();
              }}
            >
              <Play className="size-3.5 fill-current" />
              {continuing ? "正在提交…" : "继续"}
            </Button>
          </div>
        ) : null}
        <div className={`${styles.composerSurface} ${styles.composer} rounded-2xl p-2.5`}>
          {error ? (
            <div role="alert" className="text-destructive mb-3 text-sm leading-6">
              {error}
              {!player ? (
                <Button variant="ghost" size="sm" onClick={profile.reload}>
                  重新加载玩家
                </Button>
              ) : null}
            </div>
          ) : null}
          {canContinueOpening ? (
            <div className="mb-3 flex items-center justify-between gap-3 text-sm">
              <span>开场尚未完成。将从当前游戏状态继续。</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={openingPending}
                onMouseDown={keepComposerFocus}
                onClick={() => {
                  focusComposer();
                  void continueOpening();
                }}
              >
                {openingPending ? "正在开始…" : "继续开场"}
              </Button>
            </div>
          ) : null}
          {failedSends.map((failedSend) => (
            <div
              key={failedSend.clientMessageId}
              className="border-border mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <p className="text-muted-foreground min-w-0 truncate text-xs">
                发送未确认：{failedSend.text}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={sending}
                onMouseDown={keepComposerFocus}
                onClick={() => {
                  focusComposer();
                  void send(failedSend);
                }}
              >
                重试发送
              </Button>
            </div>
          ))}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <MentionField
              ref={mentionField}
              value={draft}
              mentions={mentions}
              placeholder={
                composer.effectiveChatOnly
                  ? "和同伴聊几句，或 @主持人 询问规则…"
                  : composer.steeringMode
                    ? "补充行动或问题，下一次回应时接收…"
                    : "你想说什么，或做些什么？"
              }
              onChange={setDraft}
              onSubmit={submit}
              onToggleMode={toggleChatOnly}
            />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-1">
              <div className="flex items-center gap-1.5">
                {speech.available ? (
                  <div onMouseDownCapture={keepComposerFocus}>
                    <SpeechControls
                      owner={roomId}
                      enabled={Boolean(speech.settings.data?.automatic)}
                      pending={speech.automatic.isPending}
                      onToggle={() =>
                        speech.automatic.mutate({
                          roomId,
                          enabled: !speech.settings.data?.automatic,
                        })
                      }
                      error={speech.settings.error ?? speech.room.error ?? speech.automatic.error}
                    />
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground h-8 min-w-18 gap-1.5 rounded-md px-2 text-xs"
                  aria-pressed={chatOnly}
                  tooltip={`${chatOnly ? "聊天不提交行动，AI 队友后续可见；@主持人 可询问规则或澄清描述。切换为行动" : "向主持声明动作、台词或问题，等待回应与裁定。切换为聊天"}（Shift+Tab）；合法 @ 自动归为聊天`}
                  aria-label={`输入模式：${chatOnly ? "聊天" : "行动"}`}
                  aria-keyshortcuts="Shift+Tab"
                  onMouseDown={keepComposerFocus}
                  onClick={toggleChatOnly}
                >
                  <span>{chatOnly ? "聊天" : "行动"}</span>
                  <ArrowLeftRight aria-hidden="true" className="size-3 opacity-60" />
                </Button>
                {composer.automaticChat ? (
                  <span role="status" className="text-muted-foreground text-[11px]">
                    由 @ 自动转为聊天
                  </span>
                ) : null}
              </div>
              <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
                <Select
                  value={submissionMode}
                  items={submissionModeOptions}
                  disabled={submissionDisabled}
                  onValueChange={(value) => {
                    if (value === "auto" || value === "manual") void changeSubmissionMode(value);
                  }}
                >
                  <SelectTrigger
                    type="button"
                    aria-label={`提交方式：${submissionMode === "auto" ? "自动提交" : "手动提交"}`}
                    className="text-muted-foreground h-8 px-2.5 text-xs"
                  >
                    {submissionMode === "auto" ? "自动提交" : "手动提交"}
                  </SelectTrigger>
                  <SelectContent
                    side="top"
                    align="end"
                    alignItemWithTrigger={false}
                    sideOffset={8}
                    className="w-72 max-w-[calc(100vw-2rem)] min-w-0 p-1"
                  >
                    <SelectGroup>
                      <SelectLabel>提交方式</SelectLabel>
                      <SelectItem value="auto" className="items-start px-2.5 py-2.5 pr-8">
                        <span className="flex min-w-0 flex-col whitespace-normal">
                          <span className="font-medium">自动提交</span>
                          <span className="text-muted-foreground mt-0.5 text-xs leading-5">
                            普通发言发送后立即交给主持；AI 队友的待裁定行动也会自动提交。
                          </span>
                        </span>
                      </SelectItem>
                      <SelectItem value="manual" className="items-start px-2.5 py-2.5 pr-8">
                        <span className="flex min-w-0 flex-col whitespace-normal">
                          <span className="font-medium">手动提交</span>
                          <span className="text-muted-foreground mt-0.5 text-xs leading-5">
                            发言先留在聊天中；点击「继续」后，待提交消息和队友最后一条行动一起交给主持。
                          </span>
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {canStop && canSendWhileRunning && draftText.trim() ? (
                  <Button
                    type="submit"
                    variant="outline"
                    size="icon"
                    className="border-border/70 text-muted-foreground hover:text-foreground size-8 rounded-full"
                    aria-label={sendLabel}
                    tooltip={sendLabel}
                    aria-busy={sending}
                    disabled={sendDisabled || stopping}
                    onMouseDown={keepComposerFocus}
                  >
                    <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.25} />
                  </Button>
                ) : null}
                <Button
                  type={canStop ? "button" : "submit"}
                  size="icon"
                  className="size-8 rounded-full transition-[background-color,transform] active:scale-95 motion-reduce:transform-none"
                  aria-label={canStop ? stopLabel : sendLabel}
                  tooltip={canStop ? stopLabel : sendLabel}
                  aria-busy={canStop ? stopping : sending}
                  disabled={canStop ? stopping : sendDisabled}
                  onMouseDown={keepComposerFocus}
                  onClick={canStop ? stop : undefined}
                >
                  {canStop ? (
                    <Square aria-hidden="true" className="size-3 fill-current stroke-0" />
                  ) : (
                    <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.25} />
                  )}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
