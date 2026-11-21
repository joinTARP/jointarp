import { createHash, randomUUID } from "node:crypto";

import { ORPCError } from "@orpc/server";

import type { ChatMessage, Player, SendInput } from "../../../shared/game";
import type { MovementIntent } from "../../../shared/map";
import { parseMentionRefs, resolveMentionRefs } from "../../../shared/mentions";
import { assertPlayerReady, readCharacters } from "../../sessions/character-db";
import { movementPrompt } from "../../sessions/map-description";
import { prepareMovement } from "../../sessions/map-intent";
import { assertSessionActive } from "../../sessions/session-store";
import type { ChatInputBatches } from "./input-batches";
import type { ChatMentionQueue } from "./mention-queue";
import type { ChatRuns } from "./runs";
import type { SubmissionRequest } from "./store";
import type { ChatTurnQueue } from "./turn-queue";
import type { ChatAuth, ChatContext, RoomState, RunOptions } from "./types";

type SubmissionContext = Pick<
  ChatContext,
  "state" | "store" | "activity" | "credentials" | "isClosing"
> & {
  runs: Pick<
    ChatRuns,
    "start" | "followup" | "actionCompanions" | "reactToAction" | "afterActionChain"
  >;
  queue: ChatTurnQueue;
  mentions: ChatMentionQueue;
  inputs: ChatInputBatches;
};

interface Request {
  fingerprint: string;
  pending: Promise<ChatMessage>;
}

/** 玩家提交、幂等请求与待处理行动。 */
export class ChatSubmissions {
  private requests = new WeakMap<RoomState, Map<string, Request>>();
  constructor(private readonly context: SubmissionContext) {}

