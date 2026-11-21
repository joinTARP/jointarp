import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { oc, eventIterator } from "@orpc/contract";
import { z } from "zod";

import { diceDataSchema } from "./dice";
import { identityIdSchema } from "./identity";
import { launchActionSchema } from "./launch";
import { movementIntentInputSchema, movementIntentSchema } from "./map";
import { mentionTargetSchema, mentionReplyLimitSchema, mentionsSchema } from "./mentions";
import { ROOM_PROTOCOL_VERSION, roomStateFrameSchema, type RoomLaunchState } from "./room-state";

export const playerSchema = z.object({
  id: identityIdSchema,
  nickname: z.string().trim().min(1).max(32),
});
export type Player = z.infer<typeof playerSchema>;
// 仅 agent 内容使用 pi 原生模型；玩家消息和房间属性仍由游戏业务定义。
const publicToolCallSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string(),
  name: z.string(),
  arguments: z.custom<JsonObject>(
    (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  ),
});
const publicAssistantObject = z.object({
  role: z.literal("assistant"),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      publicToolCallSchema,
    ]),
  ),
  api: z.string(),
  provider: z.string(),
  model: z.string(),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  usage: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    totalTokens: z.number(),
    cacheWrite1h: z.number().optional(),
    reasoning: z.number().optional(),
    cost: z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      total: z.number(),
    }),
  }),
  stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
  timestamp: z.number(),
});
export const publicAssistantSchema = z
  .custom<AssistantMessage>()
  .transform((value): AssistantMessage => publicAssistantObject.parse(value) as AssistantMessage);
export const piMessageReferenceSchema = z.object({
  sessionId: z.string().min(1),
  beforeEntryId: z.string().min(1).nullable(),
  afterEntryId: z.string().min(1).nullable(),
});
export type PiMessageReference = z.infer<typeof piMessageReferenceSchema>;

const messageBase = z.object({
  id: z.string().uuid(),
  sequence: z.number().int(),
  roomId: z.string().uuid(),
  senderId: z.string(),
  nickname: z.string(),
  createdAt: z.string(),
  status: z.enum(["queued", "complete", "running", "cancelled", "failed", "interrupted"]),
  replyToMessageId: z.string().uuid().optional(),
  /** 已由主机确认的点名目标；省略或为空表示没有点名。 */
  mentions: mentionsSchema.optional(),
  attemptId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
  /** 等待主持人处理的真人或 AI 队友行动，内容可以包含动作和台词。 */
  pendingAgent: z.boolean().optional(),
});
const cardDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    players: z.array(
      z.object({
        id: identityIdSchema,
        nickname: z.string().min(1).max(32),
        confirmed: z.boolean(),
      }),
    ),
  }),
  z.object({
    type: z.literal("start"),
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        detail: z.string().optional(),
      }),
    ),
    selectedId: z.string().optional(),
  }),
  z.object({
    type: z.literal("character"),
    playerId: identityIdSchema,
    selectedId: identityIdSchema.optional(),
    selectedLabel: z.string().optional(),
  }),
  z.object({
    type: z.literal("companions"),
    playerId: identityIdSchema,
    stage: z.enum(["prompt", "select", "complete"]),
    selected: z.array(z.object({ id: identityIdSchema, name: z.string() })).optional(),
  }),
]);
export type CardData = z.infer<typeof cardDataSchema>;
export const hostInputBatchSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(["prepared", "received", "abandoned"]),
  sourceIds: z.array(z.string().uuid()).min(1),
  turns: z
    .array(
      z.object({
        playerId: identityIdSchema,
        characterName: z.string().optional(),
        text: z.string(),
        movement: z.string().optional(),
      }),
    )
    .min(1),
});

