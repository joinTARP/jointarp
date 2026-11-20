import type { MapConfig, MapPoint } from "@jointarp/module/map";
import {
  footprintPixels,
  pixelsPerUnit,
  squareSegments,
  visibilityPolygon,
  wallSegments,
} from "@jointarp/module/map-geometry";

export function previewSight(map: MapConfig, at: MapPoint) {
  const blockers = [
    ...wallSegments(map),
    ...map.doors.filter((d) => !d.open).map((d) => ({ a: d.from, b: d.to })),
    ...map.tokens
      .filter((t) => t.blocksVision)
      .flatMap((t) => squareSegments(t.at, footprintPixels(map.grid, t.size))),
  ];
  return visibilityPolygon(
    at,
    blockers,
    map,
    map.vision === undefined ? undefined : map.vision * pixelsPerUnit(map.grid),
  );
}
