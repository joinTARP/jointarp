import type { MapTokenView } from "@jointarp/core/shared/map";
import type { MapPoint } from "@jointarp/module/map";
import { firstBlocked, footprintPixels, snapToGrid } from "@jointarp/module/map-geometry";
import type Konva from "konva";
import { LocateFixed, Maximize2, Minus, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Stage, Text } from "react-konva";

import { Button } from "../../components/ui/button";
import { useDocumentImage } from "../modules/document-image";
import { cameraFromTransform, cameraTransform, zoomCamera } from "./map-camera";
import {
  distanceText,
  knownWalls,
  summarizePlan,
  type RoomMap,
  type TokenPortrait,
} from "./map-model";
import { mapUi, useMapUi, type MovementPlan, type PendingRoute } from "./map-ui";
import { MapTerrain } from "./MapTerrain";

function useLoadedImage(src: string | undefined, onError?: (src: string) => void) {
  const [image, setImage] = useState<HTMLImageElement>();
  const report = useRef(onError);
  report.current = onError;
  useEffect(() => {
    setImage(undefined);
    if (!src) return;
    const element = new window.Image();
    element.onload = () => setImage(element);
    element.onerror = () => report.current?.(src);
    element.src = src;
    return () => {
      element.onload = null;
      element.onerror = null;
    };
  }, [src]);
  return image;
}

/** 圆形标记里按 cover 取图，并靠上对齐，避免头像只剩衣服。 */
function portraitCrop(image: HTMLImageElement, size: number) {
  const scale = Math.max(size / image.width, size / image.height);
  const width = Math.min(image.width, size / scale);
  const height = Math.min(image.height, size / scale);
  return { x: Math.max(0, (image.width - width) / 2), y: 0, width, height };
}

function useSize(element: HTMLDivElement | null) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

const tokenColors = {
  own: { fill: "#2563eb", stroke: "#dbeafe" },
  party: { fill: "#0f766e", stroke: "#ccfbf1" },
  other: { fill: "#b45309", stroke: "#fef3c7" },
};

const flatten = (points: readonly MapPoint[]) => points.flatMap(([x, y]) => [x, y]);

function TokenMarker({
  roomId,
  token,
  name,
  portrait,
  radius,
  screen,
  fill,
  stroke,
  interactive,
  onHover,
}: {
  roomId: string;
  token: MapTokenView;
  name: string;
  portrait?: TokenPortrait;
  radius: number;
  screen: number;
  fill: string;
  stroke: string;
  interactive: boolean;
  onHover: (point: { x: number; y: number } | undefined) => void;
}) {
  const scope = `room-module:${roomId}`;
  const preferred = useDocumentImage(portrait?.path, portrait?.avatar ?? portrait?.image, scope);
  const fallback = useDocumentImage(
    portrait?.path,
    portrait?.avatar && portrait.image ? portrait.image : undefined,
    scope,
  );
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const src = [preferred, fallback].find((url) => url && !broken.has(url));
  const photo = useLoadedImage(src, (failed) =>
    setBroken((current) => new Set([...current, failed])),
  );
  const size = radius * 2;
  const hoverAt = (event: Konva.KonvaEventObject<MouseEvent>) => {
    const point = event.target.getStage()?.getPointerPosition();
    if (point) onHover(point);
  };
  return (
    <Group
      x={token.at[0]}
      y={token.at[1]}
      onMouseEnter={hoverAt}
      onMouseMove={hoverAt}
      onMouseLeave={() => onHover(undefined)}
      onMouseDown={(event) => {
        if (interactive) event.target.getStage()?.startDrag();
      }}
    >
      <Circle
        radius={radius}
        fill={photo ? "#111" : fill}
        stroke={stroke}
        strokeWidth={Math.max(2 * screen, radius * 0.08)}
        shadowColor="black"
        shadowBlur={6 * screen}
        shadowOpacity={0.45}
      />
      {photo ? (
        <Group
          clipFunc={(context) => {
            context.beginPath();
            context.arc(0, 0, radius, 0, Math.PI * 2);
            context.closePath();
          }}
        >
          <KonvaImage
            image={photo}
            width={size}
            height={size}
            offsetX={radius}
            offsetY={radius}
            crop={portraitCrop(photo, size)}
          />
        </Group>
      ) : (
        <Text
          text={name.slice(0, 1)}
          fontSize={radius * 0.9}
          fontStyle="bold"
          fill="white"
          width={size}
          height={size}
          offsetX={radius}
          offsetY={radius}
          align="center"
          verticalAlign="middle"
        />
      )}
    </Group>
  );
}

