import type { MapTokenView } from "@jointarp/core/shared/map";
import type { MapPoint } from "@jointarp/module/map";
import {
  decodeExploration,
  explorationGrid,
  footprintPixels,
  snapToGrid,
} from "@jointarp/module/map-geometry";
import type Konva from "konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Stage, Text } from "react-konva";

import { useDocumentImage } from "../modules/document-image";
import type { RoomMap } from "./map-model";
import type { MovementPlan, PendingRoute } from "./map-ui";

const fogResolution = 2048;

function useLoadedImage(src: string | undefined) {
  const [image, setImage] = useState<HTMLImageElement>();
  useEffect(() => {
    setImage(undefined);
    if (!src) return;
    const element = new window.Image();
    element.onload = () => setImage(element);
    element.src = src;
    return () => {
      element.onload = null;
    };
  }, [src]);
  return image;
}

/** 未探索区域完全遮住底图，已探索但不在视野内的区域变暗，视野内保持原样。 */
function useFog({ resource, view }: RoomMap) {
  return useMemo(() => {
    const scale = Math.min(1, fogResolution / Math.max(resource.width, resource.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(resource.width * scale);
    canvas.height = Math.ceil(resource.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    context.scale(scale, scale);
    context.fillStyle = "rgb(14, 14, 17)";
    context.fillRect(0, 0, resource.width, resource.height);
    const grid = explorationGrid(resource);
    const bits = decodeExploration(view.explored, grid);
    const cells = document.createElement("canvas");
    cells.width = grid.columns;
    cells.height = grid.rows;
    const cellContext = cells.getContext("2d");
    if (cellContext) {
      const pixels = cellContext.createImageData(grid.columns, grid.rows);
      for (let index = 0; index < grid.columns * grid.rows; index++)
        if ((bits[index >> 3]! & (1 << (index & 7))) !== 0) pixels.data[index * 4 + 3] = 255;
      cellContext.putImageData(pixels, 0, 0);
      context.globalCompositeOperation = "destination-out";
      context.globalAlpha = 0.45;
      context.imageSmoothingEnabled = true;
      context.drawImage(cells, 0, 0, grid.columns * grid.cell, grid.rows * grid.cell);
    }
    context.globalAlpha = 1;
    for (const polygon of view.visible) {
      if (polygon.length < 3) continue;
      context.beginPath();
      context.moveTo(polygon[0]![0], polygon[0]![1]);
      for (const [x, y] of polygon.slice(1)) context.lineTo(x, y);
      context.closePath();
      context.fill();
    }
    return canvas;
  }, [resource, view.explored, view.visible]);
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

export function MapCanvas({
  roomId,
  map,
  tokenName,
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
  const size = useSize(container);
  const image = useLoadedImage(
    useDocumentImage(resource.path, resource.image, `room-module:${roomId}`),
  );
  const fog = useFog(map);
  const fit = useMemo(() => {
    const scale = Math.min(size.width / resource.width, size.height / resource.height) || 1;
    return {
      scale,
      x: (size.width - resource.width * scale) / 2,
      y: (size.height - resource.height * scale) / 2,
    };
  }, [size.width, size.height, resource.width, resource.height]);
  const [camera, setCamera] = useState(fit);
  const fitKey = `${resource.id}:${size.width}:${size.height}`;
  const fitted = useRef(fitKey);
  if (fitted.current !== fitKey) {
    fitted.current = fitKey;
    setCamera(fit);
  }
  const transform = interactive ? camera : fit;
  const screen = 1 / transform.scale;
  const ownTokenView = view.tokens.find((token) => token.id === plan?.token);

  const handleWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    if (!interactive) return;
    event.evt.preventDefault();
    const stage = event.target.getStage();
    const pointer = stage?.getPointerPosition();
    if (!pointer) return;
    const factor = event.evt.deltaY > 0 ? 1 / 1.15 : 1.15;
    const scale = Math.min(fit.scale * 12, Math.max(fit.scale * 0.6, camera.scale * factor));
    const anchor = {
      x: (pointer.x - camera.x) / camera.scale,
      y: (pointer.y - camera.y) / camera.scale,
    };
    setCamera({ scale, x: pointer.x - anchor.x * scale, y: pointer.y - anchor.y * scale });
  };
  const handleClick = (event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!planning || !onAddWaypoint || event.evt.button !== 0) return;
    const pointer = event.target.getStage()?.getPointerPosition();
    if (!pointer) return;
    const point: MapPoint = [
      (pointer.x - transform.x) / transform.scale,
      (pointer.y - transform.y) / transform.scale,
    ];
    if (point[0] < 0 || point[1] < 0 || point[0] > resource.width || point[1] > resource.height)
      return;
    onAddWaypoint(snapToGrid(resource.grid, point, ownTokenView?.size ?? 1));
  };

  return (
    <div
      ref={setContainer}
      className={`relative overflow-hidden bg-[rgb(14,14,17)] ${planning ? "cursor-crosshair" : interactive ? "cursor-grab" : ""} ${className ?? ""}`}
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
          onDragEnd={(event) => {
            if (event.target === event.target.getStage())
              setCamera((current) => ({ ...current, x: event.target.x(), y: event.target.y() }));
          }}
          onWheel={handleWheel}
          onClick={handleClick}
        >
          <Layer listening={false}>
            {image ? (
              <KonvaImage image={image} width={resource.width} height={resource.height} />
            ) : null}
            <KonvaImage image={fog} width={resource.width} height={resource.height} />
            {view.doors.map((door) => (
              <Line
                key={door.id}
                points={flatten([door.from, door.to])}
                stroke={door.open ? "#86efac" : "#f59e0b"}
                strokeWidth={(door.open ? 2 : 4) * screen}
                dash={door.open ? [6 * screen, 4 * screen] : undefined}
                lineCap="round"
              />
            ))}
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
            {view.tokens.map((token) => {
              const radius = (footprintPixels(resource.grid, token.size) / 2) * 0.8;
              const colors =
                token.id === ownToken
                  ? tokenColors.own
                  : token.party
                    ? tokenColors.party
                    : tokenColors.other;
              const name = tokenName(token);
              return (
                <Group key={token.id} x={token.at[0]} y={token.at[1]}>
                  <Circle
                    radius={radius}
                    fill={colors.fill}
                    stroke={colors.stroke}
                    strokeWidth={Math.max(2 * screen, radius * 0.08)}
                    shadowColor="black"
                    shadowBlur={6 * screen}
                    shadowOpacity={0.5}
                  />
                  <Text
                    text={name.slice(0, 1)}
                    fontSize={radius}
                    fontStyle="bold"
                    fill="white"
                    width={radius * 2}
                    height={radius * 2}
                    offsetX={radius}
                    offsetY={radius}
                    align="center"
                    verticalAlign="middle"
                  />
                  {interactive ? (
                    <Text
                      text={name}
                      fontSize={12 * screen}
                      fill="#f9fafb"
                      shadowColor="black"
                      shadowBlur={4 * screen}
                      shadowOpacity={0.9}
                      width={160 * screen}
                      offsetX={80 * screen}
                      y={radius + 3 * screen}
                      align="center"
                    />
                  ) : null}
                </Group>
              );
            })}
          </Layer>
        </Stage>
      ) : null}
    </div>
  );
}
