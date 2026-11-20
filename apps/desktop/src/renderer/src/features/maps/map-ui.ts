import type { MovementIntentInput } from "@jointarp/core/shared/map";
import type { MapPoint } from "@jointarp/module/map";
import { useSyncExternalStore } from "react";

export type MovementPlan = MovementIntentInput;

/** 已发送且主持尚未执行的意图，用于在地图上画出虚线路线。 */
export interface PendingRoute {
  readonly messageId: string;
  readonly sequence: number;
  readonly token: string;
  readonly map: string;
  readonly from: MapPoint;
  readonly waypoints: readonly MapPoint[];
}

export interface MapCamera {
  readonly center: MapPoint;
  readonly scale: number;
}

interface RoomMapUi {
  readonly cameras: Readonly<Record<string, MapCamera>>;
  readonly open: boolean;
  readonly planning: boolean;
  readonly mapId?: string;
  readonly plan?: MovementPlan;
  readonly routes: Readonly<Record<string, PendingRoute>>;
}

const initial: RoomMapUi = { open: false, planning: false, routes: {}, cameras: {} };
const rooms = new Map<string, RoomMapUi>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 地图面板、大图与输入框共用的房间内界面状态，不写入存档。 */
export const mapUi = {
  get(roomId: string): RoomMapUi {
    return rooms.get(roomId) ?? initial;
  },
  update(roomId: string, change: (state: RoomMapUi) => RoomMapUi) {
    const current = mapUi.get(roomId);
    const next = change(current);
    if (next === current) return;
    rooms.set(roomId, next);
    for (const listener of listeners) listener();
  },
  open(roomId: string, options: { mapId?: string; planning?: boolean; center?: MapPoint } = {}) {
    mapUi.update(roomId, (state) => ({
      ...state,
      open: true,
      cameras:
        options.mapId && options.center
          ? {
              ...state.cameras,
              [options.mapId]: {
                center: options.center,
                scale: state.cameras[options.mapId]?.scale ?? 1,
              },
            }
          : state.cameras,
      planning: options.planning ?? state.planning,
      mapId: options.mapId ?? state.mapId,
    }));
  },
  close(roomId: string) {
    mapUi.update(roomId, (state) => ({ ...state, open: false, planning: false }));
  },
  setPlan(roomId: string, plan: MovementPlan | undefined) {
    mapUi.update(roomId, (state) => (state.plan === plan ? state : { ...state, plan }));
  },
  showRoute(roomId: string, route: PendingRoute) {
    mapUi.update(roomId, (state) =>
      state.routes[route.messageId]
        ? state
        : { ...state, routes: { ...state.routes, [route.messageId]: route } },
    );
  },
  hideRoute(roomId: string, messageId: string) {
    mapUi.update(roomId, (state) => {
      if (!state.routes[messageId]) return state;
      const { [messageId]: _removed, ...routes } = state.routes;
      return { ...state, routes };
    });
  },
};

export function useMapUi(roomId: string): RoomMapUi {
  return useSyncExternalStore(subscribe, () => mapUi.get(roomId));
}
