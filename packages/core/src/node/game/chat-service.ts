import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { ORPCError } from "@orpc/server";

import type { AgentDetail } from "../../shared/agent-details";
import type { CompanionInput, CompanionModel } from "../../shared/companion";
import type { CompanionInitiative } from "../../shared/companion-initiative";
import type { DiceOptions } from "../../shared/dice";
import type { ChatMessage, Player, SendInput, SubmissionMode } from "../../shared/game";
import type { LaunchAction } from "../../shared/launch";
import type { RoomProjection } from "../../shared/room-state";
import type { SessionMetrics } from "../../shared/session-metrics";
import type { TtsVoiceOverride } from "../../shared/voice";
import { readAdventureState, updateAdventureState } from "../sessions/adventure-state";
import { readCharacters } from "../sessions/character-db";
import { syncModule } from "../sessions/module-sync";
import { notifyRoomChanged } from "../sessions/room-changes";
import { forgetRoomResources } from "../sessions/room-resources";
import { readAdventure } from "../sessions/room-storage";
import { gameDirectoryForDatabase, roomDirectoryForDatabase } from "../sessions/session-paths";
import {
  assertSessionActive,
  isSessionActive,
  openSessionDatabase,
} from "../sessions/session-store";
import { withStateLock } from "../sessions/state-lock";
import { ChatActivity } from "./chat/activity";
import { ChatCompanions } from "./chat/companions";
import { ChatDice } from "./chat/dice";
import { ChatInputBatches } from "./chat/input-batches";
import { ChatLaunch } from "./chat/launch";
import { ChatLaunchCards } from "./chat/launch-cards";
import { ChatMentionQueue } from "./chat/mention-queue";
import { ChatNarration } from "./chat/narration";
import { ChatRunDiagnostics } from "./chat/run-diagnostics";
import { ChatRuns } from "./chat/runs";
import { ChatSteering } from "./chat/steering";
import { ChatStore } from "./chat/store";
import { ChatSubmissions } from "./chat/submissions";
import { ChatSync } from "./chat/sync";
import { ChatTurnQueue } from "./chat/turn-queue";
import type { ChatContext, ChatCredentials, Runtime, RoomState } from "./chat/types";
import { readCompactionSettings } from "./compaction-settings";
import { readCompanions } from "./companion";
export type { Runtime } from "./chat/types";
/** 房主权威入口：组合业务服务并管理房间连接、恢复与关闭。 */
export class ChatService {
  private rooms = new Map<string, Promise<RoomState>>();
  private closing = false;
  private readonly closingRooms = new Map<string, Promise<void>>();
  private readonly maintainingRooms = new Set<string>();
  private closeTask?: Promise<void>;
  private readonly store = new ChatStore();
  private readonly activity = new ChatActivity();
  private readonly compactions = new WeakMap<RoomState, AbortController>();
  private readonly diagnostics: ChatRunDiagnostics;
  private readonly recovering = new WeakMap<RoomState, Promise<void>>();
  private readonly queue: ChatTurnQueue;
  private readonly inputs: ChatInputBatches;
  readonly steering: ChatSteering;
  private readonly launch: ChatLaunch;
  private readonly narration: ChatNarration;
  private readonly submissions: ChatSubmissions;
  private readonly mentions: ChatMentionQueue;
  private readonly companions: ChatCompanions;
  private readonly dice: ChatDice;
  private readonly sync: ChatSync;
  private readonly runs: ChatRuns;

  constructor(
    private readonly root: string,
    private readonly runtime: Runtime,
    private readonly credentials: ChatCredentials,
    options?: { narrationGap?: (text: string) => number },
  ) {
    this.diagnostics = new ChatRunDiagnostics(runtime.history);
    const context: ChatContext = {
      root,
      state: (id, readOnly) => this.state(id, readOnly),
      store: this.store,
      activity: this.activity,
      credentials,
      isClosing: () => this.closing,
    };
    this.inputs = new ChatInputBatches(this.store, runtime.history);
    this.queue = new ChatTurnQueue({ ...context, inputs: this.inputs });
    this.mentions = new ChatMentionQueue(context);
    this.steering = new ChatSteering({ ...context, runtime });
    const cards = new ChatLaunchCards(context);
    this.dice = new ChatDice(context);
    this.companions = new ChatCompanions(context);
    this.narration = new ChatNarration({
      ...context,
      cards,
      liveNarration: Boolean(options?.narrationGap),
      narrationGap: options?.narrationGap ?? (() => 0),
    });
    const runs = (this.runs = new ChatRuns({
      ...context,
      runtime,
      inputs: this.inputs,
      steering: this.steering,
      queue: this.queue,
      narration: this.narration,
      dice: this.dice,
      diagnostics: this.diagnostics,
      mentions: this.mentions,
    }));
    this.steering.attachRuns(runs);
    this.mentions.attach((...args) => runs.start(...args));
    this.launch = new ChatLaunch({
      ...context,
      cards,
      runs,
      narration: this.narration,
      liveNarration: Boolean(options?.narrationGap),
    });
    this.submissions = new ChatSubmissions({
      ...context,
      inputs: this.inputs,
      runs,
      queue: this.queue,
      mentions: this.mentions,
    });
    this.sync = new ChatSync({
      ...context,
      inputs: this.inputs,
      diagnostics: this.diagnostics,
      launch: this.launch,
    });
  }