export const messageSchema = z.discriminatedUnion("kind", [
  messageBase.extend({ kind: z.literal("dice"), dice: diceDataSchema }),
  messageBase.extend({
    kind: z.literal("player"),
    text: z.string(),
    /** 仅聊天，不作为行动裁定；合法点名主持时可唤起主持场外回应。 */
    chatOnly: z.boolean(),
    /** 随行动提交的移动意图卡；实际结果由主持确认后体现在地图上。 */
    movement: movementIntentSchema.optional(),
  }),
  messageBase.extend({ kind: z.literal("card"), card: cardDataSchema }),
  messageBase.extend({
    kind: z.literal("scripted"),
    text: z.string(),
    speakerPath: z.string().optional(),
    postKey: z.string().optional(),
  }),
  messageBase.extend({
    kind: z.literal("assistant"),
    agentMessages: z.array(publicAssistantSchema),
    inputBatch: hostInputBatchSchema.pick({ id: true, state: true }).optional(),
    /** 原生 Pi 历史范围：(beforeEntryId, afterEntryId]。 */
    pi: piMessageReferenceSchema.optional(),
    modelInfo: z
      .object({
        provider: z.string(),
        model: z.string(),
        contextWindow: z.number().positive().optional(),
      })
      .optional(),
    /** 不进入玩家可见正文：预写开场的初始化，或队友尚未决定开口的回合。沉默会一直保持此标记。 */
    internal: z.boolean().optional(),
    companionId: identityIdSchema.optional(),
    chatOnly: z.boolean().optional(),
    /** 队友等待主持人处理的行动，可以包含动作和台词。 */
    pendingAction: z.string().optional(),
    /** 队友未调用模型时的可公开业务原因。 */
  }),
]);
export type ChatMessage = z.infer<typeof messageSchema>;
export const publicAgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("usage"),
    messageIndex: z.number().int().nonnegative(),
    usage: publicAssistantObject.shape.usage,
  }),
  z.object({
    type: z.literal("message_start"),
    messageIndex: z.number().int().nonnegative(),
    message: publicAssistantSchema,
  }),
  z.object({
    type: z.literal("message_end"),
    messageIndex: z.number().int().nonnegative(),
    message: publicAssistantSchema,
  }),
  z.object({
    type: z.literal("text_start"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("text_delta"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal("text_end"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("toolcall_start"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
    toolCall: publicToolCallSchema,
  }),
  z.object({
    type: z.literal("toolcall_delta"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
    toolCall: publicToolCallSchema,
  }),
  z.object({
    type: z.literal("toolcall_end"),
    messageIndex: z.number().int().nonnegative(),
    contentIndex: z.number().int().nonnegative(),
    toolCall: publicToolCallSchema,
  }),
]);
export type PublicAgentEvent = z.infer<typeof publicAgentEventSchema>;
export const steeringEntrySchema = z.object({
  id: z.string().uuid(),
  playerId: identityIdSchema,
  nickname: z.string(),
  text: z.string().trim().min(1).max(4000),
  createdAt: z.string(),
  sequence: z.number().int(),
  state: z.enum(["pending", "manual", "claimed"]),
});
export type SteeringEntry = z.infer<typeof steeringEntrySchema>;
export const steeringSnapshotSchema = z.object({
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  entries: z.array(steeringEntrySchema),
});
export type SteeringSnapshot = z.infer<typeof steeringSnapshotSchema>;
export const submissionModeSchema = z.enum(["auto", "manual"]);
export type SubmissionMode = z.infer<typeof submissionModeSchema>;
export const submissionModeSnapshotSchema = z.object({
  mode: submissionModeSchema,
  revision: z.number().int().nonnegative().safe(),
});
export type SubmissionModeSnapshot = z.infer<typeof submissionModeSnapshotSchema>;
export const chatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), cursor: z.number().int(), message: messageSchema }),
  z.object({
    type: z.literal("mode"),
    cursor: z.number().int(),
    snapshot: submissionModeSnapshotSchema,
  }),
  z.object({
    type: z.literal("steering"),
    cursor: z.number().int(),
    snapshot: steeringSnapshotSchema,
  }),
  z.object({
    type: z.literal("agent"),
    cursor: z.number().int(),
    messageId: z.string().uuid(),
    attemptId: z.string().uuid(),
    revision: z.number().int(),
    events: z.array(publicAgentEventSchema),
  }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
const roomDeliverySchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int().positive().safe(),
});
const roomNotificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state"), frame: roomStateFrameSchema, delivery: roomDeliverySchema }),
  z.object({ type: z.literal("chat"), event: chatEventSchema, delivery: roomDeliverySchema }),
]);
export type RoomNotification = z.infer<typeof roomNotificationSchema>;
const room = z.object({ roomId: z.string().uuid() });
const sendSchema = room
  .extend({
    clientMessageId: z.string().uuid(),
    text: z.string().trim().max(4000),
    chatOnly: z.boolean(),
    movement: movementIntentInputSchema.optional(),
  })
  .refine((input) => input.text || input.movement, { message: "消息不能为空", path: ["text"] });
