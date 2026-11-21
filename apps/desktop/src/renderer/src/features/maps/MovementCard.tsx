import type { MovementIntent } from "@jointarp/core/shared/map";
import { Footprints } from "lucide-react";
import { useEffect } from "react";

import { distanceText, useRoomMaps } from "./map-model";
import { mapUi } from "./map-ui";

/** 行动消息下方的移动意图卡；实际结果以地图和主持叙述为准。 */
export function MovementCard({
  roomId,
  messageId,
  sequence,
  intent,
  submitted,
}: {
  roomId: string;
  messageId: string;
  sequence: number;
  intent: MovementIntent;
  submitted: boolean;
}) {
  const model = useRoomMaps(roomId);
  const progress = model.intents[messageId];
  const pending = submitted && progress === undefined;
  useEffect(() => {
    if (!pending) return;
    mapUi.showRoute(roomId, {
      messageId,
      sequence,
      token: intent.token,
      map: intent.map,
      from: intent.from,
      waypoints: intent.waypoints,
    });
    return () => mapUi.hideRoute(roomId, messageId);
  }, [pending, roomId, messageId, sequence, intent]);
  const map = model.maps.find((item) => item.resource.id === intent.map);
  const currentMap = model.maps.find((item) => item.view.tokens.some((t) => t.id === intent.token));
  const token = currentMap?.view.tokens.find((item) => item.id === intent.token);
  const name = token ? model.tokenName(token) : intent.token.split("/").at(-1);
  const status = !submitted
    ? "已改为聊天，未提交"
    : progress === undefined
      ? "等待主持裁定"
      : intent.length === null
        ? `已走 ${progress} ${intent.unit}`
        : `已走 ${progress} / ${intent.length} ${intent.unit}`;
  return (
    <button
      type="button"
      disabled={!currentMap && !map}
      onClick={() =>
        mapUi.open(roomId, { mapId: currentMap?.resource.id ?? intent.map, center: token?.at })
      }
      className="border-border/70 bg-muted/40 hover:bg-muted/70 disabled:hover:bg-muted/40 mt-2 flex w-full max-w-sm items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default"
    >
      <Footprints aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {name} · {intent.waypoints.length} 个路点 ·{" "}
          {distanceText(intent.length, intent.unit, intent.explore)}
        </span>
        <span className="text-muted-foreground block text-xs">
          {map ? `${map.resource.name} · ` : ""}
          {status}
        </span>
      </span>
    </button>
  );
}
