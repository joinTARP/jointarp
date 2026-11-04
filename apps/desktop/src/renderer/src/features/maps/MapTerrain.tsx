import type Konva from "konva";
import { useReducedMotion } from "motion/react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Image as KonvaImage } from "react-konva";

import { clipPreviousFog, createFogLayers, fogCanvas, paintFogFrame } from "./map-fog";
import type { RoomMap } from "./map-model";

/** 小图、大图共用地形记忆；仅对主机已确认的新视野做淡入。 */
export function MapTerrain({
  map: { resource, view },
  image,
}: {
  map: RoomMap;
  image?: HTMLImageElement;
}) {
  const node = useRef<Konva.Image>(null);
  const previous = useRef<
    { canvas: HTMLCanvasElement; image?: HTMLImageElement; id: string } | undefined
  >(undefined);
  const reducedMotion = useReducedMotion();
  const layers = useMemo(
    () => createFogLayers(resource, view, image),
    [resource, view.explored, view.visible, image],
  );

  useLayoutEffect(() => {
    const canvas = fogCanvas(layers.memory.width, layers.memory.height);
    const old = previous.current;
    const animate =
      !reducedMotion &&
      old &&
      old.id === resource.id &&
      old.image === image &&
      old.canvas.width === canvas.width &&
      old.canvas.height === canvas.height;
    const clipped = animate ? clipPreviousFog(old.canvas, layers.visible) : undefined;
    previous.current = { canvas, image, id: resource.id };
    node.current?.image(canvas);
    const draw = (progress: number) => {
      paintFogFrame(canvas, layers, clipped, progress);
      node.current?.getLayer()?.batchDraw();
    };
    draw(animate ? 0 : 1);
    if (!animate) return;
    const start = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 180);
      draw(1 - (1 - progress) ** 3);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [layers, image, resource.id, reducedMotion]);

  return (
    <KonvaImage ref={node} image={layers.memory} width={resource.width} height={resource.height} />
  );
}