export type SendInput = z.infer<typeof sendSchema>;
export const gameContract = {
  room: {
    subscribe: oc
      .input(
        room.extend({
          protocolVersion: z.literal(ROOM_PROTOCOL_VERSION),
          baselineVersion: z.string().regex(/^[a-f0-9]{64}$/),
          afterChatCursor: z.number().int().nonnegative().safe(),
          afterChatStreamId: z.string().uuid(),
        }),
      )
      .output(eventIterator(roomNotificationSchema, z.void())),
    acknowledge: oc
      .input(
        room.extend({
          subscriptionId: z.string().uuid(),
          sequence: z.number().int().positive().safe(),
        }),
      )
      .output(z.void()),
  },
  launch: {
    get: oc.input(room).output(z.custom<RoomLaunchState | null>()),
    advance: oc.input(launchActionSchema).output(z.custom<RoomLaunchState | null>()),
    confirmReady: oc.input(room.extend({ messageId: z.string().uuid() })).output(z.void()),
    chooseStart: oc
      .input(room.extend({ messageId: z.string().uuid(), startId: z.string() }))
      .output(z.void()),
    open: oc.input(room).output(z.void()),
  },
  dice: {
    roll: oc.input(room.extend({ messageId: z.string().uuid() })).output(messageSchema),
  },
  chat: {
    mentionTargets: oc.input(room).output(z.array(mentionTargetSchema)),
    setMentionReplyLimit: oc
      .input(room.extend({ limit: mentionReplyLimitSchema }))
      .output(mentionReplyLimitSchema),
    get: oc.input(room.extend({ messageId: z.string().uuid() })).output(messageSchema),
    send: oc.input(sendSchema).output(messageSchema),
    convertToChat: oc.input(room.extend({ messageId: z.string().uuid() })).output(messageSchema),
    setSubmissionMode: oc
      .input(room.extend({ mode: submissionModeSchema }))
      .output(submissionModeSnapshotSchema),
    continue: oc.input(room.extend({ clientRequestId: z.string().uuid() })).output(messageSchema),
    resolveInput: oc
      .input(
        room.extend({
          messageId: z.string().uuid(),
          batchId: z.string().uuid(),
          action: z.enum(["retry", "abandon"]),
        }),
      )
      .output(messageSchema),
    history: oc
      .input(
        room.extend({
          beforeSequence: z.number().int().positive().optional(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
      )
      .output(
        z.object({
          messages: z.array(messageSchema),
          cursor: z.number().int(),
          streamId: z.string().uuid(),
          hasMore: z.boolean(),
          submissionMode: submissionModeSnapshotSchema,
          pendingMessageIds: z.array(z.string().uuid()),
          steering: steeringSnapshotSchema,
          isHost: z.boolean(),
        }),
      ),
  },
  steering: {
    get: oc.input(room).output(z.object({ snapshot: steeringSnapshotSchema, isHost: z.boolean() })),
    enqueue: oc
      .input(
        room.extend({
          clientRequestId: z.string().uuid(),
          text: z.string().trim().min(1).max(4000),
        }),
      )
      .output(steeringSnapshotSchema),
    remove: oc.input(room.extend({ entryId: z.string().uuid() })).output(steeringSnapshotSchema),
    setEnabled: oc.input(room.extend({ enabled: z.boolean() })).output(steeringSnapshotSchema),
    submit: oc
      .input(room.extend({ clientRequestId: z.string().uuid(), interrupt: z.boolean() }))
      .output(steeringSnapshotSchema),
  },
  agent: {
    cancel: oc.input(room.extend({ messageId: z.string().uuid() })).output(z.void()),
  },
};

export const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;

export const aiConfigSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  thinkingLevel: thinkingLevelSchema.optional(),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

export const availableAiModelSchema = aiConfigSchema
  .extend({
    name: z.string(),
    providerName: z.string(),
  })
  .strict();
export type AvailableAiModel = z.infer<typeof availableAiModelSchema>;

export const customAiApis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export interface AiProviderSettings {
  id: string;
  name: string;
  custom: boolean;
  hasKey: boolean;
  baseUrl?: string;
  api?: (typeof customAiApis)[number];
  model?: string;
  reasoning?: boolean;
}
export interface AiSettings {
  providers: AiProviderSettings[];
  defaultModel: AvailableAiModel | null;
}

export interface RoomAiSettings {
  selection: AvailableAiModel | null;
  ready: boolean;
}
