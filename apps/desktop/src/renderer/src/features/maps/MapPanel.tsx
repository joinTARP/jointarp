import { mapLineage } from "@jointarp/module/map";
import { firstBlocked } from "@jointarp/module/map-geometry";
import { Footprints, Maximize2, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { GameToolDialog } from "../sessions/GameToolDialog";
import { distanceText, knownWalls, summarizePlan, useRoomMaps, type RoomMap } from "./map-model";
import { mapUi, useMapUi, type PendingRoute } from "./map-ui";
import { MapCanvas } from "./MapCanvas";

function useSelectedMap(roomId: string) {
  const model = useRoomMaps(roomId);
  const ui = useMapUi(roomId);
  const selected =
    model.maps.find((item) => item.resource.id === ui.mapId) ??
    model.maps.find((item) => item.resource.id === model.own?.map) ??
    model.maps[0];
  return { model, ui, selected };
}

/** 同一标记只显示最近一次仍从当前位置出发的意图。 */
function activeRoutes(map: RoomMap, routes: Readonly<Record<string, PendingRoute>>) {
  const latest = new Map<string, PendingRoute>();
  for (const route of Object.values(routes)) {
    if (route.map !== map.resource.id) continue;
    const token = map.view.tokens.find((item) => item.id === route.token);
    if (!token || token.at[0] !== route.from[0] || token.at[1] !== route.from[1]) continue;
    const current = latest.get(route.token);
    if (!current || current.sequence < route.sequence) latest.set(route.token, route);
  }
  return [...latest.values()];
}

function MapSwitcher({
  roomId,
  maps,
  selected,
}: {
  roomId: string;
  maps: readonly RoomMap[];
  selected: RoomMap;
}) {
  if (maps.length < 2) return <span className="min-w-0 truncate">{selected.resource.name}</span>;
  const byId = new Map(maps.map((item) => [item.resource.id, item]));
  const paths = maps
    .map(({ resource }) => ({
      id: resource.id,
      label: mapLineage(resource.id, (id) => {
        const parent = byId.get(id)?.view.parent;
        return parent && byId.has(parent) ? parent : undefined;
      })
        .map((id) => byId.get(id)!.resource.name)
        .join(" › "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh"));
  return (
    <select
      aria-label="选择地图"
      className="min-w-0 truncate bg-transparent text-xs outline-none"
      value={selected.resource.id}
      onChange={(event) =>
        mapUi.update(roomId, (state) => ({ ...state, mapId: event.target.value }))
      }
    >
      {paths.map((item) => (
        <option key={item.id} value={item.id}>
          {item.label}
        </option>
      ))}
    </select>
  );
}

/** 左侧栏的小地图；点击放大查看或规划移动。 */
export function MapPanel({ roomId }: { roomId: string }) {
  const { model, ui, selected } = useSelectedMap(roomId);
  if (!selected) return null;
  const routes = activeRoutes(selected, ui.routes);
  return (
    <section aria-label="地图" className="px-2 pt-3">
      <div className="text-muted-foreground mb-1.5 flex items-center justify-between gap-2 text-xs">
        <MapSwitcher roomId={roomId} maps={model.maps} selected={selected} />
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="放大地图"
          tooltip="放大地图"
          onClick={() => mapUi.open(roomId, { mapId: selected.resource.id })}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
      <button
        type="button"
        aria-label="放大地图"
        className="block w-full overflow-hidden rounded-lg"
        onClick={() => mapUi.open(roomId, { mapId: selected.resource.id })}
      >
        <MapCanvas
          roomId={roomId}
          map={selected}
          tokenName={model.tokenName}
          tokenPortrait={model.tokenPortrait}
          ownToken={model.own?.token.id}
          routes={routes}
          plan={ui.plan?.map === selected.resource.id ? ui.plan : undefined}
          className="aspect-[4/3] w-full"
        />
      </button>
    </section>
  );
}

/** 大图：平移缩放，规划本人角色的移动路线。 */
export function MapDialog({ roomId }: { roomId: string }) {
  const { model, ui, selected } = useSelectedMap(roomId);
  const returnToComposer = useRef(false);
  const [warning, setWarning] = useState("");
  const own = model.own;
  useEffect(() => {
    if (own) {
      mapUi.trackCharacter(roomId, own.token.id, own.map, own.token.at);
      if (own.token.relay)
        mapUi.update(roomId, (state) =>
          state.plan || state.planning ? { ...state, plan: undefined, planning: false } : state,
        );
    }
  }, [roomId, own]);
  const plan = ui.plan?.map === selected?.resource.id ? ui.plan : undefined;
  const planMap = useMemo(
    () => model.maps.find((item) => item.resource.id === plan?.map),
    [model.maps, plan?.map],
  );
  const summary = plan && planMap ? summarizePlan(planMap, plan) : undefined;
  const canPlan = Boolean(own && !own.token.relay && selected && own.map === selected.resource.id);
  const planning = ui.planning && canPlan;
  if (!selected) return null;
  const unit = selected.resource.grid.unit;

  const addWaypoint = (point: [number, number]) => {
    if (!own) return;
    const current =
      plan && plan.token === own.token.id && plan.map === own.map
        ? plan
        : { token: own.token.id, map: own.map, waypoints: [] };
    const last = current.waypoints.at(-1) ?? own.token.at;
    if (current.waypoints.length >= 50) return setWarning("路点最多 50 个");
    if (firstBlocked([last, point], knownWalls(selected.resource, selected.view)))
      return setWarning("路线不能穿过墙");
    setWarning("");
    mapUi.setPlan(roomId, { ...current, waypoints: [...current.waypoints, point] });
  };

  return (
    <GameToolDialog
      open={ui.open}
      onOpenChange={(open) => {
        if (!open) mapUi.close(roomId);
      }}
      finalFocus={() => {
        if (!returnToComposer.current) return;
        returnToComposer.current = false;
        return document.querySelector<HTMLElement>(
          `[data-room-composer="${CSS.escape(roomId)}"] [contenteditable="true"]`,
        );
      }}
      title={<MapSwitcher roomId={roomId} maps={model.maps} selected={selected} />}
      description="查看队伍已探索的地图，规划本人角色的移动。"
      wide
      headerActions={
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {planning ? (
            <>
              <span role="status" className="text-muted-foreground text-xs">
                {warning ||
                  (summary
                    ? `${plan!.waypoints.length} 个路点 · ${distanceText(summary.length, unit, summary.explore)}`
                    : "点击地图添加路点")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!plan?.waypoints.length}
                onClick={() => {
                  setWarning("");
                  plan &&
                    mapUi.setPlan(
                      roomId,
                      plan.waypoints.length > 1
                        ? { ...plan, waypoints: plan.waypoints.slice(0, -1) }
                        : undefined,
                    );
                }}
              >
                <Undo2 className="size-4" />
                撤销
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!plan}
                onClick={() => {
                  setWarning("");
                  mapUi.setPlan(roomId, undefined);
                }}
              >
                <X className="size-4" />
                清空
              </Button>
              <Button
                size="sm"
                disabled={!plan?.waypoints.length || summary?.blocked}
                onClick={() => {
                  returnToComposer.current = true;
                  mapUi.close(roomId);
                }}
              >
                添加到行动
              </Button>
            </>
          ) : canPlan ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => mapUi.update(roomId, (state) => ({ ...state, planning: true }))}
            >
              <Footprints className="size-4" />
              规划移动
            </Button>
          ) : null}
        </div>
      }
    >
      {planning ? (
        <p className="text-muted-foreground border-border/60 border-b px-6 py-2 text-xs">
          路线随行动发送，由主持裁定；规划不会立即移动角色。
        </p>
      ) : null}
      <MapCanvas
        key={selected.resource.id}
        roomId={roomId}
        map={selected}
        tokenName={model.tokenName}
        tokenPortrait={model.tokenPortrait}
        ownToken={own?.token.id}
        routes={activeRoutes(selected, ui.routes)}
        plan={plan?.map === selected.resource.id ? plan : undefined}
        planning={planning}
        interactive
        onAddWaypoint={addWaypoint}
        className="min-h-0 flex-1"
      />
    </GameToolDialog>
  );
}
