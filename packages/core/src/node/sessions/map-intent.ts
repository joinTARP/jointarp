import {
  explorationGrid,
  firstBlocked,
  isExplored,
  measurePath,
  round,
  wallSegments,
} from "@jointarp/module/map-geometry";

import type { MovementIntent, MovementIntentInput } from "../../shared/map";
import type { SessionDatabase } from "../storage/session-database";
import { frozenModule } from "./frozen-module";
import { explorationBits, partyIndex } from "./map-space";
import { readMapState } from "./map-state";

/** 校验玩家为本人角色提交的移动意图，并按当前标记位置记录起点与预估距离。 */
export function prepareMovement(
  db: SessionDatabase,
  playerId: string,
  input: MovementIntentInput,
): MovementIntent {
  const map = frozenModule(db).maps.find((item) => item.id === input.map);
  const state = readMapState(db);
  const room = map && state.maps[map.id];
  if (!map || !room?.known) throw new Error("地图不存在或队伍尚未到达");
  const token = state.tokens[input.token];
  if (!token || token.map !== map.id) throw new Error("该标记不在这张地图上");
  if (!token.document || partyIndex(db).get(token.document) !== playerId)
    throw new Error("只能为自己的角色提交移动意图");
  for (const [x, y] of input.waypoints)
    if (x < 0 || y < 0 || x > map.config.width || y > map.config.height)
      throw new Error("路点超出地图范围");
  const path = [token.at, ...input.waypoints];
  // 玩家只知道已揭示的门；未揭示的秘门与墙一样不能穿过，关闭的门交给主持裁定。
  const walls = [
    ...wallSegments(map.config),
    ...map.config.doors
      .filter((door) => !room.doors[door.id]?.revealed)
      .map((door) => ({ a: door.from, b: door.to })),
  ];
  if (firstBlocked(path, walls)) throw new Error("移动路线不能穿过墙");
  const explore = !isExplored(
    explorationBits(map, room),
    explorationGrid(map.config),
    path.at(-1)!,
  );
  return {
    ...input,
    from: token.at,
    length: explore ? null : round(measurePath(map.config.grid, path).total),
    unit: map.config.grid.unit,
    explore,
  };
}
