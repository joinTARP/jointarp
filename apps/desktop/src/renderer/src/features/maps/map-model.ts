import type { MapResource, MapTokenView, MapView } from "@jointarp/core/shared/map";
import { documentIdentity } from "@jointarp/module/document-path";
import type { MapPoint } from "@jointarp/module/map";
import {
  decodeExploration,
  explorationGrid,
  firstBlocked,
  isExplored,
  measurePath,
  polylineSegments,
  round,
  type Segment,
} from "@jointarp/module/map-geometry";
import { useMemo, useSyncExternalStore } from "react";

import { desktopRpc } from "../../desktop-rpc";
import { localRoomModuleLoader } from "../sessions/local-room-module";
import { roomConnection } from "../sessions/room-connection";
import { roomDocuments, useRoomReplica } from "../sessions/use-room-state";
import type { MovementPlan } from "./map-ui";

export interface RoomMap {
  readonly resource: MapResource;
  readonly view: MapView;
}

/** 标记关联资料上的头像；没有头像时用封面。 */
export interface TokenPortrait {
  readonly path: string;
  readonly avatar?: string;
  readonly image?: string;
}

/** 队伍已知的地图与当前投影；静态资料来自冻结模组，动态部分来自房间同步。 */
export function useRoomMaps(roomId: string) {
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  const resources = useSyncExternalStore(
    connection.subscribe,
    () => connection.getSnapshot().resources,
  )?.maps;
  const replica = useRoomReplica(roomId);
  const section = replica?.sections.map;
  const viewerId = replica?.sections.viewerId;
  const documents = replica ? roomDocuments(replica) : undefined;
  return useMemo(() => {
    const maps: RoomMap[] = [];
    for (const view of section?.maps ?? []) {
      const resource = resources?.find((item) => item.id === view.id);
      if (resource) maps.push({ resource, view });
    }
    const names = new Map(
      (documents ?? []).map((document) => [documentIdentity(document.path), document.title]),
    );
    const portraits = new Map(
      Object.values(replica?.entities ?? {}).map((entity) => [
        documentIdentity(entity.document.path),
        {
          path: entity.document.path,
          avatar: entity.document.avatar,
          image: entity.document.image,
        },
      ]),
    );
    const own = maps.flatMap(({ resource, view }) =>
      view.tokens
        .filter((token) => token.party && token.playerId === viewerId)
        .map((token) => ({ map: resource.id, token })),
    )[0];
    return {
      maps,
      intents: section?.intents ?? {},
      viewerId,
      own,
      tokenName: (token: MapTokenView): string =>
        token.label ??
        (token.document
          ? (names.get(token.document) ?? token.document.split("/").at(-1) ?? token.document)
          : token.id),
      tokenPortrait: (token: MapTokenView) =>
        token.document ? portraits.get(token.document) : undefined,
    };
  }, [resources, section, viewerId, documents, replica]);
}

/** 玩家可知的阻挡：配置的墙与尚未揭示的秘门。 */
export function knownWalls(resource: MapResource, view: MapView): Segment[] {
  return [
    ...resource.walls.flatMap((points) => polylineSegments(points)),
    ...view.barriers.map(([a, b]) => ({ a, b })),
  ];
}

export function unitLabel(resource: MapResource) {
  return resource.grid.unit;
}

export interface PlanSummary {
  readonly path: MapPoint[];
  readonly length: number | null;
  readonly explore: boolean;
  readonly blocked: boolean;
}

export function summarizePlan(map: RoomMap, plan: MovementPlan): PlanSummary | undefined {
  const token = map.view.tokens.find((item) => item.id === plan.token);
  if (!token) return undefined;
  const path: MapPoint[] = [token.at, ...plan.waypoints];
  const grid = explorationGrid(map.resource);
  const explore = !isExplored(decodeExploration(map.view.explored, grid), grid, path.at(-1)!);
  return {
    path,
    length: explore ? null : round(measurePath(map.resource.grid, path).total),
    explore,
    blocked: Boolean(firstBlocked(path, knownWalls(map.resource, map.view))),
  };
}

export function distanceText(length: number | null, unit: string, explore: boolean) {
  return explore || length === null ? "前往未探索区域" : `约 ${length} ${unit}`;
}
