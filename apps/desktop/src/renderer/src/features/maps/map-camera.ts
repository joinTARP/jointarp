import type { MapCamera } from "./map-ui";

type Size = { width: number; height: number };
type Transform = { x: number; y: number; scale: number };

export function cameraTransform(camera: MapCamera, size: Size): Transform {
  return {
    scale: camera.scale,
    x: size.width / 2 - camera.center[0] * camera.scale,
    y: size.height / 2 - camera.center[1] * camera.scale,
  };
}

export function cameraFromTransform(transform: Transform, size: Size): MapCamera {
  return {
    scale: transform.scale,
    center: [
      (size.width / 2 - transform.x) / transform.scale,
      (size.height / 2 - transform.y) / transform.scale,
    ],
  };
}

export function zoomCamera(
  camera: Transform,
  factor: number,
  fitScale: number,
  anchor: { x: number; y: number },
): Transform {
  const scale = Math.min(fitScale * 12, Math.max(fitScale * 0.6, camera.scale * factor));
  return {
    scale,
    x: anchor.x - ((anchor.x - camera.x) / camera.scale) * scale,
    y: anchor.y - ((anchor.y - camera.y) / camera.scale) * scale,
  };
}
