import { z } from "zod";

import { documentIdentity } from "./document-path";

/** 地图坐标使用底图像素，原点在左上角。 */
export const mapPointSchema = z.tuple([z.number().finite(), z.number().finite()]);
export type MapPoint = z.infer<typeof mapPointSchema>;

const mapIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\s/\\#?]+$/u, "标识不能包含空白、斜杠、# 或 ?");

const squareGridSchema = z
  .object({
    type: z.literal("square"),
    /** 每格的像素边长。 */
    size: z.number().positive(),
    /** 每格代表的距离。 */
    distance: z.number().positive(),
    unit: z.string().trim().min(1).max(16),
    /** equal：斜向一格按一格计；alternate：斜向交替按一格、两格计；euclidean：按直线距离。 */
    diagonal: z.enum(["equal", "alternate", "euclidean"]).default("equal"),
    offset: mapPointSchema.default([0, 0]),
  })
  .strict();

const gridlessSchema = z
  .object({
    type: z.literal("none"),
    /** 每个距离单位的像素数。 */
    pixelsPerUnit: z.number().positive(),
    unit: z.string().trim().min(1).max(16),
  })
  .strict();

export const mapGridSchema = z.discriminatedUnion("type", [squareGridSchema, gridlessSchema]);
export type MapGrid = z.infer<typeof mapGridSchema>;

const wallSchema = z
  .object({
    points: z.array(mapPointSchema).min(2),
  })
  .strict();

const doorSchema = z
  .object({
    id: mapIdSchema,
    from: mapPointSchema,
    to: mapPointSchema,
    open: z.boolean().default(false),
    /** 秘门在主持揭示前对玩家按墙处理。 */
    secret: z.boolean().default(false),
  })
  .strict();

