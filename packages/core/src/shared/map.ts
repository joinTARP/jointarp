import type { MapGrid, MapPoint } from "@jointarp/module/map";
import { mapPointSchema } from "@jointarp/module/map";
import { z } from "zod";

/** 玩家随行动消息提交的移动意图；起点由主机在接收时按标记当前位置记录。 */
export const movementIntentInputSchema = z.strictObject({
  token: z.string().trim().min(1).max(200),
  map: z.string().trim().min(1).max(200),
  waypoints: z.array(mapPointSchema).min(1).max(50),
});
export type MovementIntentInput = z.infer<typeof movementIntentInputSchema>;

export const movementIntentSchema = movementIntentInputSchema.extend({
  from: mapPointSchema,
  /** 已知区域内的预估距离；终点位于未探索区域时只表示方向，不给距离。 */
  length: z.number().nonnegative().nullable(),
  unit: z.string().min(1),
  explore: z.boolean(),
});
export type MovementIntent = z.infer<typeof movementIntentSchema>;

/** 玩家可见的地图静态资料；不含标记初始位置、起点、区域及未揭示的秘门。 */
export interface MapResource {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly image: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly grid: MapGrid;
  readonly walls: readonly (readonly MapPoint[])[];
}

export interface MapTokenView {
  readonly id: string;
  readonly document?: string;
  readonly label?: string;
  readonly at: MapPoint;
  readonly size: number;
  readonly party: boolean;
  /** 控制该角色的玩家或队友身份。 */
  readonly playerId?: string;
}

export interface MapDoorView {
  readonly id: string;
  readonly from: MapPoint;
  readonly to: MapPoint;
  readonly open: boolean;
}

export interface MapView {
  readonly parent?: string;
  readonly id: string;
  /** 已探索格子的位图，按 explorationGrid 排列并以 Base64 编码。 */
  readonly explored: string;
  /** 队伍当前可见范围，每名队伍角色一个多边形。 */
  readonly visible: readonly (readonly MapPoint[])[];
  readonly doors: readonly MapDoorView[];
  /** 尚未揭示的秘门，以不带标识的墙段出现。 */
  readonly barriers: readonly (readonly [MapPoint, MapPoint])[];
  readonly tokens: readonly MapTokenView[];
}

/** 按全队视野投影的地图区段；只包含队伍已知的地图。 */
export interface MapSection {
  readonly maps: readonly MapView[];
  /** 主持已按意图执行的距离，键为携带意图的消息。 */
  readonly intents: Readonly<Record<string, number>>;
}
