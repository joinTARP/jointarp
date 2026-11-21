import { mapLineage } from "@jointarp/module/map";
import type { MapConfig, MapPoint, ModuleMap } from "@jointarp/module/map";
import { applyMapEdit, type MapEdit, type VertexEdit } from "@shared/map-vertex";
import { useQuery } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import {
  Check,
  DoorOpen,
  Layers,
  Link2,
  MousePointer2,
  Pencil,
  Save,
  Scan,
  Spline,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { useDocumentImage } from "./document-image";
import { previewSight } from "./map-inspector-sight";
import { MapConnections } from "./MapConnections";

const emptyMaps: readonly ModuleMap[] = [];

export function MapInspector({ path }: { path: string }) {
  const query = useQuery(desktopOrpc.modules.maps.queryOptions({ input: { path } }));
  const [lastMap, setLastMap] = useState<ModuleMap>();
  const maps = query.data?.maps ?? emptyMaps;
  const hierarchy = useMemo(() => {
    const byId = new Map(maps.map((map) => [map.id, map]));
    return maps
      .map((map) => {
        let chain: string[] = [];
        try {
          chain = mapLineage(map.id, (id) => {
            const entry = byId.get(id);
            if (!entry) throw new Error("上级地图缺失");
            return entry.config.parent;
          });
        } catch {
          /* 配置错误由查询结果展示，仍可选中地图修复。 */
        }
        const label = chain.length
          ? chain.map((id) => byId.get(id)!.config.name).join(" › ")
          : map.config.name;
        return { id: map.id, chain, label };
      })
      .sort((a, b) => a.label.localeCompare(b.label, "zh"));
  }, [maps]);
  const current = maps.find((map) => map.id === lastMap?.id);
  const stale =
    !!lastMap && !current && !!query.data?.issues.some((issue) => issue.path === lastMap.path);
  const [pinned, setPinned] = useState<ModuleMap>();
  const selected = pinned ?? current ?? (stale ? lastMap : maps[0]);
  useEffect(() => {
    if (selected) setLastMap(selected);
  }, [selected]);
  return (
    <>
      <PageToolbarHeader
        title="地图校对"
        description="校对视野、绘制墙门与连接地图"
        widthClassName="max-w-6xl"
      />
      <section className="mx-auto max-w-6xl space-y-3 px-4 py-4 sm:px-7">
        <div className="flex flex-wrap items-center gap-3">
          {selected && (
            <select
              aria-label="选择地图"
              className="bg-background max-w-full min-w-0 rounded-lg border px-3 py-1.5 text-sm"
              disabled={!!pinned}
              value={selected.id}
              onChange={(e) => setLastMap(maps.find((map) => map.id === e.target.value))}
            >
              {stale && <option value={selected.id}>{selected.config.name}（上次有效配置）</option>}
              {hierarchy.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.label} · {map.id}
                </option>
              ))}
            </select>
          )}
          <Button
            variant="outline"
            disabled={query.isFetching || !!pinned}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "读取中…" : "重新加载"}
          </Button>
        </div>
        {query.error && <p role="alert">{query.error.message}</p>}
        {query.data?.issues.map((issue) => (
          <p role="alert" key={issue.path}>
            {issue.path} · {issue.message}
          </p>
        ))}
        {(stale || (query.error && selected)) && (
          <p role="status">读取失败，画布保留上次有效配置。修正文件后可重新加载。</p>
        )}
        {query.data && !selected && <p>模组的 maps 目录中没有可预览的地图。</p>}
        {selected && (
          <MapSheet
            key={selected.id}
            maps={maps}
            hierarchy={hierarchy}
            map={selected}
            version={query.dataUpdatedAt}
            root={path}
            canEdit={!stale && !query.error}
            pin={setPinned}
            reload={() => query.refetch()}
          />
        )}
      </section>
    </>
  );
}

const layers = { walls: "墙线", doors: "门", regions: "区域", starts: "起点", sight: "视野" };
type Layer = keyof typeof layers;

