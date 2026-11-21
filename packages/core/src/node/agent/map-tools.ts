import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { moveToken, readMap, updateMap } from "../sessions/map-commands";
import { mapSides } from "../sessions/map-space";
import type { SessionDatabase } from "../storage/session-database";

type WithDatabase = <T>(fn: (db: SessionDatabase) => Promise<T>) => Promise<T>;

function output(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

const side = Type.Union(
  mapSides.map((item) => Type.Literal(item)),
  { description: "区域或标记的方位，默认 center（区域）或自动选择空位（标记）" },
);
const anchor = Type.Union(
  [
    Type.Object({ start: Type.String({ description: "起点 id 或名称" }) }),
    Type.Object({
      region: Type.String({ description: "区域 id 或名称" }),
      side: Type.Optional(side),
    }),
    Type.Object({ near: Type.String({ description: "相邻的标记 id" }), side: Type.Optional(side) }),
    Type.Object({ x: Type.Number(), y: Type.Number() }),
  ],
  { description: "位置：起点、区域方位、标记旁边，或距离单位坐标（原点在左上角，y 向下）" },
);
const flags = {
  label: Type.Optional(Type.String({ description: "显示名称" })),
  size: Type.Optional(Type.Number({ description: "占地边长：方格地图按格，无网格按距离单位" })),
  hidden: Type.Optional(Type.Boolean({ description: "对玩家隐藏，即使在视野内也不显示" })),
  blocksVision: Type.Optional(Type.Boolean({ description: "遮挡视线" })),
  blocksMovement: Type.Optional(Type.Boolean({ description: "阻挡通行的提示，平台不强制" })),
  vision: Type.Optional(
    Type.Union([Type.Number(), Type.Null()], {
      description: "覆盖地图默认视距（距离单位），null 表示不限距离",
    }),
  ),
};

/** 主持维护平台地图：位置、门与探索记录。与模组位置字段相互独立。 */
export function createMapTools(
  withDatabase: WithDatabase,
  signal: AbortSignal,
): ToolDefinition<any, any, any>[] {
  return [
    {
      name: "map_read",
      label: "读取地图",
      executionMode: "sequential",
      description:
        "读取平台地图。省略 map 列出全部地图、是否对玩家可见及队伍所在；指定 map 返回区域（含秘密区域、备注与已探索比例）、门（位置、两侧区域、开关与秘门揭示状态）、起点、当前可通行方向的跨图连接 exits（from、map、to）和全部标记（区域、是否在队伍视野内、隐藏与遮挡）。坐标与距离使用地图的距离单位，原点在左上角，y 向下。结果含玩家不可见的信息，叙述时只描述角色能感知的部分。",
      parameters: Type.Object({
        map: Type.Optional(Type.String({ description: "地图 id 或名称" })),
      }),
      execute: async (_id, params: { map?: string }) => {
        signal.throwIfAborted();
        return output(await withDatabase(async (db) => readMap(db, params.map)));
      },
    },
    {
      name: "map_move",
      label: "移动地图标记",
      executionMode: "sequential",
      description:
        "在同一张地图上移动标记。intent 填携带移动意图的玩家消息 id，沿玩家计划路线执行；to 指定目的地，由平台绕开墙与关闭的门寻路。两者只能提供一个。until 限制本次移动的距离，用于受阻、被打断或分段移动。路线遇到墙或关闭的门时停在阻挡前并返回 stoppedBy；需要通过时先用 map_update 开门。返回新位置、所在区域、实际移动与剩余距离、新进入队伍视野的标记。先按规则裁定行动结果再移动，成功后才叙述到达；沿已配对出入口换图使用 map_update traverse；主持修正位置使用 place。",
      parameters: Type.Object({
        token: Type.Optional(Type.String({ description: "标记 id；使用 intent 时可省略" })),
        intent: Type.Optional(Type.String({ description: "携带移动意图的消息 id" })),
        to: Type.Optional(anchor),
        until: Type.Optional(Type.Number({ description: "本次最多移动的距离" })),
      }),
      execute: async (_id, params) => {
        signal.throwIfAborted();
        return output(await withDatabase((db) => moveToken(db, params, signal)));
      },
    },
    {
      name: "map_update",
      label: "更新地图",
      executionMode: "sequential",
      description:
        "维护地图状态。traverse 用于主持确认一批标记通过一个出入口。先 map_read 查看 exits，再传当前 map、出发起点 from、目标地图 target、抵达起点 to 和实际通过的 tokens。平台检查到出发口的路线，任一标记无法通过则整组留在原图。place 放置或瞬移标记（可跨地图）：document 为角色或其他游戏文档，同一文档未指定 token 时移动已有标记，需要多个副本时指定新的 token；纯物件用 label。队伍角色放入地图后玩家即可看到该地图。remove 移除标记；set 修改标记属性；door 开关门，打开秘门同时揭示；reveal/conceal 揭示或重新隐藏秘门；known 设置地图是否对玩家可见。玩家看到的地图只包含队伍视野、已探索区域和视野内未隐藏的标记。地图与模组位置字段互不同步，需要时另行更新文档。",
      parameters: Type.Union([
        Type.Object({
          action: Type.Literal("place"),
          map: Type.String(),
          at: anchor,
          token: Type.Optional(Type.String()),
          document: Type.Optional(Type.String({ description: "游戏文档路径" })),
          ...flags,
        }),
        Type.Object({
          action: Type.Literal("traverse"),
          map: Type.String(),
          from: Type.String(),
          target: Type.String(),
          to: Type.String(),
          tokens: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
        }),
        Type.Object({ action: Type.Literal("remove"), token: Type.String() }),
        Type.Object({ action: Type.Literal("set"), token: Type.String(), ...flags }),
        Type.Object({
          action: Type.Literal("door"),
          map: Type.String(),
          door: Type.String(),
          open: Type.Boolean(),
        }),
        Type.Object({ action: Type.Literal("reveal"), map: Type.String(), door: Type.String() }),
        Type.Object({ action: Type.Literal("conceal"), map: Type.String(), door: Type.String() }),
        Type.Object({ action: Type.Literal("known"), map: Type.String(), known: Type.Boolean() }),
      ]),
      execute: async (_id, params) => {
        signal.throwIfAborted();
        return output(await withDatabase((db) => updateMap(db, params, signal)));
      },
    },
  ];
}
