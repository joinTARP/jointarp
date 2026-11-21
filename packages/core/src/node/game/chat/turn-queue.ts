import { ORPCError } from "@orpc/server";

import { chatText } from "../../../shared/agent-message";
import { messageSchema } from "../../../shared/game";
import type { ChatMessage, SubmissionMode, SubmissionModeSnapshot } from "../../../shared/game";
import { readCharacters } from "../../sessions/character-db";
import { movementPrompt } from "../../sessions/map-description";
import { readRoomSettings, updateRoomSettings } from "../../sessions/room-settings";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { chatField } from "../../storage/session-database";
import { playerTurnPrompt, type PlayerTurn } from "../player-turn";
import type { ChatInputBatches } from "./input-batches";
import type { ChatContext, RoomState } from "./types";
/** 待提交行动、提交模式与主持输入；不启动 AI，也不依赖提交入口。 */
export class ChatTurnQueue {
  constructor(
    private readonly context: Pick<ChatContext, "state" | "store"> & {
      inputs: Pick<ChatInputBatches, "isPreparedSource">;
    },
  ) {}

  mode(state: RoomState): SubmissionMode {
    return this.modeSnapshot(state).mode;
  }
  modeSnapshot(state: RoomState): SubmissionModeSnapshot {
    const settings = readRoomSettings(roomDirectoryForDatabase(state.db)).chat;
    return { mode: settings.submissionMode, revision: settings.submissionModeRevision };
  }
  async setSubmissionMode(roomId: string, mode: SubmissionMode): Promise<SubmissionModeSnapshot> {
    const state = await this.context.state(roomId);
    const current = this.modeSnapshot(state);
    if (current.mode === mode) return current;
    const settings = updateRoomSettings(roomDirectoryForDatabase(state.db), (settings) => ({
      ...settings,
      chat: { ...settings.chat, submissionMode: mode },
    }));
    const snapshot = {
      mode: settings.chat.submissionMode,
      revision: settings.chat.submissionModeRevision,
    };
    this.context.store.publishSubmissionMode(state, snapshot);
    return snapshot;
  }
  pendingMessages(state: RoomState): ChatMessage[] {
    return state.db
      .all(
        state.db.query
          .selectFrom("chat_messages")
          .select("data")
          .where(chatField<number>("pendingAgent"), "=", 1)
          .orderBy("sequence", "asc"),
      )
      .map((row) => messageSchema.parse(JSON.parse(String(row.data))));
  }
  pendingTurns(state: RoomState, pending: readonly ChatMessage[]): PlayerTurn[] {
    const names = new Map(readCharacters(state.db).map((item) => [item.playerId, item.name]));
    return pending.flatMap((message) => {
      if (message.kind === "player")
        return [
          {
            playerId: message.senderId,
            characterName: names.get(message.senderId),
            text: chatText(message),
            ...(message.movement
              ? { movement: movementPrompt(state.db, message.id, message.movement) }
              : {}),
          },
        ];
      if (message.kind === "assistant" && message.companionId && message.pendingAction)
        return [
          {
            playerId: message.companionId,
            characterName: message.nickname,
            text: message.pendingAction,
          },
        ];
      return [];
    });
  }
  /** 在调用方的写事务内转为聊天；按消息 ID 幂等，不影响后来的新行动。 */
  convertToChat(state: RoomState, messageId: string, authorId: string): ChatMessage {
    const message = this.context.store.message(state, messageId);
    if (
      message.senderId !== authorId ||
      (message.kind !== "player" &&
        !(message.kind === "assistant" && message.companionId === authorId))
    )
      throw new ORPCError("FORBIDDEN", { message: "只能将自己的待提交行动改为聊天" });
    if (message.chatOnly) return message;
    if (
      !message.pendingAgent ||
      message.status !== "complete" ||
      this.context.inputs.isPreparedSource(state, messageId)
    )
      throw new ORPCError("CONFLICT", {
        message: "该行动已开始提交或不在待提交队列中，无法改为聊天",
      });
    return this.context.store.save(state, {
      ...message,
      chatOnly: true,
      pendingAgent: undefined,
      ...(message.kind === "assistant" ? { pendingAction: undefined } : {}),
    });
  }
  /** 新行动只替换本人尚未进入主持输入批次的行动，旧正文仍作为聊天保留。 */
  replacePending(state: RoomState, authorId: string) {
    for (const message of this.pendingMessages(state))
      if (message.senderId === authorId && !this.context.inputs.isPreparedSource(state, message.id))
        this.convertToChat(state, message.id, authorId);
  }
  consumePending(state: RoomState, pending: readonly ChatMessage[]) {
    for (const message of pending) {
      if (message.kind === "assistant")
        this.context.store.save(state, {
          ...message,
          pendingAgent: undefined,
          pendingAction: undefined,
        });
      else this.context.store.save(state, { ...message, pendingAgent: undefined });
    }
  }
  hostPrompt(_state: RoomState, turns: readonly PlayerTurn[], _pending: readonly ChatMessage[]) {
    return playerTurnPrompt(turns);
  }
}