  private request(
    state: RoomState,
    request: SubmissionRequest,
    execute: () => Promise<ChatMessage>,
  ): Promise<ChatMessage> {
    let requests = this.requests.get(state);
    if (!requests) this.requests.set(state, (requests = new Map()));
    const key = JSON.stringify([request.operation, request.playerId, request.requestId]);
    const existing = requests.get(key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint)
        throw new ORPCError("CONFLICT", { message: "重复请求的内容不同" });
      return existing.pending;
    }
    const saved = this.context.store.submissionResult(state, request);
    if (saved) return Promise.resolve(saved);
    const cache = requests;
    const pending = Promise.resolve()
      .then(execute)
      .finally(() => cache.delete(key));
    cache.set(key, { fingerprint: request.fingerprint, pending });
    return pending;
  }

  async continue(input: { roomId: string; clientRequestId: string }, player: Player) {
    const state = await this.context.state(input.roomId, true);
    const request: SubmissionRequest = {
      operation: "continue",
      playerId: player.id,
      requestId: input.clientRequestId,
      fingerprint: "",
    };
    return this.request(state, request, () => this.continueOnce(state, input, player, request));
  }

  private async continueOnce(
    state: RoomState,
    input: { roomId: string; clientRequestId: string },
    player: Player,
    request: SubmissionRequest,
  ) {
    assertSessionActive(state.db);
    if (this.context.activity.running(state) || this.context.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "请等待当前生成结束后继续。" });
    this.context.inputs.assertResolved(state);
    const pending = this.context.queue.pendingMessages(state);
    if (!pending.length)
      throw new ORPCError("PRECONDITION_FAILED", { message: "没有待提交的消息。" });
    try {
      assertPlayerReady(state.db, player.id);
    } catch (error) {
      throw new ORPCError("PRECONDITION_FAILED", {
        message: error instanceof Error ? error.message : "请先确认角色并完成开场",
      });
    }
    const auth = await this.context.credentials(input.roomId);
    const repeated = this.context.store.submissionResult(state, request);
    if (repeated) return repeated;
    assertSessionActive(state.db);
    if (
      this.context.activity.running(state) ||
      this.context.activity.isConfiguring(state) ||
      state.closed ||
      this.context.isClosing()
    )
      throw new ORPCError("CONFLICT", { message: "房间状态已变化，请稍后重试。" });
    const current = this.context.queue.pendingMessages(state);
    if (!current.length)
      throw new ORPCError("PRECONDITION_FAILED", { message: "没有待提交的消息。" });
    const source = current.at(-1)!;
    const prompt = this.context.queue.hostPrompt(
      state,
      this.context.queue.pendingTurns(state, current),
      current,
    );
    const next = this.context.runs.followup(state, source, prompt, auth, {
      requestId: input.clientRequestId,
      companionChain: this.context.runs.afterActionChain(state),
      consumePending: current,
      submission: request,
    });
    return next;
  }

  async resolveInput(
    input: { roomId: string; messageId: string; batchId: string; action: "retry" | "abandon" },
    player: Player,
  ) {
    const state = await this.context.state(input.roomId);
    const running = this.context.activity.running(state);
    if (running?.messageId === input.messageId && input.action === "retry")
      return this.context.store.message(state, input.messageId);
    if (running || this.context.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "请等待当前生成结束后处理未送达行动" });
    await this.context.inputs.recover(state);
    let message = this.context.store.message(state, input.messageId);
    if (message.kind !== "assistant" || message.inputBatch?.id !== input.batchId)
      throw new ORPCError("NOT_FOUND", { message: "提交批次不存在" });
    if (input.action === "abandon") return this.context.inputs.abandon(state, message);
    if (message.inputBatch.state !== "prepared") return message;
    assertSessionActive(state.db);
    assertPlayerReady(state.db, player.id);
    const auth = await this.context.credentials(input.roomId);
    this.assertAvailable(state);
    const active = this.context.activity.running(state);
    if (active?.messageId === input.messageId)
      return this.context.store.message(state, input.messageId);
    if (active || this.context.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "请等待当前生成结束" });
    message = this.context.store.message(state, input.messageId);
    if (message.kind !== "assistant" || message.inputBatch?.state !== "prepared") return message;
    const batch = this.context.inputs.get(state, message.inputBatch.id);
    const next = this.context.store.transaction(state, () =>
      this.context.store.save(state, {
        ...message,
        status: "running",
        error: undefined,
        agentMessages: [],
        attemptId: randomUUID(),
      }),
    );
    this.context.runs.start(state, next, this.context.inputs.prompt(batch), auth, {
      inputBatch: batch,
      requestId: batch.id,
    });
    return next;
  }

  async send(input: SendInput, player: Player): Promise<ChatMessage> {
    const state = await this.context.state(input.roomId, true);
    const request: SubmissionRequest = {
      operation: "send",
      playerId: player.id,
      requestId: input.clientMessageId,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([input.text, input.chatOnly, input.movement ?? null]))
        .digest("hex"),
    };
    return this.request(state, request, () => this.sendOnce(state, input, player, request));
  }

  async convertToChat(input: { roomId: string; messageId: string }, player: Player) {
    const state = await this.context.state(input.roomId);
    this.assertAvailable(state);
    return this.context.store.transaction(state, () =>
      this.context.queue.convertToChat(state, input.messageId, player.id),
    );
  }

  private assertAvailable(state: RoomState) {
    if (this.context.isClosing()) throw new ORPCError("UNAVAILABLE", { message: "应用正在退出" });
    if (state.closed) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭" });
    assertSessionActive(state.db);
  }

  private async sendOnce(
    state: RoomState,
    input: SendInput,
    player: Player,
    request: SubmissionRequest,
  ): Promise<ChatMessage> {
    this.assertAvailable(state);
    const targets = await this.context.mentions.targets(state, player);
    this.assertAvailable(state);
    const text = input.text.trim();
    if ((!text && !input.movement) || text.length > 4000)
      throw new ORPCError("BAD_REQUEST", { message: "消息应为 1 至 4000 个字符" });
    const mentioned = resolveMentionRefs(parseMentionRefs(text), targets);
    const only = input.chatOnly || mentioned.length > 0;
    if (input.movement && only)
      throw new ORPCError("BAD_REQUEST", {
        message: "移动意图只能随行动消息提交，不能用于聊天或点名",
      });
    // 接收时由稳定身份计算用途；失效引用仍按原手动模式处理。
    if (!only) {
      if (!this.context.activity.running(state)) this.context.inputs.assertResolved(state);
      try {
        assertPlayerReady(state.db, player.id);
      } catch (error) {
        throw new ORPCError("PRECONDITION_FAILED", {
          message: error instanceof Error ? error.message : "请先确认角色并完成开场",
        });
      }
    }
    this.assertAvailable(state);
    const currentRun = this.context.activity.running(state);
    if (!only && currentRun) {
      const current = this.context.store.message(state, currentRun.messageId);
      if (current.kind === "assistant" && !current.companionId)
        throw new ORPCError("CONFLICT", {
          message: "主持人正在回复，请使用插话队列或聊天模式，输入已保留",
        });
    }
    const options: RunOptions = { react: true };
    let credentialsResult: { auth: ChatAuth } | { error: unknown } | undefined;
    const prepareCredentials = async () => {
      try {
        credentialsResult = { auth: await this.context.credentials(input.roomId) };
      } catch (error) {
        credentialsResult = { error };
      }
    };
    this.assertAvailable(state);
    if (!only && this.context.queue.mode(state) === "auto") await prepareCredentials();
    this.assertAvailable(state);
    const repeated = this.context.store.submissionResult(state, request);
    if (repeated) return repeated;
    // 同一请求共用执行结果；凭据与队友资料读取后仍需重新检查房间状态。
    if (!only && this.context.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "正在保存队友配置，请稍后再试。" });
    if (
      credentialsResult &&
      "error" in credentialsResult &&
      this.context.queue.mode(state) === "auto"
    )
      throw credentialsResult.error;
    let release: (() => void) | undefined;
    try {
      const running = this.context.activity.running(state);
      if (!only && running) {
        const active = this.context.store.message(state, running.messageId);
        if (active.kind === "assistant" && active.companionId) {
          // 交接期间保留玩家优先权，队友结束后的 kick 需等待本次提交完成。
          release = this.context.activity.beginHandoff(state);
          running.abort.abort();
          await running.done;
        }
      }
      this.assertAvailable(state);
      // 手动提交也可能在等待队友停止时切回自动；凭据读取后仍以落盘前模式为准。
      if (!only && this.context.queue.mode(state) === "auto" && !credentialsResult) {
        await prepareCredentials();
        this.assertAvailable(state);
      }
      const saved = this.context.store.submissionResult(state, request);
      if (saved) return saved;
      let movement: MovementIntent | undefined;
      if (input.movement)
        try {
          movement = prepareMovement(state.db, player.id, input.movement);
        } catch (error) {
          throw new ORPCError("BAD_REQUEST", {
            message: error instanceof Error ? error.message : "移动意图无效",
          });
        }
      const messageId = randomUUID();
      const manual = this.context.queue.mode(state) === "manual";
      const willRun = !only && !manual;
      if (!only && this.context.activity.running(state))
        throw new ORPCError("CONFLICT", {
          message: "主持人正在回复，可先开启“仅聊天”或停止生成。",
        });
      if (!only && this.context.activity.isConfiguring(state) && !release)
        throw new ORPCError("CONFLICT", { message: "房间状态已变化，请稍后重试。" });
      if (willRun && credentialsResult && "error" in credentialsResult)
        throw credentialsResult.error;
      const auth =
        willRun && credentialsResult && "auth" in credentialsResult
          ? credentialsResult.auth
          : undefined;
      const pending = this.context.queue
        .pendingMessages(state)
        .filter((message) => only || message.senderId !== player.id);
      const companions = only ? [] : this.context.runs.actionCompanions(state);
      const hostRun = Boolean(auth) && !companions.length;
      const character = readCharacters(state.db).find((item) => item.playerId === player.id);
      const turns = hostRun
        ? [
            ...this.context.queue.pendingTurns(state, pending),
            {
              text,
              playerId: player.id,
              characterName: character?.name,
              ...(movement ? { movement: movementPrompt(state.db, messageId, movement) } : {}),
            },
          ]
        : [];
      const prompt = hostRun ? this.context.queue.hostPrompt(state, turns, pending) : "";
      let assistant: ChatMessage | undefined;
      let jobs: ReturnType<ChatMentionQueue["prepare"]> = [];
      const message = this.context.store.transaction(
        state,
        () => {
          const existing = this.context.store.submissionResult(state, request);
          if (existing) return existing;
          if (!only) this.context.inputs.assertResolved(state);
          if (!only) this.context.queue.replacePending(state, player.id);
          if (hostRun) this.context.queue.consumePending(state, pending);
          const message = this.context.store.save(state, {
            id: messageId,
            sequence: 0,
            revision: 0,
            roomId: input.roomId,
            senderId: player.id,
            nickname: player.nickname,
            createdAt: new Date().toISOString(),
            kind: "player",
            text,
            ...(mentioned.length ? { mentions: mentioned } : {}),
            chatOnly: only,
            ...(movement ? { movement } : {}),
            ...(!only && (manual || companions.length) ? { pendingAgent: true } : {}),
            status: "complete",
          });
          if (auth && hostRun) {
            options.inputBatch = this.context.inputs.create(
              [...pending.map((item) => item.id), message.id],
              turns,
            );
            assistant = this.context.store.save(state, {
              id: randomUUID(),
              sequence: 0,
              revision: 0,
              roomId: input.roomId,
              senderId: options.companion?.id ?? "agent",
              nickname: "主持人",
              createdAt: new Date().toISOString(),
              kind: "assistant",
              agentMessages: [],
              inputBatch: options.inputBatch,
              attemptId: randomUUID(),
              status: "running",
            });
            this.context.inputs.save(state, assistant.id, options.inputBatch!);
            options.requestId = message.id;
          }
          if (mentioned.length) jobs = this.context.mentions.prepare(state, message, targets);
          this.context.store.saveSubmission(state, request, message.id);
          return message;
        },
        () => this.context.mentions.register(state, jobs),
      );
      if (assistant && auth) this.context.runs.start(state, assistant, prompt, auth, options);
      if (companions.length) this.context.runs.reactToAction(state, message, companions);
      this.context.mentions.kick(state);
      return message;
    } finally {
      if (release) {
        release();
        this.context.mentions.kick(state);
      }
    }
  }
}
