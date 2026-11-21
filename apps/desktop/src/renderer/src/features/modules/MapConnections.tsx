import {
  mapStartSchema,
  type MapConfig,
  type MapPoint,
  type ModuleMap,
} from "@jointarp/module/map";
import type { MapEdit } from "@shared/map-vertex";
import { useState } from "react";

import { Button } from "../../components/ui/button";

export function MapConnections({
  map,
  maps,
  config,
  point,
  commit,
}: {
  map: ModuleMap;
  maps: readonly ModuleMap[];
  config: MapConfig;
  point?: MapPoint;
  commit: (edit: MapEdit) => void;
}) {
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [arrivalId, setArrivalId] = useState("");
  const [oneWay, setOneWay] = useState(false);
  const targets = maps.filter((item) => item.id !== map.id && item.config.starts.length);
  const target = targets.find((item) => item.id === targetId) ?? targets[0];
  const from = config.starts.find((item) => item.id === sourceId) ?? config.starts[0];
  const to =
    target?.config.starts.find((item) => item.id === arrivalId) ?? target?.config.starts[0];
  const id = name.trim();
  const start = mapStartSchema.safeParse({ id, name: id, at: point });
  const used = [...config.starts, ...config.regions, ...config.tokens, ...config.doors].some(
    (item) => item.id === id,
  );
  const paired =
    target &&
    from &&
    to &&
    (config.connections.some(
      (link) => link.from === from.id && link.map === target.id && link.to === to.id,
    ) ||
      target.config.connections.some(
        (link) => !link.oneWay && link.from === to.id && link.map === map.id && link.to === from.id,
      ));
  return (
    <section
      aria-label="跨图出入口"
      className="[&_select]:bg-background space-y-3 border-t pt-3 [&_select]:mt-1 [&_select]:block [&_select]:w-full [&_select]:rounded-md [&_select]:border [&_select]:p-1.5"
    >
      <h3 className="font-medium">跨图出入口</h3>
      <p className="text-muted-foreground text-xs">
        {point ? `选点 (${point.join(", ")}) · 可添加为起点` : "点击底图，选择新起点的位置。"}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="新起点名称"
          placeholder="例如：东侧楼梯"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          className="bg-background w-full rounded-md border p-1.5"
        />
        <Button
          disabled={!start.success || used}
          onClick={() => {
            if (start.success) {
              commit({ kind: "start", start: start.data });
              setSourceId(id);
              setName("");
            }
          }}
        >
          在选点添加起点
        </Button>
        {used && <span role="status">名称已被使用</span>}
        {point && id && !used && !start.success && (
          <span role="status">名称不能包含空白、斜杠、# 或 ?。</span>
        )}
      </div>
      {(!from || !target) && (
        <p className="text-muted-foreground text-xs">
          {!from
            ? "先为本图添加起点，再与其他地图配对。"
            : "在另一张地图添加并保存起点后，即可配对。"}
        </p>
      )}
      {from && target && to && (
        <div className="grid gap-2 border-t pt-3">
          <label>
            本图起点{" "}
            <select value={from.id} onChange={(e) => setSourceId(e.target.value)}>
              {config.starts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            目标地图{" "}
            <select
              value={target.id}
              onChange={(e) => {
                setTargetId(e.target.value);
                setArrivalId("");
              }}
            >
              {targets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.config.name} · {m.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            抵达起点{" "}
            <select value={to.id} onChange={(e) => setArrivalId(e.target.value)}>
              {target.config.starts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input type="checkbox" checked={oneWay} onChange={(e) => setOneWay(e.target.checked)} />{" "}
            单向
          </label>
          <Button
            disabled={!!paired}
            onClick={() =>
              commit({
                kind: "connect",
                link: { from: from.id, map: target.id, to: to.id, oneWay },
              })
            }
          >
            {paired ? "已配对" : "配对出入口"}
          </Button>
        </div>
      )}
      {config.connections.map((link, index) => (
        <div className="flex items-center gap-2" key={index}>
          {link.from} {link.oneWay ? "→" : "↔"} {link.map} / {link.to}
          <Button size="sm" variant="ghost" onClick={() => commit({ kind: "disconnect", index })}>
            解除配对
          </Button>
        </div>
      ))}
      {maps.flatMap((owner) =>
        owner.config.connections
          .filter((link) => link.map === map.id)
          .map((link) => (
            <p key={JSON.stringify([owner.id, link.from, link.to])}>
              {owner.id} / {link.from} {link.oneWay ? "→" : "↔"} {link.to}（在「{owner.id}」编辑）
            </p>
          )),
      )}
    </section>
  );
}
