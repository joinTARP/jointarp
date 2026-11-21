import type { MapResource, MapView } from "@jointarp/core/shared/map";
import {
  decodeExploration,
  explorationGrid,
  type ExplorationGrid,
} from "@jointarp/module/map-geometry";

const fogResolution = 2048;
export const fogColor = "rgb(14, 14, 17)";

/** 直接绘制探索格，避免缩放低分辨率遮罩时把亮边插值到未知格。 */
export function paintExploration(
  context: Pick<CanvasRenderingContext2D, "fillRect">,
  bits: Uint8Array,
  grid: ExplorationGrid,
  bounds: { width: number; height: number },
) {
  for (let row = 0; row < grid.rows; row++) {
    let start = -1;
    for (let column = 0; column <= grid.columns; column++) {
      const index = row * grid.columns + column;
      const explored =
        column < grid.columns && ((bits[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
      if (explored && start < 0) start = column;
      if (!explored && start >= 0) {
        const x = start * grid.cell;
        const y = row * grid.cell;
        context.fillRect(
          x,
          y,
          Math.min(column * grid.cell, bounds.width) - x,
          Math.min(grid.cell, bounds.height - y),
        );
        start = -1;
      }
    }
  }
}

export function fogCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function createFogLayers(resource: MapResource, view: MapView, image?: HTMLImageElement) {
  const scale = Math.min(1, fogResolution / Math.max(resource.width, resource.height));
  const width = Math.ceil(resource.width * scale);
  const height = Math.ceil(resource.height * scale);
  const memory = fogCanvas(width, height);
  const visible = fogCanvas(width, height);
  const memoryContext = memory.getContext("2d");
  const visibleContext = visible.getContext("2d");
  if (!memoryContext || !visibleContext) return { memory, visible };

  memoryContext.scale(scale, scale);
  memoryContext.fillStyle = "white";
  const grid = explorationGrid(resource);
  paintExploration(memoryContext, decodeExploration(view.explored, grid), grid, resource);
  memoryContext.globalCompositeOperation = "source-in";
  if (image) {
    memoryContext.filter = "grayscale(0.9) brightness(0.45)";
    memoryContext.drawImage(image, 0, 0, resource.width, resource.height);
    memoryContext.filter = "none";
  } else {
    memoryContext.fillStyle = fogColor;
    memoryContext.fillRect(0, 0, resource.width, resource.height);
  }
  memoryContext.globalCompositeOperation = "destination-over";
  memoryContext.fillStyle = fogColor;
  memoryContext.fillRect(0, 0, resource.width, resource.height);

  visibleContext.scale(scale, scale);
  visibleContext.fillStyle = "white";
  for (const polygon of view.visible) {
    if (polygon.length < 3) continue;
    visibleContext.beginPath();
    visibleContext.moveTo(polygon[0]![0], polygon[0]![1]);
    for (const [x, y] of polygon.slice(1)) visibleContext.lineTo(x, y);
    visibleContext.closePath();
    visibleContext.fill();
  }
  visibleContext.globalCompositeOperation = "source-in";
  if (image) visibleContext.drawImage(image, 0, 0, resource.width, resource.height);
  else visibleContext.clearRect(0, 0, resource.width, resource.height);
  return { memory, visible };
}

/** 旧画面只允许留在新视野内，关门、撤回探索时立即遮住失去的视野。 */
export function clipPreviousFog(previous: HTMLCanvasElement, visible: HTMLCanvasElement) {
  const clipped = fogCanvas(visible.width, visible.height);
  const context = clipped.getContext("2d");
  if (context) {
    context.drawImage(previous, 0, 0);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(visible, 0, 0);
  }
  return clipped;
}

export function paintFogFrame(
  canvas: HTMLCanvasElement,
  layers: { memory: HTMLCanvasElement; visible: HTMLCanvasElement },
  previous?: HTMLCanvasElement,
  progress = 1,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(layers.memory, 0, 0);
  if (previous && progress < 1) context.drawImage(previous, 0, 0);
  context.globalAlpha = progress;
  context.drawImage(layers.visible, 0, 0);
  context.globalAlpha = 1;
}