  private state(id: string, readOnly = false): Promise<RoomState> {
    if (this.maintainingRooms.has(id))
      throw new ORPCError("UNAVAILABLE", { message: "正在同步模组，请稍后重试" });
    if (this.closing) throw new ORPCError("UNAVAILABLE", { message: "应用正在退出" });
    if (this.closingRooms.has(id)) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭" });
    let pending = this.rooms.get(id);
    if (!pending) {
      pending = this.open(id);
      this.rooms.set(id, pending);
      void pending.catch(() => {
        if (this.rooms.get(id) === pending) this.rooms.delete(id);
      });
    }
    return pending.then(async (state) => {
      if (this.maintainingRooms.has(id))
        throw new ORPCError("UNAVAILABLE", { message: "正在同步模组，请稍后重试" });
      if (this.closing) throw new ORPCError("UNAVAILABLE", { message: "应用正在退出" });
      if (state.closed) throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭" });
      if (!readOnly) assertSessionActive(state.db);
      await this.recoverIdle(state);
      if (this.closing || state.closed)
        throw new ORPCError("UNAVAILABLE", { message: "冒险正在关闭" });
      return state;
    });
  }

  private async open(id: string): Promise<RoomState> {
    const db = await openSessionDatabase(this.root, id);
    try {
      const state: RoomState = { db, events: new EventEmitter(), closed: false };
      state.events.setMaxListeners(0);
      state.events.on("change", () => notifyRoomChanged(roomDirectoryForDatabase(db)));
      await this.recoverIdle(state);
      this.narration.kickNarration(state, id);
      return state;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private recoverIdle(state: RoomState): Promise<void> {
    const pending = this.recovering.get(state);
    if (pending) return pending;
    const recovery = this.recoverMessages(state).finally(() => this.recovering.delete(state));
    this.recovering.set(state, recovery);
    return recovery;
  }

  private async recoverMessages(state: RoomState) {
    for (const message of this.store.queuedMessages(state))
      if (!this.mentions.owns(state, message.id))
        this.store.transaction(state, () =>
          this.store.save(state, {
            ...message,
            status: "interrupted",
            error: "上次点名响应已中断，请重新点名。",
          }),
        );
    this.dice.failPending(state);
    if (this.activity.running(state)) return;
    await this.steering.recover(state);
    await this.inputs.recover(state);
    for (const message of this.store.runningMessages(state, "assistant")) {
      if (message.kind === "assistant" && message.status === "running") {
        const pi = await this.diagnostics.recover(state, message);
        if (state.closed || this.activity.running(state)) return;
        this.store.transaction(state, () =>
          this.store.save(state, {
            ...message,
            ...(pi ? { pi } : {}),
            status: "interrupted",
            error:
              message.inputBatch?.state === "prepared"
                ? "行动尚未送达主持，请房主重试或放弃该批次；期间可以仅聊天。"
                : "上次生成已中断，请发送新消息从当前状态继续。",
          }),
        );
      }
    }
  }

  async details(roomId: string, messageId: string): Promise<AgentDetail[]> {
    const state = await this.state(roomId, true);
    return this.diagnostics.details(state, this.store.message(state, messageId));
  }

  /** 隔离预演的公开背景；正文进入正常聊天与队友公开上下文。 */
  async seedPlaytestBackground(roomId: string, text: string) {
    const state = await this.state(roomId);
    const finish = this.activity.beginConfiguration(state);
    try {
      return this.store.transaction(state, () =>
        this.narration.postScripted(
          state,
          roomId,
          "playtest:background",
          text,
          undefined,
          "预演背景",
        ),
      );
    } finally {
      finish();
    }
  }

  /** 一次队友决策以及其行动的真实主持裁定，整个过程不启动自动接续。 */
  async playtestTurn(roomId: string, companionId: string, signal: AbortSignal) {
    const state = await this.state(roomId);
    const finish = this.activity.beginConfiguration(state);
    const cancel = () => this.activity.running(state)?.abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      this.inputs.assertResolved(state);
      if (this.queue.pendingMessages(state).length)
        throw new Error("预演仍有未处理行动，请检查中断记录或重新创建测试局");
      const companion = readCompanions(state.db).find((item) => item.id === companionId);
      if (!companion) throw new Error("预演队友不存在");
      const auth = await this.credentials(roomId, companion.model);
      signal.throwIfAborted();
      const source = this.store.history(state, undefined, 1).messages[0];
      if (!source) throw new Error("预演缺少背景");
      const character = readCharacters(state.db).find((item) => item.id === companion.characterId);
      const before = source.sequence;
      const message = this.runs.followup(
        state,
        source,
        "",
        auth,
        {
          companion,
          singleTurn: true,
        },
        character?.name ?? "AI 队友",
      );
      await this.activity.running(state)?.done;
      signal.throwIfAborted();
      const generated = this.store
        .history(state, undefined, 100)
        .messages.filter((item) => item.sequence > before);
      if (generated.some((item) => ["failed", "cancelled", "interrupted"].includes(item.status)))
        throw new Error("队友生成未完成，请查看预演记录");
      const pending = this.queue.pendingMessages(state);
      if (!pending.length) return { acted: false, messageId: message.id };
      const hostAuth = await this.credentials(roomId);
      signal.throwIfAborted();
      const host = this.runs.followup(
        state,
        message,
        this.queue.hostPrompt(state, this.queue.pendingTurns(state, pending), pending),
        hostAuth,
        { singleTurn: true, consumePending: pending },
      );
      await this.activity.running(state)?.done;
      signal.throwIfAborted();
      if (this.store.message(state, host.id).status !== "complete")
        throw new Error("主持裁定未完成，请查看预演记录");
      return { acted: true, messageId: host.id };
    } finally {
      signal.removeEventListener("abort", cancel);
      finish();
    }
  }
  async context(roomId: string, companionId?: string) {
    const state = await this.state(roomId, true);
    return this.diagnostics
      .resources(state)
      .piHistory.context(roomDirectoryForDatabase(state.db), companionId);
  }
  async metrics(roomId: string): Promise<SessionMetrics> {
    const state = await this.state(roomId, true);
    return this.diagnostics.metrics(state);
  }

  async compact(roomId: string, companionId?: string) {
    const state = await this.state(roomId);
    if (this.activity.running(state) || this.activity.isConfiguring(state))
      throw new ORPCError("CONFLICT", { message: "请等待当前生成或房间操作完成后再压缩" });
    const release = this.activity.beginConfiguration(state);
    const abort = new AbortController();
    const metrics = this.diagnostics.resources(state).metrics;
    this.compactions.set(state, abort);
    try {
      const companion = companionId
        ? readCompanions(state.db).find((item) => item.id === companionId)
        : undefined;
      if (companionId && !companion)
        throw new ORPCError("NOT_FOUND", { message: "该 AI 队友已离开，无法压缩其会话" });
      metrics.compactingActorId = companionId ?? "host";
      state.events.emit("change");
      const auth = await this.credentials(roomId, companion?.model);
      abort.signal.throwIfAborted();
      await this.runtime.run({
        operation: "compact",
        roomDirectory: roomDirectoryForDatabase(state.db),
        messageId: randomUUID(),
        text: "",
        ...auth,
        companion,
        compaction: readCompactionSettings(state.db)[companion ? "companion" : "host"],
        signal: abort.signal,
        onAgentEvent: () => {},
      });
    } finally {
      this.compactions.delete(state);
      metrics.compactingActorId = undefined;
      release();
      state.events.emit("change");
    }
  }

  async get(input: { roomId: string; messageId: string }) {
    return this.store.message(await this.state(input.roomId, true), input.messageId);
  }

  async history(
    input: { roomId: string; beforeSequence?: number; limit: number },
    player?: Player,
    isHost = false,
  ) {
    const state = await this.state(input.roomId, true);
    if (player && input.beforeSequence === undefined && isSessionActive(state.db))
      await this.launch.syncLaunch(input.roomId, player);
    return {
      ...this.store.history(state, input.beforeSequence, input.limit),
      submissionMode: this.queue.modeSnapshot(state),
      pendingMessageIds: this.queue.pendingMessages(state).map((message) => message.id),
      steering: this.steering.snapshot(state),
      isHost,
    };
  }

  async cancel(roomId: string, messageId: string) {
    const state = await this.state(roomId);
    const running = this.activity.running(state);
    if (!running || (running.messageId !== messageId && running.runId !== messageId)) {
      const requested = this.store.message(state, messageId);
      if (requested.kind !== "assistant" || requested.status !== "queued") return;
    }
    this.mentions.cancel(state);
    // 界面可能还停在排队快照；停止这个队列时一并停止已开始的当前响应。
    if (running) {
      running.abort.abort();
      await running.done;
    }
    await this.mentions.settled(state);
  }

  closeRoom(roomId: string): Promise<void> {
    const closing = this.closingRooms.get(roomId);
    if (closing) return closing;
    const pending = this.rooms.get(roomId);
    if (!pending) return Promise.resolve();
    const task = this.disposeRoom(roomId, pending).finally(() => {
      if (this.rooms.get(roomId) === pending) this.rooms.delete(roomId);
      this.closingRooms.delete(roomId);
    });
    this.closingRooms.set(roomId, task);
    return task;
  }

  /** 仅空闲时关闭旧运行资源；维护期间拒绝新提交，避免同步打断 AI 回复。 */
  async syncModule(roomId: string) {
    const state = await this.state(roomId);
    if (this.maintainingRooms.has(roomId) || state.closed)
      throw new ORPCError("CONFLICT", { message: "正在同步模组，请稍后重试" });
    const launch = readAdventure(roomDirectoryForDatabase(state.db)).launch.state;
    if (
      this.activity.running(state) ||
      this.activity.isConfiguring(state) ||
      this.store.firstQueuedMessage(state) ||
      this.store.runningMessages(state, "dice").length ||
      launch?.opening === "running" ||
      launch?.intro === "telling"
    )
      throw new ORPCError("CONFLICT", {
        message: "请等待 AI 回复、开场和回应队列完成后再同步模组",
      });
    const release = this.activity.beginConfiguration(state);
    this.maintainingRooms.add(roomId);
    // 在首次 await 前封住已有调用持有的连接，避免等待凭据的提交趁关闭间隙启动。
    state.closed = true;
    try {
      // 释放配置互斥后同步标记仍然有效；关闭操作会等待其他已经进入的业务结束。
      release();
      await this.closeRoom(roomId);
      return await syncModule(this.root, roomId);
    } finally {
      release();
      this.maintainingRooms.delete(roomId);
    }
  }

  private async disposeRoom(roomId: string, pending: Promise<RoomState>) {
    const state = await pending.catch(() => undefined);
    if (!state) return;
    state.closed = true;
    const errors: unknown[] = [];
    const cleanup = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    // 一项释放失败不能跳过其他资源；先停止生产，再等待读写结束，最后关闭连接。
    await cleanup(() => this.mentions.cancel(state));
    await cleanup(() => this.sync.closeRoom(roomId));
    const narration = cleanup(() => this.narration.closeRoom(state));
    await cleanup(() => state.events.emit("change"));
    const running = this.activity.running(state);
    await cleanup(() => this.compactions.get(state)?.abort());
    await cleanup(() => running?.abort.abort());
    await cleanup(() => running?.done);
    await cleanup(() => this.mentions.settled(state));
    await narration;
    await cleanup(() => this.activity.settled(state));
    await cleanup(() => this.recovering.get(state));
    await cleanup(() => this.runtime.closeRoom?.(roomDirectoryForDatabase(state.db)));
    await cleanup(() => this.diagnostics.close(state));
    await cleanup(() => this.dice.closeRoom(state));
    await cleanup(() =>
      withStateLock(gameDirectoryForDatabase(state.db), async () => state.db.close()),
    );
    // 工作区已被外部移走时，获取文件锁也可能失败，连接仍须释放。
    await cleanup(() => state.db.close());
    await cleanup(() => forgetRoomResources(roomDirectoryForDatabase(state.db)));
    state.events.removeAllListeners();
    if (errors.length) throw new AggregateError(errors, "冒险关闭时部分资源释放失败");
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = Promise.allSettled(
      [...this.rooms.keys()].map((roomId) => this.closeRoom(roomId)),
    ).then((results) => {
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "部分冒险关闭失败");
    });
    return this.closeTask;
  }

