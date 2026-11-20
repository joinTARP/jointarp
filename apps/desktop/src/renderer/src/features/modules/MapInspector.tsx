import type { MapPoint, ModuleMap } from "@jointarp/module/map";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { Button } from "../../components/ui/button";
import { desktopOrpc } from "../../desktop-rpc";
import { useDocumentImage } from "./document-image";
import { previewSight } from "./map-inspector-sight";

export function MapInspector({ path }: { path: string }) {
  const query = useQuery(desktopOrpc.modules.maps.queryOptions({ input: { path } }));
  const [lastMap, setLastMap] = useState<ModuleMap>();
  const maps = query.data?.maps ?? [];
  const current = maps.find((map) => map.id === lastMap?.id);
  const stale =
    !!lastMap && !current && !!query.data?.issues.some((issue) => issue.path === lastMap.path);
  const selected = current ?? (stale ? lastMap : maps[0]);
  useEffect(() => {
    if (selected) setLastMap(selected);
  }, [selected]);
  return (
    <>
      <PageToolbarHeader
        title="地图校对"
        description="检查底图对齐与初始视野"
        widthClassName="max-w-6xl"
      />
      <section className="mx-auto max-w-6xl space-y-4 px-9 pt-5">
        <div className="flex items-center gap-3">
          {selected && (
            <select
              aria-label="选择地图"
              className="bg-background rounded border p-2"
              value={selected.id}
              onChange={(e) => setLastMap(maps.find((map) => map.id === e.target.value))}
            >
              {stale && <option value={selected.id}>{selected.config.name}（上次有效配置）</option>}
              {maps.map((map) => (
                <option key={map.id} value={map.id}>
                  {map.config.name} · {map.id}
                </option>
              ))}
            </select>
          )}
          <Button
            variant="outline"
            disabled={query.isFetching}
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
        {selected && <MapSheet key={selected.id} map={selected} version={query.dataUpdatedAt} />}
      </section>
    </>
  );
}

const layers = { walls: "墙线", doors: "门", regions: "区域", starts: "起点", sight: "视野" };
type Layer = keyof typeof layers;

function MapSheet({ map: { config: m, path }, version }: { map: ModuleMap; version: number }) {
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
  const point = at && at[0] <= m.width && at[1] <= m.height ? at : undefined;
  const sight = useMemo(
    () => (point && visible.sight ? previewSight(m, point) : []),
    [m, point, visible.sight],
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-4 text-sm">
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
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            zoomAt(camera.scale / 1.5, [
              camera.x + m.width / 2 / camera.scale,
              camera.y + m.height / 2 / camera.scale,
            ])
          }
          aria-label="缩小"
        >
          −
        </Button>
        <span>{Math.round(camera.scale * 100)}%</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            zoomAt(camera.scale * 1.5, [
              camera.x + m.width / 2 / camera.scale,
              camera.y + m.height / 2 / camera.scale,
            ])
          }
          aria-label="放大"
        >
          ＋
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCamera({ x: 0, y: 0, scale: 1 })}>
          适应全图
        </Button>
        <select
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
      </div>
      {(!href || failed === href) && <p role="alert">无法载入底图 · {m.image}</p>}
      <div className="overflow-hidden rounded-lg border bg-neutral-900">
        <svg
          ref={svgRef}
          viewBox={`${camera.x} ${camera.y} ${m.width / camera.scale} ${m.height / camera.scale}`}
          aria-label="地图校对画布"
          className="block h-[55vh] w-full cursor-crosshair touch-none"
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return;
            drag.current = { x: e.clientX, y: e.clientY, camera, moved: false, id: e.pointerId };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const start = drag.current,
              matrix = e.currentTarget.getScreenCTM();
            if (!start || start.id !== e.pointerId || !matrix) return;
            const dx = e.clientX - start.x,
              dy = e.clientY - start.y;
            if (!start.moved && Math.hypot(dx, dy) < 4) return;
            start.moved = true;
            setCamera({
              ...start.camera,
              x: start.camera.x - dx / matrix.a,
              y: start.camera.y - dy / matrix.d,
            });
          }}
          onLostPointerCapture={() => {
            drag.current = null;
          }}
          onPointerUp={(e) => {
            const start = drag.current,
              matrix = e.currentTarget.getScreenCTM();
            if (!start || start.id !== e.pointerId || start.moved || !matrix) return;
            const pos = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
            if (pos.x < 0 || pos.y < 0 || pos.x > m.width || pos.y > m.height) return;
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
      {object && (
        <div className="text-sm break-all">
          <strong>{object.name}</strong> ·{" "}
          <code>
            {object.key} · {JSON.stringify(object.points)}
          </code>
        </div>
      )}
      <p className="text-muted-foreground text-xs">滚轮缩放 · 拖动平移 · 点击拾取坐标与配置项</p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <code>
          {path} · {m.width} × {m.height} px
        </code>
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
    </>
  );
}
