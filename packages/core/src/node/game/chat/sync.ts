import { createHash } from "node:crypto";

import { ORPCError } from "@orpc/server";

import type { ChatMessage, Player } from "../../../shared/game";
import type { ChatActivitySnapshot, RoomBaseline, RoomReplica } from "../../../shared/room-state";
import type { RoomProjection } from "../../../shared/room-state";
import { updateAdventureState, readAdventureState } from "../../sessions/adventure-state";
import { stateRevision } from "../../sessions/game-state";
import { launchState } from "../../sessions/launch-store";
import { notifyRoomChanged, roomGeneration } from "../../sessions/room-changes";
import { readRoomFileSync } from "../../sessions/room-file";
import { gameDirectoryForDatabase, roomDirectoryForDatabase } from "../../sessions/session-paths";
import { isSessionActive } from "../../sessions/session-store";
import { withStateLock } from "../../sessions/state-lock";
import { RoomDeliveryWindow } from "../room-delivery-window";
import { projectEntities, projectLaunch, projectRoomBaseline } from "../room-state-projection";
import { subscribeRoomState } from "../room-state-service";
import type { ChatInputBatches } from "./input-batches";
import type { ChatLaunch } from "./launch";
import type { ChatRunDiagnostics } from "./run-diagnostics";
import type { ChatContext, RoomState } from "./types";
type SyncContext = Pick<ChatContext, "root" | "state" | "store" | "activity" | "isClosing"> & {
  diagnostics: ChatRunDiagnostics;
  inputs: ChatInputBatches;
  launch: Pick<ChatLaunch, "syncLaunch">;
};

/** 房间投影与订阅生命周期。 */
export class ChatSync {
  constructor(private readonly context: SyncContext) {}

  private rooms = new WeakMap<
    RoomState,
    {
      baseline?: RoomBaseline;
      playerProjections: Map<
        string,
        {
          revision: number;
          launch: RoomReplica["sections"]["launch"];
        }
      >;
    }
  >();
  private projection(state: RoomState) {
    let projection = this.rooms.get(state);
    if (!projection) this.rooms.set(state, (projection = { playerProjections: new Map() }));
    return projection;
  }

  private deliveries = new Map<
    string,
    { roomId: string; playerId: string; window: RoomDeliveryWindow }
  >();

  closeRoom(roomId: string) {
    for (const [id, delivery] of this.deliveries)
      if (delivery.roomId === roomId) {
        delivery.window.close();
        this.deliveries.delete(id);
      }
  }

  private roomBaseline(state: RoomState) {
    return withStateLock(
      gameDirectoryForDatabase(state.db),
      async () => (this.projection(state).baseline ??= await projectRoomBaseline(state.db)),
    );
  }

  private chatActivity(state: RoomState): ChatActivitySnapshot {
    const describe = (message: ChatMessage) => ({
      messageId: message.id,
      nickname: message.nickname,
      companionId: message.kind === "assistant" ? message.companionId : undefined,
      ...(message.kind === "assistant" && message.chatOnly ? { chatOnly: true } : {}),
      internal: message.kind === "assistant" && Boolean(message.internal),
    });
    const run = this.context.activity.running(state);
    const queued = this.context.store.firstQueuedMessage(state);
    const pending = this.context.inputs.prepared(state)[0];
    return {
      ...(!run && pending
        ? { pendingInput: { messageId: pending.id, batchId: pending.inputBatch!.id } }
        : {}),
      running: run
        ? {
            ...describe(this.context.store.message(state, run.messageId)),
            runId: run.runId,
          }
        : null,
      queued: queued ? describe(queued) : null,
    };
  }