  async openLaunch(roomId: string, player: Player): Promise<void> {
    return this.launch.openLaunch(roomId, player);
  }

  async syncLaunch(roomId: string, player: Player): Promise<void> {
    return this.launch.syncLaunch(roomId, player);
  }

  async chooseStart(roomId: string, player: Player, messageId: string, startId: string) {
    return this.launch.chooseStart(roomId, player, messageId, startId);
  }

  async confirmReady(roomId: string, player: Player, messageId: string) {
    return this.launch.confirmReady(roomId, player, messageId);
  }

  async setSubmissionMode(roomId: string, mode: SubmissionMode) {
    return this.queue.setSubmissionMode(roomId, mode);
  }
  async mentionTargets(roomId: string, player: Player) {
    return this.mentions.targets(await this.state(roomId, true), player);
  }
  setMentionReplyLimit(roomId: string, limit: number) {
    return this.mentions.setLimit(roomId, limit);
  }

  async resolveInput(
    input: { roomId: string; messageId: string; batchId: string; action: "retry" | "abandon" },
    player: Player,
  ) {
    return this.submissions.resolveInput(input, player);
  }

  async convertToChat(input: { roomId: string; messageId: string }, player: Player) {
    return this.submissions.convertToChat(input, player);
  }

  async continue(input: { roomId: string; clientRequestId: string }, player: Player) {
    return this.submissions.continue(input, player);
  }