function MapSheet({
  map,
  hierarchy,
  maps,
  version,
  root,
  canEdit,
  pin,
  reload,
}: {
  map: ModuleMap;
  maps: readonly ModuleMap[];
  hierarchy: readonly { id: string; chain: string[]; label: string }[];
  version: number;
  root: string;
  canEdit: boolean;
  pin: (map: ModuleMap | undefined) => void;
  reload: () => Promise<unknown>;
}) {
  const { path } = map;
  const [session, setSession] = useState<{ config: MapConfig; revision: string }>();
  const [edits, setEdits] = useState<MapEdit[]>([]);
  const [moving, setMoving] = useState<VertexEdit>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [discard, setDiscard] = useState(false);
  const [tool, setTool] = useState<"select" | "wall" | "door">("select");
  const [relationships, setRelationships] = useState(false);
  const [hover, setHover] = useState<MapPoint>();
  const [line, setLine] = useState<MapPoint[]>([]);
  const [first, setFirst] = useState<{
    wall: number;
    segment: number;
    t: number;
    point: MapPoint;
  }>();
  useBlocker({
    disabled: !edits.length && !busy && !line.length && !first,
    enableBeforeUnload: true,
    shouldBlockFn: () => {
      setMessage("请先保存或放弃当前编辑。");
      return true;
    },
  });
  const m = useMemo(() => {
    if (!session) return map.config;
    return (moving ? [...edits, moving] : edits).reduce(applyMapEdit, session.config);
  }, [map.config, session, edits, moving]);
  function selectTool(value: typeof tool) {
    setTool(value);
    setHover(undefined);
    setLine([]);
    setFirst(undefined);
    setMessage("");
    setDiscard(false);
  }
  function commit(edit: MapEdit) {
    setEdits((prev) => [...prev, edit]);
    setDiscard(false);
    setObjectKey("");
    selectTool("select");
  }
  const finish = () => {
    setRelationships(false);
    selectTool("select");
    setSession(undefined);
    setEdits([]);
    setMoving(undefined);
    setDiscard(false);
    pin(undefined);
  };
  const file = { path: root, file: path };
  async function begin() {
    setBusy(true);
    pin(map);
    setMessage("");
    try {
      setSession(await desktopRpc.modules.openMapEdit(file));
    } catch (error) {
      setMessage(String(error));
      pin(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!session) return;
    setBusy(true);
    try {
      await desktopRpc.modules.saveMapEdit({ ...file, revision: session.revision, edits });
      await reload();
      finish();
      setMessage("地图已保存");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const [visible, setVisible] = useState<Record<Layer, boolean>>({
    walls: true,
    doors: true,
    regions: true,
    starts: true,
    sight: true,
  });
  const [at, setAt] = useState<MapPoint>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{
    x: number;
    y: number;
    camera: typeof camera;
    moved: boolean;
    id: number;
    handle?: VertexEdit;
  } | null>(null);
  const [objectKey, setObjectKey] = useState("");
  const zoomAt = (scale: number, anchor: MapPoint) =>
    setCamera((prev) => {
      const next = Math.max(1, Math.min(12, scale));
      return {
        scale: next,
        x: anchor[0] - ((anchor[0] - prev.x) * prev.scale) / next,
        y: anchor[1] - ((anchor[1] - prev.y) * prev.scale) / next,
      };
    });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (e: WheelEvent) => {
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      e.preventDefault();
      const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
      zoomAt(camera.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), [pt.x, pt.y]);
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, [camera.scale]);
  const objects = useMemo(
    () => [
      ...m.walls.map((w, i) => ({
        key: `walls[${i}]`,
        name: `墙线 ${i + 1}`,
        points: w.points,
        layer: "walls" as const,
      })),
      ...m.doors.map((d, i) => ({
        key: `doors[${i}]`,
        name: d.id,
        points: [d.from, d.to],
        layer: "doors" as const,
      })),
      ...m.starts.map((s, i) => ({
        key: `starts[${i}]`,
        name: s.name,
        points: [s.at],
        layer: "starts" as const,
      })),
      ...m.regions.map((r, i) => ({
        key: `regions[${i}]`,
        name: r.name ?? r.id,
        points: r.points,
        layer: "regions" as const,
      })),
    ],
    [m],
  );
  const object = objects.find((o) => o.key === objectKey && visible[o.layer]);
  const [copy, setCopy] = useState("");
  const [failed, setFailed] = useState("");
  const localImage = !/^(?:[a-z]+:|[/\\])/i.test(m.image) && !m.image.split(/[/\\]/).includes("..");
  const src = useDocumentImage("", localImage ? m.image : undefined);
  const href = src && src + "&revision=" + version;
  const point =
    at && at[0] >= 0 && at[1] >= 0 && at[0] <= m.width && at[1] <= m.height ? at : undefined;
  const sight = useMemo(
    () => (point && visible.sight ? previewSight(m, point) : []),
    [m, point, visible.sight],
  );
  const draft = line.length > 0 || !!first;
  const dirty = edits.length > 0 || draft;
  const canSave = !!session && !!edits.length && !draft && !moving && !busy;
  function undo() {
    if (line.length) return setLine(line.slice(0, -1));
    if (first) return setFirst(undefined);
    if (!edits.length) return;
    selectTool("select");
    setObjectKey("");
    setEdits(edits.slice(0, -1));
  }
  function chooseTool(value: typeof tool) {
    setRelationships(false);
    selectTool(value);
    if (value === "wall") setVisible((v) => ({ ...v, walls: true }));
    if (value === "door") setVisible((v) => ({ ...v, walls: true, doors: true }));
    svgRef.current?.focus({ preventScroll: true });
  }
  const hint =
    tool === "wall"
      ? line.length
        ? `已标记 ${line.length} 个墙角，再点下一处墙角或完成墙线。`
        : "点击第一个墙角开始绘制。"
      : tool === "door"
        ? first
          ? "在同一墙段点另一端，确定门洞宽度。"
          : "在已有墙线上点击门洞的第一端。"
        : relationships
          ? "点击底图选取起点位置，已有起点可直接配对。"
          : session
            ? "点击墙线或门可选中，拖动白色顶点调整形状。"
            : "点击底图查看坐标与视野，拖动画布平移。";
  return (
    <section
      aria-label="地图工作区"
      className="bg-background @container overflow-hidden rounded-xl border text-sm"
      onKeyDown={(e) => {
        if (!session || busy || e.nativeEvent.isComposing) return;
        const target = e.target as HTMLElement;
        if (target.closest("input, select, textarea, [contenteditable=true]")) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (canSave) void save();
        } else if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          undo();
        } else if (e.key === "Escape" && tool !== "select") {
          e.preventDefault();
          chooseTool("select");
        } else if (
          e.key === "Enter" &&
          e.target === svgRef.current &&
          tool === "wall" &&
          line.length >= 2
        ) {
          e.preventDefault();
          commit({ kind: "wall", points: line });
        }
      }}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <strong className="mr-auto truncate">{m.name}</strong>
        {session ? (
          <>
            <span role="status" className="text-muted-foreground text-xs">
              {busy ? "正在保存…" : dirty ? "有未保存更改" : "已保存"}
            </span>
            <Button size="sm" variant="ghost" disabled={busy || !dirty} onClick={undo}>
              <Undo2 />
              撤销
            </Button>
            <Button size="sm" disabled={!canSave} onClick={() => void save()}>
              <Save />
              保存地图
            </Button>
            <Button
              size="sm"
              variant={discard ? "destructive" : "ghost"}
              disabled={busy}
              onClick={() => {
                if (dirty && !discard) {
                  setDiscard(true);
                  return;
                }
                finish();
                setMessage("");
                void reload();
              }}
            >
              {discard ? "确认放弃更改" : "退出编辑"}
            </Button>
            {discard && (
              <Button size="sm" variant="outline" onClick={() => setDiscard(false)}>
                继续编辑
              </Button>
            )}
          </>
        ) : (
          <Button size="sm" disabled={busy || !canEdit} onClick={() => void begin()}>
            <Pencil />
            编辑地图
          </Button>
        )}
      </header>
      {session && (
        <div
          className="flex flex-wrap items-center gap-1 border-b p-2"
          role="group"
          aria-label="编辑工具"
        >
          {(
            [
              { value: "select", label: "选择", Icon: MousePointer2 },
              { value: "wall", label: "画墙", Icon: Spline },
              { value: "door", label: "开门洞", Icon: DoorOpen },
            ] as const
          ).map(({ value, label, Icon }) => (
            <Button
              size="sm"
              key={value}
              variant={!relationships && tool === value ? "secondary" : "ghost"}
              aria-pressed={!relationships && tool === value}
              disabled={busy || draft || (value === "door" && !m.walls.length)}
              onClick={() => chooseTool(value)}
            >
              <Icon />
              {label}
            </Button>
          ))}
          <Button
            size="sm"
            variant={relationships ? "secondary" : "ghost"}
            aria-pressed={relationships}
            disabled={busy || draft}
            onClick={() => {
              chooseTool("select");
              setRelationships(true);
            }}
          >
            <Link2 />
            地图关系
          </Button>
          {tool === "wall" && (
            <Button
              size="sm"
              disabled={busy || line.length < 2}
              onClick={() => commit({ kind: "wall", points: line })}
            >
              <Check />
              完成墙线
            </Button>
          )}
          {tool !== "select" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => chooseTool("select")}>
              <X />
              取消绘制
            </Button>
          )}
        </div>
      )}
      <div className="bg-muted/30 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
        <p aria-live="polite" className="text-xs">
          {message || hint}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              zoomAt(camera.scale / 1.5, [
                camera.x + m.width / 2 / camera.scale,
                camera.y + m.height / 2 / camera.scale,
              ])
            }
            disabled={camera.scale <= 1}
            aria-label="缩小"
          >
            −
          </Button>
          <span className="min-w-10 text-center font-mono text-xs tabular-nums">
            {Math.round(camera.scale * 100)}%
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              zoomAt(camera.scale * 1.5, [
                camera.x + m.width / 2 / camera.scale,
                camera.y + m.height / 2 / camera.scale,
              ])
            }
            disabled={camera.scale >= 12}
            aria-label="放大"
          >
            ＋
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}>
            <Scan />
            适应全图
          </Button>
        </div>
      </div>
      <div className="grid items-start @min-[48rem]:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          {(!href || failed === href) && <p role="alert">无法载入底图 · {m.image}</p>}
          <div className="overflow-hidden bg-neutral-900">
            <svg
              ref={svgRef}
              tabIndex={0}
              onPointerLeave={() => setHover(undefined)}
              viewBox={`${camera.x} ${camera.y} ${m.width / camera.scale} ${m.height / camera.scale}`}
              aria-label="地图校对画布"
              className="block h-[55vh] w-full cursor-crosshair touch-none"
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return;
                e.currentTarget.focus({ preventScroll: true });
                const vertex = (e.target as Element).getAttribute("data-vertex");
                const handle =
                  session &&
                  !busy &&
                  tool === "select" &&
                  vertex !== null &&
                  object &&
                  (object.layer === "walls" || object.layer === "doors")
                    ? {
                        layer: object.layer,
                        index: Number(object.key.match(/\d+/)![0]),
                        vertex: Number(vertex),
                        at: object.points[Number(vertex)],
                      }
                    : undefined;
                drag.current = {
                  handle,
                  x: e.clientX,
                  y: e.clientY,
                  camera,
                  moved: false,
                  id: e.pointerId,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const start = drag.current,
                  matrix = e.currentTarget.getScreenCTM();
                if (!start && tool === "wall" && line.length && matrix) {
                  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
                  setHover(
                    p.x >= 0 && p.y >= 0 && p.x <= m.width && p.y <= m.height
                      ? [p.x, p.y]
                      : undefined,
                  );
                }
                if (!start || start.id !== e.pointerId || !matrix) return;
                const dx = e.clientX - start.x,
                  dy = e.clientY - start.y;
                if (!start.moved && Math.hypot(dx, dy) < 4) return;
                start.moved = true;
                if (start.handle) {
                  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
                  setMoving({
                    ...start.handle,
                    at: [
                      Math.max(0, Math.min(m.width, Math.round(pt.x))),
                      Math.max(0, Math.min(m.height, Math.round(pt.y))),
                    ],
                  });
                  return;
                }
                setCamera({
                  ...start.camera,
                  x: start.camera.x - dx / matrix.a,
                  y: start.camera.y - dy / matrix.d,
                });
              }}
              onLostPointerCapture={() => {
                drag.current = null;
                setMoving(undefined);
              }}
              onPointerUp={(e) => {
                const start = drag.current,
                  matrix = e.currentTarget.getScreenCTM();
                if (!start || start.id !== e.pointerId || !matrix) return;
                if (start.handle) {
                  if (start.moved) {
                    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
                    const at: MapPoint = [
                      Math.max(0, Math.min(m.width, Math.round(pt.x))),
                      Math.max(0, Math.min(m.height, Math.round(pt.y))),
                    ];
                    if (at.some((v, i) => v !== start.handle!.at[i]))
                      setEdits((prev) => [...prev, { ...start.handle!, at }]);
                    setDiscard(false);
                  }
                  setMoving(undefined);
                  return;
                }
                if (start.moved) return;
                const pos = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
                if (pos.x < 0 || pos.y < 0 || pos.x > m.width || pos.y > m.height) return;
                if (busy) return;
                if (tool === "wall") {
                  const p: MapPoint = [Math.round(pos.x), Math.round(pos.y)];
                  if (!line.length || line.at(-1)!.some((v, i) => v !== p[i]))
                    setLine([...line, p]);
                  return;
                }
                if (tool === "door") {
                  let best: typeof first,
                    nearest = 12 / matrix.a;
                  for (const [wall, w] of m.walls.entries())
                    for (let segment = 0; segment < w.points.length - 1; segment++) {
                      if (first && (wall !== first.wall || segment !== first.segment)) continue;
                      const [a, b] = w.points.slice(segment, segment + 2),
                        dx = b[0] - a[0],
                        dy = b[1] - a[1];
                      if (!dx && !dy) continue;
                      const t = Math.min(
                        1,
                        Math.max(
                          0,
                          ((pos.x - a[0]) * dx + (pos.y - a[1]) * dy) / (dx * dx + dy * dy),
                        ),
                      );
                      const point: MapPoint = [a[0] + t * dx, a[1] + t * dy],
                        d = Math.hypot(pos.x - point[0], pos.y - point[1]);
                      if (d <= nearest) {
                        nearest = d;
                        best = { wall, segment, t, point };
                      }
                    }
                  if (!best) {
                    setMessage("请点击同一墙段上的位置");
                    return;
                  }
                  if (!first) {
                    setFirst(best);
                    setMessage("");
                    return;
                  }
                  if (
                    Math.hypot(best.point[0] - first.point[0], best.point[1] - first.point[1]) < 1
                  ) {
                    setMessage("门洞两端至少相距一个像素");
                    return;
                  }
                  commit({
                    kind: "door",
                    wall: first.wall,
                    segment: first.segment,
                    start: Math.min(first.t, best.t),
                    end: Math.max(first.t, best.t),
                  });
                  return;
                }
                setObjectKey(
                  document
                    .elementFromPoint(e.clientX, e.clientY)
                    ?.closest("[data-object]")
                    ?.getAttribute("data-object") ?? "",
                );
                setAt([Math.round(pos.x), Math.round(pos.y)]);
                setCopy("");
              }}
            >
              {href && (
                <image
                  href={href}
                  width={m.width}
                  height={m.height}
                  preserveAspectRatio="none"
                  onError={() => setFailed(href)}
                />
              )}
              {sight.length > 0 && (
                <polygon points={sight.join(" ")} fill="#a3e635" fillOpacity=".32" />
              )}
              {visible.regions &&
                m.regions.map((r, i) => (
                  <polygon
                    data-object={`regions[${i}]`}
                    key={r.id}
                    points={r.points.join(" ")}
                    fill="#38bdf833"
                    stroke="#38bdf8"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{r.name ?? r.id}</title>
                  </polygon>
                ))}
              {visible.walls &&
                m.walls.map((w, i) => (
                  <g key={i} data-object={`walls[${i}]`}>
                    <polyline
                      points={w.points.join(" ")}
                      fill="none"
                      stroke="transparent"
                      strokeWidth="12"
                      vectorEffect="non-scaling-stroke"
                    />
                    <polyline
                      points={w.points.join(" ")}
                      fill="none"
                      stroke="#f8fafc"
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                ))}
              {visible.doors &&
                m.doors.map((d, i) => (
                  <line
                    data-object={`doors[${i}]`}
                    key={d.id}
                    x1={d.from[0]}
                    y1={d.from[1]}
                    x2={d.to[0]}
                    y2={d.to[1]}
                    stroke="#f59e0b"
                    strokeWidth="5"
                    strokeDasharray={d.open ? "6 4" : undefined}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>
                      {d.id} · {d.open ? "开启" : "关闭"}
                      {d.secret ? " · 秘门" : ""}
                    </title>
                  </line>
                ))}
              {visible.starts &&
                m.starts.map((s, i) => (
                  <circle
                    data-object={`starts[${i}]`}
                    key={s.id}
                    cx={s.at[0]}
                    cy={s.at[1]}
                    r={m.width / 180}
                    fill="#2dd4bf"
                    stroke="#111"
                  >
                    <title>{s.name}</title>
                  </circle>
                ))}
              {object &&
                object.points.map(([x, y], i) => (
                  <circle
                    key={i}
                    cx={x}
                    cy={y}
                    r={m.width / 200 / camera.scale}
                    fill="#fff"
                    stroke="#0891b2"
                    data-vertex={i}
                    className={session ? "cursor-move" : undefined}
                    pointerEvents={
                      session && !busy && (object.layer === "walls" || object.layer === "doors")
                        ? "all"
                        : "none"
                    }
                  />
                ))}
              {hover && line.length > 0 && (
                <polyline
                  points={[line[line.length - 1], hover].join(" ")}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="2"
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              {line.length > 0 && (
                <polyline
                  points={line.join(" ")}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth="3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {(first ? [first.point] : line).map(([x, y], i) => (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={m.width / 180 / camera.scale}
                  fill="#22d3ee"
                  pointerEvents="none"
                />
              ))}
              {point && (
                <circle
                  pointerEvents="none"
                  cx={point[0]}
                  cy={point[1]}
                  r={m.width / 240}
                  fill="#fff"
                  stroke="#111"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
            <span className="mr-auto">
              {tool === "wall" ? "Enter 完成墙线 · Esc 取消" : "滚轮缩放 · 拖动平移"}
            </span>
            {point ? (
              <>
                <code>[{point.join(", ")}]</code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(JSON.stringify(point));
                      setCopy("已复制");
                    } catch {
                      setCopy("请选中坐标复制");
                    }
                  }}
                >
                  复制坐标
                </Button>
                <span role="status">{copy}</span>
              </>
            ) : (
              <span>点击底图拾取像素坐标并预览视野</span>
            )}
          </div>
        </div>
        <aside
          aria-label="地图属性"
          className="min-w-0 space-y-4 border-t p-3 @min-[48rem]:border-t-0 @min-[48rem]:border-l"
        >
          {session && relationships ? (
            <>
              <label>
                上级地图{" "}
                <select
                  className="bg-background mt-1 w-full rounded-md border p-1.5"
                  disabled={busy || tool !== "select"}
                  value={m.parent ?? ""}
                  onChange={(e) => commit({ kind: "parent", parent: e.target.value || null })}
                >
                  <option value="">无（顶层地图）</option>
                  {hierarchy.map((candidate) => (
                    <option
                      key={candidate.id}
                      disabled={!candidate.chain.length || candidate.chain.includes(map.id)}
                      value={candidate.id}
                    >
                      {candidate.label} · {candidate.id}
                    </option>
                  ))}
                  {m.parent && !hierarchy.some((item) => item.id === m.parent) && (
                    <option disabled value={m.parent}>
                      {m.parent}（缺失）
                    </option>
                  )}
                </select>
              </label>

              <fieldset disabled={busy}>
                <MapConnections map={map} maps={maps} config={m} point={point} commit={commit} />
              </fieldset>
            </>
          ) : (
            <>
              <fieldset className="flex flex-wrap gap-x-3 gap-y-2">
                <legend className="mb-2 flex items-center gap-1 font-medium">
                  <Layers className="size-4" />
                  可见图层
                </legend>
                {(Object.keys(layers) as Layer[]).map((k) => (
                  <label key={k} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={visible[k]}
                      onChange={(e) => setVisible({ ...visible, [k]: e.target.checked })}
                    />
                    {layers[k]}
                  </label>
                ))}
              </fieldset>
              <div className="space-y-2 border-t pt-3">
                <label htmlFor="map-inspect-object" className="block font-medium">
                  定位对象
                </label>
                <select
                  id="map-inspect-object"
                  aria-label="定位配置项"
                  className="bg-background max-w-full rounded border p-1"
                  value={object?.key ?? ""}
                  onChange={(e) => {
                    const item = objects.find((o) => o.key === e.target.value);
                    setObjectKey(e.target.value);
                    if (item) {
                      const [x, y] = item.points[0];
                      setCamera((prev) => ({
                        ...prev,
                        x: x - m.width / 2 / prev.scale,
                        y: y - m.height / 2 / prev.scale,
                      }));
                    }
                  }}
                >
                  <option value="">定位配置项…</option>
                  {objects
                    .filter((o) => visible[o.layer])
                    .map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.name} · {o.key}
                      </option>
                    ))}
                </select>

                {object && (
                  <div className="space-y-2">
                    <p>{object.name}</p>
                    <code className="text-muted-foreground block max-h-24 overflow-auto text-xs break-all">
                      {object.key} · {JSON.stringify(object.points)}
                    </code>
                    {session &&
                      tool === "select" &&
                      (object.layer === "walls" || object.layer === "doors") && (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={busy}
                          onClick={() => {
                            if (object.layer === "walls" || object.layer === "doors")
                              commit({
                                kind: "delete",
                                layer: object.layer,
                                index: Number(object.key.match(/\d+/)![0]),
                              });
                          }}
                        >
                          删除所选
                        </Button>
                      )}
                  </div>
                )}
              </div>
              <p className="text-muted-foreground border-t pt-3 text-xs break-all">
                {path}
                <br />
                {m.width} × {m.height} px
              </p>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
