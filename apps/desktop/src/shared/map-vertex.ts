import {
  mapConnectionSchema,
  mapStartSchema,
  mapPointSchema,
  type MapConfig,
} from "@jointarp/module/map";
import { z } from "zod";

export const vertexEditSchema = z.strictObject({
  layer: z.enum(["walls", "doors"]),
  index: z.number().int().nonnegative(),
  vertex: z.number().int().nonnegative(),
  at: mapPointSchema,
});
export type VertexEdit = z.infer<typeof vertexEditSchema>;

export function editPoint(map: MapConfig, edit: VertexEdit) {
  const point =
    edit.layer === "walls"
      ? map.walls[edit.index]?.points[edit.vertex]
      : edit.vertex === 0
        ? map.doors[edit.index]?.from
        : edit.vertex === 1
          ? map.doors[edit.index]?.to
          : undefined;
  if (!point) throw new Error("找不到所选顶点");
  return point;
}

export const mapEditSchema = z.union([
  vertexEditSchema,
  z.strictObject({ kind: z.literal("start"), start: mapStartSchema }),
  z.strictObject({ kind: z.literal("connect"), link: mapConnectionSchema }),
  z.strictObject({ kind: z.literal("disconnect"), index: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal("parent"), parent: z.string().min(1).nullable() }),
  z.strictObject({ kind: z.literal("wall"), points: z.array(mapPointSchema).min(2) }),
  z.strictObject({
    kind: z.literal("delete"),
    layer: z.enum(["walls", "doors"]),
    index: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("door"),
    wall: z.number().int().nonnegative(),
    segment: z.number().int().nonnegative(),
    start: z.number().min(0).max(1),
    end: z.number().min(0).max(1),
  }),
]);
export type MapEdit = z.infer<typeof mapEditSchema>;

export function applyMapEdit(map: MapConfig, edit: MapEdit): MapConfig {
  if ("kind" in edit && edit.kind === "parent") {
    const next = { ...map };
    if (edit.parent === null) delete next.parent;
    else next.parent = edit.parent;
    return next;
  }
  if ("kind" in edit) {
    if (edit.kind === "start") return { ...map, starts: [...map.starts, edit.start] };
    if (edit.kind === "connect") return { ...map, connections: [...map.connections, edit.link] };
    if (edit.kind === "disconnect")
      return { ...map, connections: map.connections.filter((_, i) => i !== edit.index) };
  }
  const walls = [...map.walls],
    doors = [...map.doors];
  if (!("kind" in edit)) {
    editPoint(map, edit);
    if (edit.layer === "walls") {
      const points = [...walls[edit.index].points];
      points[edit.vertex] = edit.at;
      walls[edit.index] = { points };
    } else
      doors[edit.index] = { ...doors[edit.index], [edit.vertex === 0 ? "from" : "to"]: edit.at };
  } else if (edit.kind === "wall") {
    walls.push({ points: edit.points });
  } else if (edit.kind === "delete") {
    const items = edit.layer === "walls" ? walls : doors;
    if (!items[edit.index]) throw Error("找不到要删除的对象");
    items.splice(edit.index, 1);
  } else {
    const points = walls[edit.wall]?.points;
    const a = points?.[edit.segment],
      b = points?.[edit.segment + 1];
    if (!a || !b || edit.end <= edit.start || (a[0] === b[0] && a[1] === b[1]))
      throw Error("门洞需要同一墙段上两个不同的位置");
    const along = (t: number): [number, number] => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
    ];
    const from = along(edit.start),
      to = along(edit.end);
    const before = points.slice(0, edit.segment + 1),
      after = points.slice(edit.segment + 1);
    if (edit.start > 0) before.push(from);
    if (edit.end < 1) after.unshift(to);
    walls.splice(
      edit.wall,
      1,
      ...[before, after].filter((p) => p.length >= 2).map((points) => ({ points })),
    );
    const ids = new Set([...doors, ...map.regions, ...map.tokens, ...map.starts].map((o) => o.id));
    let n = 1;
    while (ids.has("门-" + n)) n++;
    doors.push({ id: "门-" + n, from, to, open: false, secret: false });
  }
  return { ...map, walls, doors };
}