  async send(input: SendInput, player: Player): Promise<ChatMessage> {
    const state = await this.state(input.roomId);
    if (
      readAdventureState(state.db).party.members.some(
        (member) => member.id === player.id && member.relay,
      )
    )
      throw new Error("请先接回角色再发送消息");
    return this.submissions.send(input, player);
  }

  async registerMember(roomId: string, player: Player) {
    const state = await this.state(roomId);
    this.store.transaction(state, () =>
      updateAdventureState(state.db, (current) => {
        const member = current.party.members.find((item) => item.id === player.id);
        if (member) member.nickname = player.nickname;
        else current.party.members.push({ ...player, relay: false });
      }),
    );
  }
  async setMemberRelay(roomId: string, playerId: string, enabled: boolean) {
    return this.companions.setRelay(roomId, playerId, enabled);
  }
  async removeMember(roomId: string, playerId: string) {
    return this.companions.removeMember(roomId, playerId);
  }
  async companionSettings(roomId: string) {
    return this.companions.companionSettings(roomId);
  }

  async selectCompanion(roomId: string, characterId: string, seatId?: string) {
    return this.companions.selectCompanion(roomId, characterId, seatId);
  }

  async saveCompanion(roomId: string, id: string, input: CompanionInput | null, player: Player) {
    return this.companions.saveCompanion(roomId, id, input, player);
  }

