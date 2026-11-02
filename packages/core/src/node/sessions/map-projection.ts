import type { MapPoint, ModuleMap } from "@jointarp/module/map";
import { round } from "@jointarp/module/map-geometry";

import type { MapResource, MapSection, MapView } from "../../shared/map";
import { isParty, partyVision, tokensOn, visibleTokens } from "./map-space";
import type { MapState } from "./map-state";

export function mapResources(maps: readonly ModuleMap[]): MapResource[] {
  return maps.map(({ id, path, config }) => ({
    id,
    path,
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    image: config.image,
    width: config.width,
    height: config.height,
    grid: config.grid,
    walls: config.walls.map((wall) => wall.points),
  }));
}

const roundPoint = (point: readonly [number, number]): MapPoint => [
  round(point[0]),
  round(point[1]),
];

/** 按全队视野投影队伍已知的地图；视野外的标记与未揭示的秘门不进入投影。 */
export function projectMapSection(
  maps: readonly ModuleMap[],
  state: MapState,
  party: ReadonlyMap<string, string>,
): MapSection {
  const views: MapView[] = [];
  for (const map of maps) {
    const room = state.maps[map.id];
    if (!room?.known) continue;
    const polygons = partyVision(map, room, state, party).map(({ polygon }) =>
      polygon.map(roundPoint),
    );
    const visible = visibleTokens(map, state, party, polygons);
    views.push({
      id: map.id,
      explored: room.explored,
      visible: polygons,
      doors: map.config.doors
        .filter((door) => room.doors[door.id]?.revealed)
        .map((door) => ({
          id: door.id,
          from: door.from,
          to: door.to,
          open: Boolean(room.doors[door.id]?.open),
        })),
      barriers: map.config.doors
        .filter((door) => !room.doors[door.id]?.revealed)
        .map((door) => [door.from, door.to] as const),
      tokens: tokensOn(state, map.id)
        .filter(([id]) => visible.has(id))
        .map(([id, token]) => {
          const playerId = token.document ? party.get(token.document) : undefined;
          return {
            id,
            ...(token.document ? { document: token.document } : {}),
            ...(token.label ? { label: token.label } : {}),
            at: token.at,
            size: token.size,
            party: isParty(token, party),
            ...(playerId ? { playerId } : {}),
          };
        }),
    });
  }
  return {
    maps: views,
    intents: Object.fromEntries(
      Object.entries(state.intents).map(([id, intent]) => [id, intent.progress]),
    ),
  };
}