/** 命名区域为主持提供空间语义；幕后区域只向主持描述。 */
const regionSchema = z
  .object({
    id: mapIdSchema,
    name: z.string().trim().min(1).max(40).optional(),
    points: z.array(mapPointSchema).min(3),
    document: z.string().trim().min(1).transform(documentIdentity).optional(),
    secret: z.boolean().default(false),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const mapStartSchema = z
  .object({
    id: mapIdSchema,
    name: z.string().trim().min(1).max(40),
    at: mapPointSchema,
  })
  .strict();

export const mapConnectionSchema = z.strictObject({
  from: mapIdSchema,
  map: z.string().min(1),
  to: mapIdSchema,
  oneWay: z.boolean().default(false),
});
export type MapConnection = z.infer<typeof mapConnectionSchema>;

const tokenSchema = z
  .object({
    id: mapIdSchema,
    /** 关联已有资料时复用名称与头像；不关联时为简单物件标记。 */
    document: z.string().trim().min(1).transform(documentIdentity).optional(),
    label: z.string().trim().min(1).max(40).optional(),
    at: mapPointSchema,
    /** 占地边长，按格数（无网格时按距离单位）计。 */
    size: z.number().positive().max(20).default(1),
    hidden: z.boolean().default(false),
    /** 明确设置后才遮挡视线。 */
    blocksVision: z.boolean().default(false),
    /** 只用于规划提示与主持提醒，不强制拒绝移动。 */
    blocksMovement: z.boolean().default(false),
  })
  .strict()
  .refine((token) => Boolean(token.document || token.label), {
    message: "标记需要关联资料 document 或填写 label",
  });

export const mapConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(1000).optional(),
    parent: z.string().min(1).optional(),
    /** 模组内图片路径。 */
    image: z.string().trim().min(1),
    width: z.number().int().positive().max(20000),
    height: z.number().int().positive().max(20000),
    grid: mapGridSchema,
    /** 角色默认视距，按距离单位计；省略时不限距离，只受墙和门遮挡。 */
    vision: z.number().positive().optional(),
    walls: z.array(wallSchema).max(5000).default([]),
    doors: z.array(doorSchema).max(1000).default([]),
    regions: z.array(regionSchema).max(500).default([]),
    connections: z.array(mapConnectionSchema).max(500).default([]),
    starts: z.array(mapStartSchema).max(100).default([]),
    tokens: z.array(tokenSchema).max(1000).default([]),
  })
  .strict()
  .superRefine((map, context) => {
    const inside = (point: MapPoint, path: (string | number)[]) => {
      if (point[0] < 0 || point[1] < 0 || point[0] > map.width || point[1] > map.height)
        context.addIssue({ code: "custom", path, message: "坐标超出底图范围" });
    };
    map.walls.forEach((wall, index) =>
      wall.points.forEach((point, pointIndex) =>
        inside(point, ["walls", index, "points", pointIndex]),
      ),
    );
    const ids = new Set<string>();
    const unique = (id: string, path: (string | number)[]) => {
      if (ids.has(id)) context.addIssue({ code: "custom", path, message: `标识重复：${id}` });
      ids.add(id);
    };
    map.doors.forEach((door, index) => {
      unique(door.id, ["doors", index, "id"]);
      inside(door.from, ["doors", index, "from"]);
      inside(door.to, ["doors", index, "to"]);
    });
    map.regions.forEach((region, index) => {
      unique(region.id, ["regions", index, "id"]);
      region.points.forEach((point, pointIndex) =>
        inside(point, ["regions", index, "points", pointIndex]),
      );
    });
    map.starts.forEach((start, index) => {
      unique(start.id, ["starts", index, "id"]);
      inside(start.at, ["starts", index, "at"]);
    });
    const routes = new Set<string>();
    map.connections.forEach((link, index) => {
      const key = JSON.stringify([link.from, link.map, link.to]);
      if (routes.has(key))
        context.addIssue({
          code: "custom",
          path: ["connections", index],
          message: "出入口连接重复",
        });
      routes.add(key);
      if (!map.starts.some((start) => start.id === link.from))
        context.addIssue({
          code: "custom",
          path: ["connections", index, "from"],
          message: "出发起点不存在",
        });
    });
    map.tokens.forEach((token, index) => {
      unique(token.id, ["tokens", index, "id"]);
      inside(token.at, ["tokens", index, "at"]);
    });
  });

export type MapConfig = z.infer<typeof mapConfigSchema>;
export type MapDoorConfig = MapConfig["doors"][number];
export type MapTokenConfig = MapConfig["tokens"][number];
export type MapRegionConfig = MapConfig["regions"][number];

/** 模组 maps/ 目录中的一张地图；id 为去掉 maps/ 前缀与扩展名的相对路径。 */
export interface ModuleMap {
  readonly id: string;
  readonly path: string;
  readonly config: MapConfig;
}

export const mapDirectory = "maps";

/** 从当前地图向上遍历到根；查找函数对不存在的地图报错。 */
export function mapLineage(id: string, parentOf: (id: string) => string | undefined) {
  const chain = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined) {
    if (chain.has(current)) throw new Error(`上级地图形成循环：${[...chain, current].join(" → ")}`);
    chain.add(current);
    current = parentOf(current);
  }
  return [...chain].reverse();
}

export function validateMapDestination(source: string, link: MapConnection, target?: MapConfig) {
  if (source === link.map) throw new Error("跨图连接的两端必须在不同地图");
  if (!target?.starts.some((start) => start.id === link.to))
    throw new Error(`找不到目标地图或起点：${link.map} / ${link.to}`);
}

/** 双向连接只需在一端配置。 */
export function exitsFrom(maps: readonly ModuleMap[], id: string) {
  return maps.flatMap((owner) =>
    (owner.config.connections ?? []).flatMap((link) => {
      if (owner.id === id) return [{ from: link.from, map: link.map, to: link.to }];
      if (link.map === id && !link.oneWay) return [{ from: link.to, map: owner.id, to: link.from }];
      return [];
    }),
  );
}