export function MapCanvas({
  roomId,
  map,
  tokenName,
  tokenPortrait,
  ownToken,
  routes = [],
  plan,
  planning = false,
  interactive = false,
  onAddWaypoint,
  className,
}: {
  roomId: string;
  map: RoomMap;
  tokenName: (token: MapTokenView) => string;
  tokenPortrait?: (token: MapTokenView) => TokenPortrait | undefined;
  ownToken?: string;
  routes?: readonly PendingRoute[];
  plan?: MovementPlan;
  planning?: boolean;
  interactive?: boolean;
  onAddWaypoint?: (point: MapPoint) => void;
  className?: string;
}) {
  const { resource, view } = map;
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ name: string; x: number; y: number }>();
  const size = useSize(container);
  const image = useLoadedImage(
    useDocumentImage(resource.path, resource.image, `room-module:${roomId}`),
  );
  const fit = useMemo(() => {
    const scale = Math.min(size.width / resource.width, size.height / resource.height) || 1;
    return {
      scale,
      x: (size.width - resource.width * scale) / 2,
      y: (size.height - resource.height * scale) / 2,
    };
  }, [size.width, size.height, resource.width, resource.height]);
  const ui = useMapUi(roomId);
  const saved = ui.cameras[resource.id];
  const camera = saved ? cameraTransform(saved, size) : fit;
  const setCamera = (next: { scale: number; x: number; y: number }) => {
    setPointer(undefined);
    setHover(undefined);
    mapUi.update(roomId, (state) => ({
      ...state,
      cameras: {
        ...state.cameras,
        [resource.id]: cameraFromTransform(next, size),
      },
    }));
  };
  const transform = interactive ? camera : fit;
  const screen = 1 / transform.scale;
  const ownTokenView = view.tokens.find((token) => token.id === ownToken);
  const [pointer, setPointer] = useState<MapPoint>();
  const [dragging, setDragging] = useState(false);
  const previewPoint = planning && !dragging ? pointer : undefined;
  const last = plan?.waypoints.at(-1) ?? ownTokenView?.at;
  const blocked = Boolean(
    last && previewPoint && firstBlocked([last, previewPoint], knownWalls(resource, view)),
  );
  const preview =
    previewPoint && ownTokenView
      ? summarizePlan(map, {
          map: resource.id,
          token: ownTokenView.id,
          waypoints: [...(plan?.waypoints ?? []), previewPoint],
        })
      : undefined;
  const pointAtPointer = (stage: Konva.Stage | null): MapPoint | undefined => {
    const position = stage?.getPointerPosition();
    if (!position) return;
    const point: MapPoint = [
      (position.x - transform.x) / transform.scale,
      (position.y - transform.y) / transform.scale,
    ];
    if (point[0] < 0 || point[1] < 0 || point[0] > resource.width || point[1] > resource.height)
      return;
    const snapped = snapToGrid(resource.grid, point, ownTokenView?.size ?? 1);
    if (
      snapped[0] >= 0 &&
      snapped[1] >= 0 &&
      snapped[0] <= resource.width &&
      snapped[1] <= resource.height
    )
      return snapped;
  };
  const zoom = (factor: number, anchor = { x: size.width / 2, y: size.height / 2 }) => {
    setCamera(zoomCamera(camera, factor, fit.scale, anchor));
  };

  const handleWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    if (!interactive) return;
    event.evt.preventDefault();
    const stage = event.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    if (event.evt.deltaY !== 0) zoom(event.evt.deltaY > 0 ? 1 / 1.15 : 1.15, pointer);
  };
  const handleClick = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!planning || !onAddWaypoint || event.evt.button !== 0 || dragging) return;
    const point = pointAtPointer(event.target.getStage());
    if (point) onAddWaypoint(point);
  };

  return (
    <div
      ref={setContainer}
      className={`relative overflow-hidden bg-[rgb(14,14,17)] ${dragging ? "cursor-grabbing" : planning ? "cursor-crosshair" : interactive ? "cursor-grab" : ""} ${className ?? ""}`}
    >
      {size.width > 0 && size.height > 0 ? (
        <Stage
          width={size.width}
          height={size.height}
          x={transform.x}
          y={transform.y}
          scaleX={transform.scale}
          scaleY={transform.scale}
          draggable={interactive}
          dragDistance={4}
          onMouseMove={(event) => {
            if (planning && !dragging) setPointer(pointAtPointer(event.target.getStage()));
          }}
          onMouseLeave={() => {
            setPointer(undefined);
            setHover(undefined);
          }}
          onDragStart={() => {
            setDragging(true);
            setPointer(undefined);
            setHover(undefined);
          }}
          onDragEnd={(event) => {
            setDragging(false);
            if (event.target === event.target.getStage())
              setCamera({ ...camera, x: event.target.x(), y: event.target.y() });
          }}
          onWheel={handleWheel}
          onClick={handleClick}
        >
          <Layer listening={false}>
            <MapTerrain key={`${roomId}:${resource.id}`} map={map} image={image} />
            {last && previewPoint ? (
              <>
                <Line
                  points={flatten([last, previewPoint])}
                  stroke={blocked ? "#f87171" : "#60a5fa"}
                  strokeWidth={3 * screen}
                  dash={[6 * screen, 4 * screen]}
                />
                <Circle
                  x={previewPoint[0]}
                  y={previewPoint[1]}
                  radius={6 * screen}
                  stroke={blocked ? "#f87171" : "#60a5fa"}
                  strokeWidth={2 * screen}
                />
              </>
            ) : null}
            {routes.map((route) => (
              <Line
                key={route.messageId}
                points={flatten([route.from, ...route.waypoints])}
                stroke="#e5e7eb"
                opacity={0.85}
                strokeWidth={2.5 * screen}
                dash={[8 * screen, 6 * screen]}
                lineCap="round"
                lineJoin="round"
              />
            ))}
            {plan && ownTokenView ? (
              <>
                <Line
                  points={flatten([ownTokenView.at, ...plan.waypoints])}
                  stroke="#60a5fa"
                  strokeWidth={3 * screen}
                  dash={[10 * screen, 6 * screen]}
                  lineCap="round"
                  lineJoin="round"
                />
                {plan.waypoints.map(([x, y], index) => (
                  <Circle
                    key={index}
                    x={x}
                    y={y}
                    radius={(index === plan.waypoints.length - 1 ? 6 : 4) * screen}
                    fill="#60a5fa"
                    stroke="#eff6ff"
                    strokeWidth={1.5 * screen}
                  />
                ))}
              </>
            ) : null}
          </Layer>
          <Layer>
            {view.tokens
              .filter((token) => token.document)
              .map((token) => {
                const colors =
                  token.id === ownToken
                    ? tokenColors.own
                    : token.party
                      ? tokenColors.party
                      : tokenColors.other;
                const name = tokenName(token);
                return (
                  <TokenMarker
                    key={token.id}
                    roomId={roomId}
                    token={token}
                    name={name}
                    portrait={tokenPortrait?.(token)}
                    radius={(footprintPixels(resource.grid, token.size) / 2) * 0.72}
                    screen={screen}
                    fill={colors.fill}
                    stroke={colors.stroke}
                    interactive={interactive && !planning}
                    onHover={(point) => setHover(point ? { name, ...point } : undefined)}
                  />
                );
              })}
          </Layer>
        </Stage>
      ) : null}
      {interactive ? (
        <>
          <div
            role="toolbar"
            aria-label="地图视角"
            className="bg-background/95 border-border absolute top-3 right-3 flex items-center gap-1 rounded-xl border p-1 shadow-lg"
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label="定位自己"
              tooltip="定位自己"
              disabled={!ownTokenView}
              onClick={() =>
                ownTokenView &&
                setCamera({
                  scale: camera.scale,
                  x: size.width / 2 - ownTokenView.at[0] * camera.scale,
                  y: size.height / 2 - ownTokenView.at[1] * camera.scale,
                })
              }
            >
              <LocateFixed className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="适应全图"
              tooltip="适应全图"
              onClick={() => setCamera(fit)}
            >
              <Maximize2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="缩小地图"
              tooltip="缩小地图"
              onClick={() => zoom(1 / 1.15)}
            >
              <Minus className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="放大地图"
              tooltip="放大地图"
              onClick={() => zoom(1.15)}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div
            role="status"
            className="bg-background/95 text-foreground pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] rounded-lg px-3 py-2 text-xs shadow-lg"
          >
            {planning
              ? blocked
                ? "路线不能穿过墙"
                : preview
                  ? distanceText(preview.length, resource.grid.unit, preview.explore)
                  : "点击添加路点 · 拖动平移 · 滚轮缩放"
              : "拖动平移 · 滚轮缩放"}
          </div>
        </>
      ) : null}
      {hover && !dragging ? (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 -translate-x-1/2 rounded-md px-2 py-1 text-xs shadow-md"
          style={{ left: hover.x, top: Math.max(4, hover.y - 28) }}
        >
          {hover.name}
        </div>
      ) : null}
    </div>
  );
}
