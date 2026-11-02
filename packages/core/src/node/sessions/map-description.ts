import { basename } from "node:path";

import { documentIdentity } from "@jointarp/module/document-path";
import type { ModuleMap } from "@jointarp/module/map";
import { distance, measurePath, round, toUnits, type Point } from "@jointarp/module/map-geometry";

import type { MovementIntent } from "../../shared/map";
import type { SessionDatabase } from "../storage/session-database";
import { readCharacters } from "./character-db";
import { frozenModule } from "./frozen-module";
import {
  analyzeRoute,
  isParty,
  partyIndex,
  partyVision,
  regionLabel,
  regionsAt,
  tokensOn,
  visibleTokens,
} from "./map-space";
import { readMapState, type MapState, type MapTokenState } from "./map-state";

/** 标记的显示名：自定义标签、角色或文档名称，最后回退到标识。 */
export function tokenNames(db: SessionDatabase, state: MapState): Map<string, string> {
  const titles = new Map<string, string>();
  for (const document of frozenModule(db).documents)
    if (document.title) titles.set(documentIdentity(document.path), document.title);
  for (const character of readCharacters(db))
    if (character.sourcePath) titles.set(documentIdentity(character.sourcePath), character.name);
  return new Map(
    Object.entries(state.tokens).map(([id, token]) => [
      id,
      token.label ??
        (token.document ? (titles.get(token.document) ?? basename(token.document)) : id),
    ]),
  );
}

function place(map: ModuleMap, point: Point): string {
  const [x, y] = toUnits(map.config.grid, point);
  const regions = regionsAt(map, point).map(regionLabel);
  return `${regions.length ? regions.join("/") : "区域外"} (${x}, ${y})`;
}

function scale(map: ModuleMap): string {
  const grid = map.config.grid;
  return grid.type === "square"
    ? `方格 ${grid.distance} ${grid.unit}/格，坐标单位${grid.unit}`
    : `无网格，坐标单位${grid.unit}`;
}

const maxListedTokens = 30;

/** 每轮附带的地图位置：队伍所在地图上的标记、区域与是否在队伍视野内。 */
export function mapPositionPrompt(db: SessionDatabase): string {
  const maps = frozenModule(db).maps;
  if (!maps.length) return "";
  const state = readMapState(db);
  const party = partyIndex(db);
  const names = tokenNames(db, state);
  const lines: string[] = [];
  for (const map of maps) {
    const tokens = tokensOn(state, map.id);
    const members = tokens.filter(([, token]) => isParty(token, party));
    if (!members.length) continue;
    const room = state.maps[map.id]!;
    const visible = visibleTokens(
      map,
      state,
      party,
      partyVision(map, room, state, party).map(({ polygon }) => polygon),
    );
    const nearest = (token: MapTokenState) =>
      Math.min(...members.map(([, member]) => distance(member.at, token.at)));
    const others = tokens
      .filter(([, token]) => !isParty(token, party))
      .sort(([, a], [, b]) => nearest(a) - nearest(b));
    const describe = ([id, token]: [string, MapTokenState]) =>
      `${names.get(id)}[${id}] ${place(map, token.at)}${isParty(token, party) ? "" : visible.has(id) ? "" : token.hidden ? " 隐藏" : " 视野外"}`;
    lines.push(
      `「${map.config.name}」[${map.id}]（${scale(map)}）队伍：${members.map(describe).join("；")}${others.length ? `。其他：${others.slice(0, maxListedTokens).map(describe).join("；")}${others.length > maxListedTokens ? `；另有 ${others.length - maxListedTokens} 个较远标记` : ""}` : ""}`,
    );
  }
  return lines.length
    ? `地图位置（幕后，平台按坐标计算；与模组位置字段相互独立，需要时由你同步更新）：\n${lines.join("\n")}`
    : "";
}

/** 主持专用的移动意图说明；包含玩家不可见的区域、秘门与隐藏标记。 */
export function movementPrompt(
  db: SessionDatabase,
  messageId: string,
  intent: MovementIntent,
): string {
  const map = frozenModule(db).maps.find((item) => item.id === intent.map);
  const state = readMapState(db);
  const token = state.tokens[intent.token];
  if (!map || !token)
    return `移动意图：标记 ${intent.token} 或地图 ${intent.map} 已不存在，按文字行动裁定。`;
  const names = tokenNames(db, state);
  const path = [intent.from, ...intent.waypoints];
  const route = analyzeRoute(
    map,
    { ...state, tokens: { ...state.tokens, [intent.token]: { ...token, at: intent.from } } },
    intent.token,
    path,
  );
  const unit = map.config.grid.unit;
  const at = (value: number) => `${round(value)}${unit}处`;
  const events = route.events.map((event) => {
    switch (event.kind) {
      case "enter":
        return `${at(event.at)}进入${regionLabel(event.region)}${event.region.secret ? "（秘密区域）" : ""}`;
      case "leave":
        return `${at(event.at)}离开${regionLabel(event.region)}`;
      case "door": {
        const door = map.config.doors.find((item) => item.id === event.door)!;
        const revealed = state.maps[map.id]?.doors[event.door]?.revealed;
        return `${at(event.at)}经过门 ${event.door}（${event.open ? "开" : "关"}${door.secret ? (revealed ? "，已揭示的秘门" : "，玩家未知的秘门，对玩家等同墙") : ""}${event.narrow ? "，门宽窄于占地" : ""}）`;
      }
      case "unexplored":
        return `${at(event.at)}进入未探索区域`;
      case "blocked":
        return `${at(event.at)}被墙阻挡`;
      case "obstacle":
        return `${at(event.at)}${event.blocking ? "穿过阻挡物" : "经过"} ${names.get(event.token)}[${event.token}]${state.tokens[event.token]?.hidden ? "（隐藏）" : ""}`;
    }
  });
  const problems = [
    ...(route.events.some((event) => event.kind === "blocked") ? ["路线穿墙"] : []),
    ...(route.events.some((event) => event.kind === "obstacle" && event.blocking)
      ? ["穿过阻挡物"]
      : []),
    ...(route.events.some((event) => event.kind === "door" && event.narrow)
      ? ["通道窄于占地"]
      : []),
    ...(route.endOverlap.length
      ? [`终点与 ${route.endOverlap.map((id) => `${names.get(id)}[${id}]`).join("、")} 重叠`]
      : []),
    ...(intent.explore ? ["终点在未探索区域，只表示方向"] : []),
  ];
  const moved = !samePoint(token.at, intent.from) && token.map === intent.map;
  return [
    `移动意图（${names.get(intent.token)}[${intent.token}]，地图「${map.config.name}」[${map.id}]）：从 ${place(map, intent.from)} 经 ${intent.waypoints.length} 个路点到 ${place(map, path.at(-1)!)}，路线全长 ${round(measurePath(map.config.grid, path).total)}${unit}。`,
    events.length ? `途经：${events.join("；")}。` : "",
    problems.length ? `需注意：${problems.join("；")}。` : "",
    moved ? `该标记提交后已移动到 ${place(map, token.at)}。` : "",
    `意图只是计划，按规则与情境裁定实际结果；确认后用 map_move（intent: "${messageId}"）沿路线执行，或改为指定位置。`,
  ]
    .filter(Boolean)
    .join("");
}

function samePoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}
