import { RoomStateEncoder } from "../node/game/room-state-encoder";
import type { RoomBaseline, RoomReplica } from "../shared/room-state";
import { roomEntityOverlays } from "../shared/room-state-overlay";

export function createRoomBaseline(entities: RoomReplica["entities"] = {}): RoomBaseline {
  return { version: "0".repeat(64), entities: structuredClone(entities) };
}

export function createRoomReplica(): RoomReplica {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
    attempts: 0,
    completedAttempts: 0,
    toolCalls: 0,
  };
  return {
    documentRevision: 0,
    sections: {
      viewerId: "8d03c680-4f8d-4d9e-ae52-6f95eaee7232",
      room: {
        id: "3fe4416d-e04c-4451-85bb-f783536578d5",
        name: "测试房间",
        moduleName: "测试",
        status: "active",
        createdAt: "2026-10-05",
        updatedAt: "2026-10-05",
      },
      launch: null,
      companionVersion: "initial",
      map: { maps: [] },
      chatActivity: { running: null, queued: null },
      metrics: {
        host: {
          id: "host",
          name: "主持人",
          current: {
            provider: null,
            model: null,
            status: "idle",
            startedAt: null,
            contextTokens: 0,
            contextWindow: null,
          },
          totals,
        },
        companions: [],
        totals,
      },
    },
    entities: {
      monster: {
        id: "monster",
        revision: 1,
        document: {
          path: "怪物/怪物.json",
          title: "未知怪物",
          docType: "怪物",
          valid: true,
          values: { hp: 10, inventory: [{ item: "药水", count: 1 }], option: null },
        },
      },
      trap: {
        id: "trap",
        revision: 1,
        document: {
          path: "机关/陷阱.json",
          title: "陷阱",
          docType: "机关",
          valid: true,
          values: { triggered: false },
        },
      },
    },
  };
}

/** 测试按当前协议提供累计覆盖，不依赖编码器中的全量文档备用输入。 */
export function createRoomEncoder(baseline: RoomBaseline = createRoomBaseline()) {
  const encoder = new RoomStateEncoder(baseline);
  let overlayRevision = 0;
  return {
    update(replica: RoomReplica) {
      return encoder.update({
        ...replica,
        overlays: roomEntityOverlays(baseline, replica.entities),
        overlayRevision: ++overlayRevision,
      });
    },
  };
}