  async roomProjection(roomId: string, player: Player): Promise<RoomProjection> {
    const state = await this.context.state(roomId, true);
    const directory = roomDirectoryForDatabase(state.db);
    // 统计读取不占用文档锁；异步期间发生提交则重试，仍返回同一代数的投影。
    for (let attempt = 0; attempt < 8; attempt++) {
      const generation = roomGeneration(directory);
      const metrics = await this.context.diagnostics.metrics(state);
      const replica = await withStateLock(gameDirectoryForDatabase(state.db), async () => {
        if (state.closed) throw new ORPCError("UNAVAILABLE");
        if (generation !== roomGeneration(directory)) return;
        const revision = stateRevision(state.db);
        let view = this.projection(state).playerProjections.get(player.id);
        if (view?.revision !== revision) {
          view = {
            revision,
            launch: projectLaunch(
              state.db,
              await launchState(this.context.root, roomId, player.id, { raw: true }),
            ),
          };
          this.projection(state).playerProjections.set(player.id, view);
        }
        // 聊天文本与运行指标频繁变化，文档未提交时复用公开投影。
        const { entities, documentRevision, overlayRevision, overlays } = await projectEntities(
          state.db,
        );
        if (state.closed) throw new ORPCError("UNAVAILABLE");
        if (generation !== roomGeneration(directory)) return;
        const selection = readAdventureState(state.db);
        return {
          entities,
          documentRevision,
          overlayRevision,
          overlays,
          sections: {
            viewerId: player.id,
            room: readRoomFileSync(directory).room,
            launch: view.launch,
            metrics,
            chatActivity: this.chatActivity(state),
            companionVersion: createHash("sha256")
              .update(
                JSON.stringify({
                  startId: selection.launch.state?.startId,
                  party: selection.party,
                  online: this.context.activity.players(state),
                  reservations: Object.entries(selection.launch.players).flatMap(
                    ([id, progress]) =>
                      progress.characterId && !progress.confirmed
                        ? [[id, progress.characterId]]
                        : [],
                  ),
                  documentRevision,
                }),
              )
              .digest("hex"),
          },
        };
      });
      if (replica) return replica;
    }
    throw new ORPCError("CONFLICT", { message: "房间状态正在变化，请重新同步" });
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
    const state = await this.context.state(input.roomId, true);
    if (signal?.aborted) return;
    const baseline = await this.roomBaseline(state);
    if (input.baselineVersion !== baseline.version)
      throw new ORPCError("PRECONDITION_FAILED", {
        message: "本地冻结模组版本与房间不匹配，请恢复相同版本的 session/module 后重试",
        data: { reason: "BASELINE_MISMATCH" },
      });
    if (isSessionActive(state.db)) await this.context.launch.syncLaunch(input.roomId, player);
    this.context.store.transaction(state, () =>
      updateAdventureState(state.db, (adventure) => {
        const member = adventure.party.members.find((item) => item.id === player.id);
        if (member) member.nickname = player.nickname;
        else adventure.party.members.push({ ...player, relay: false });
      }),
    );
    const releaseViewer = this.context.activity.retainPlayer(state, player);
    notifyRoomChanged(roomDirectoryForDatabase(state.db));
    const delivery = new RoomDeliveryWindow();
    this.deliveries.set(delivery.id, {
      roomId: input.roomId,
      playerId: player.id,
      window: delivery,
    });
    try {
      yield* subscribeRoomState(
        {
          directory: roomDirectoryForDatabase(state.db),
          protocolVersion: input.protocolVersion,
          baseline,
          afterChatCursor: input.afterChatCursor,
          delivery,
          closed: () => state.closed || this.context.isClosing(),
          project: () => this.roomProjection(input.roomId, player),
          chat: (cursor, limit) =>
            this.context.store.eventsAfter(state, input.afterChatStreamId, cursor, limit),
        },
        signal,
      );
    } finally {
      delivery.close();
      this.deliveries.delete(delivery.id);
      if (releaseViewer()) {
        this.projection(state).playerProjections.delete(player.id);
        notifyRoomChanged(roomDirectoryForDatabase(state.db));
      }
    }
  }

  acknowledgeRoom(
    input: { roomId: string; subscriptionId: string; sequence: number },
    player: Player,
  ) {
    const delivery = this.deliveries.get(input.subscriptionId);
    if (!delivery) return; // 已结束订阅的迟到确认无副作用。
    if (delivery.roomId !== input.roomId || delivery.playerId !== player.id)
      throw new ORPCError("FORBIDDEN", { message: "此同步订阅不属于当前玩家" });
    delivery.window.acknowledge(input.sequence);
  }
}