  async setCompanionModel(roomId: string, id: string, model: CompanionModel | null) {
    return this.companions.setCompanionModel(roomId, id, model);
  }

  async setCompanionInitiative(roomId: string, id: string, initiative: CompanionInitiative) {
    return this.companions.setCompanionInitiative(roomId, id, initiative);
  }

  async setCompanionDocumentAccess(roomId: string, id: string, enabled: boolean) {
    return this.companions.setCompanionDocumentAccess(roomId, id, enabled);
  }

  async setCompanionVoice(roomId: string, id: string, voice: TtsVoiceOverride | null) {
    return this.companions.setCompanionVoice(roomId, id, voice);
  }

  async requestAgentDice(
    input: DiceOptions & { roomId: string; requestId: string },
    origin?: { sourceMessageId: string; sourceAttemptId?: string; afterMessageIndex: number },
  ) {
    return this.dice.requestAgentDice(input, origin);
  }

  async rollDice(input: { roomId: string; messageId: string }, player: Player) {
    return this.dice.rollDice(input, player);
  }

  async launchState(roomId: string, player: Player) {
    return this.launch.launchState(roomId, player);
  }

  async advanceLaunch(input: LaunchAction, player: Player) {
    return this.launch.advanceLaunch(input, player);
  }

  async roomProjection(roomId: string, player: Player): Promise<RoomProjection> {
    return this.sync.roomProjection(roomId, player);
  }

  async *subscribeRoom(
    input: {
      roomId: string;
      protocolVersion: number;
      baselineVersion: string;
      afterChatCursor: number;
      afterChatStreamId: string;
    },
    player: Player,
    signal?: AbortSignal,
  ) {
    yield* this.sync.subscribeRoom(input, player, signal);
  }

  acknowledgeRoom(
    input: { roomId: string; subscriptionId: string; sequence: number },
    player: Player,
  ) {
    return this.sync.acknowledgeRoom(input, player);
  }
}
