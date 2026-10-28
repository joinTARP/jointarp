import type { CompanionModel } from "@jointarp/core/shared/companion";
import type { CompanionInitiative } from "@jointarp/core/shared/companion-initiative";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings, UserRound, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip } from "../../components/ui/tooltip";
import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { useDocumentImage } from "../modules/document-image";
import { CompanionSettingsDialog } from "./CompanionSettingsDialog";
import { useRoomCompanions } from "./use-room-companions";
import { useRoomLaunch } from "./use-room-state";

type Settings = Awaited<ReturnType<typeof desktopRpc.sessions.companion.get>>;
type Character = Settings["characters"][number];
type Seat = Settings["seats"][number];
type Operation =
  | { action: "recruit"; id?: string; characterId: string }
  | { action: "assign"; id: string; characterId: string }
  | { action: "remove"; id: string };

function available(character: Character, seatId?: string) {
  return (
    character.playable &&
    character.aiConfigured &&
    !character.controllerId &&
    (!character.reservedBy || character.reservedBy === seatId)
  );
}

function Portrait({ name, image, path }: { name: string; image?: string; path?: string | null }) {
  const src = useDocumentImage(path, image);
  return src ? (
    <img src={src} alt="" draggable={false} className="size-full object-cover object-top" />
  ) : (
    <div className="text-muted-foreground/70 grid size-full place-items-center">
      <UserRound className="size-8" aria-hidden="true" />
      <span className="sr-only">{name}</span>
    </div>
  );
}

function SlotFrame({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-muted ring-foreground/10 relative aspect-[3/4] w-44 overflow-hidden rounded-2xl shadow-[0_12px_32px_-20px_rgba(0,0,0,0.7)] ring-1 ${className}`}
    >
      {children}
    </div>
  );
}

function SlotCaption({
  name,
  label,
  reserveAction = false,
}: {
  name: string;
  label: string;
  reserveAction?: boolean;
}) {
  return (
    <div
      className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/35 to-transparent px-3.5 pt-12 pb-3.5 ${reserveAction ? "pr-11" : ""}`}
    >
      <Tooltip content={name} overflowOnly>
        <p className="truncate text-sm font-medium text-white">{name}</p>
      </Tooltip>
      <Tooltip content={label} overflowOnly>
        <p className="mt-0.5 truncate text-[11px] text-white/70">{label}</p>
      </Tooltip>
    </div>
  );
}

function FilledSlot({
  roomId,
  companionId,
  character,
  model,
  initiative,
  documentAccess,
  busy,
  onRemove,
}: {
  roomId: string;
  companionId: string;
  character: Character | undefined;
  model?: CompanionModel;
  initiative?: CompanionInitiative;
  documentAccess?: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const [configuring, setConfiguring] = useState(false);
  const name = character?.name ?? "原角色";
  return (
    <li>
      <SlotFrame>
        <Portrait name={name} image={character?.image} path={character?.card?.sourcePath} />
        <button
          type="button"
          className="absolute top-2 right-2 z-10 grid size-7 place-items-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm outline-none hover:bg-black/65 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50"
          aria-label={`移出${name}`}
          disabled={busy}
          onClick={onRemove}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
        <SlotCaption
          name={name}
          label={
            character && !character.aiConfigured ? "缺少预设" : (model?.name ?? "跟随冒险模型")
          }
          reserveAction
        />
        <button
          type="button"
          className="absolute right-2 bottom-2.5 z-10 grid size-7 place-items-center rounded-full bg-black/45 text-white/90 backdrop-blur-sm outline-none hover:bg-black/65 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white"
          aria-label={`设置${name}`}
          onClick={() => setConfiguring(true)}
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </button>
      </SlotFrame>
      <CompanionSettingsDialog
        roomId={roomId}
        companionId={companionId}
        name={name}
        model={model}
        initiative={initiative}
        documentAccess={documentAccess}
        open={configuring}
        onOpenChange={setConfiguring}
      />
    </li>
  );
}

function PendingSlot({
  character,
  busy,
  onConfirm,
  onCancel,
}: {
  character: Character | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const name = character?.name ?? "未命名角色";
  return (
    <li>
      <SlotFrame className="ring-ring">
        <Portrait name={name} image={character?.image} path={character?.card?.sourcePath} />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pt-12 pb-3">
          <Tooltip content={name} overflowOnly>
            <p className="truncate text-sm font-medium text-white">{name}</p>
          </Tooltip>
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="h-7 flex-1 px-2 text-xs"
              disabled={busy}
              onClick={onConfirm}
            >
              入队
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="h-7 bg-white/15 px-2 text-xs text-white hover:bg-white/25"
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </Button>
          </div>
        </div>
      </SlotFrame>
    </li>
  );
}

export function RoomCompanionSettings({ roomId }: { roomId: string }) {
  const client = useQueryClient();
  const options = desktopOrpc.sessions.companion.get.queryOptions({ input: { roomId } });
  const query = useRoomCompanions(roomId);
  const player = useQuery(desktopOrpc.player.get.queryOptions());
  const launch = useRoomLaunch(roomId);
  const mutation = useMutation({
    mutationFn: async (operation: Operation) => {
      if (operation.action === "recruit") {
        const selected = await desktopRpc.sessions.companion.select({
          roomId,
          id: operation.id,
          characterId: operation.characterId,
        });
        const seat = selected.seats.find(
          (item) => !item.companion && item.reservedCharacterId === operation.characterId,
        );
        if (!seat) return selected;
        return desktopRpc.sessions.companion.save({
          roomId,
          id: seat.id,
          companion: { characterId: operation.characterId },
        });
      }
      if (operation.action === "assign")
        return desktopRpc.sessions.companion.save({
          roomId,
          id: operation.id,
          companion: { characterId: operation.characterId },
        });
      return desktopRpc.sessions.companion.save({ roomId, id: operation.id, companion: null });
    },
    onSuccess: async (value) => {
      await client.cancelQueries({ queryKey: options.queryKey });
      setPicking(false);
      client.setQueryData(options.queryKey, value);
      void client.invalidateQueries(
        desktopOrpc.sessions.load.queryOptions({ input: { id: roomId } }),
      );
    },
    onError: () => {
      void query.refetch();
    },
  });
  const [picking, setPicking] = useState(false);
  const settings = query.data;
  const assigned =
    settings?.seats.filter(
      (seat) => seat.companion && !settings.members.some((member) => member.id === seat.id),
    ) ?? [];
  const pending = settings?.seats.filter((seat) => !seat.companion) ?? [];
  const held = pending.filter((seat) => seat.reservedCharacterId);
  const blank = pending.find((seat) => !seat.reservedCharacterId);
  const self = launch.data?.characters.find((item) => item.playerId === player.data?.id);
  const choices = settings?.characters.filter((item) => available(item, blank?.id)) ?? [];
  const playable = settings?.characters.filter((item) => item.playable) ?? [];
  const unavailable =
    playable.length === 0
      ? { label: "暂无角色", detail: "当前开局没有可用的预设角色。" }
      : playable.some((item) => item.aiConfigured)
        ? { label: "角色已被占用", detail: "可由 AI 扮演的角色均已被选择或加入小队。" }
        : {
            label: "缺少 AI 预设",
            detail: "当前冒险的模组未配置 AI 队友预设。请使用包含预设的模组新建冒险。",
          };

  return (
    <section aria-label="小队槽位">
      {query.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          正在读取队友…
        </p>
      ) : settings ? (
        <>
          <ul className="flex flex-wrap items-start gap-4">
            {launch.isSuccess ? (
              <li>
                <SlotFrame>
                  <Portrait name={self?.name ?? "你"} image={self?.image} path={self?.sourcePath} />
                  <SlotCaption name={self?.name ?? "你"} label={self ? "你" : "尚未选择角色"} />
                </SlotFrame>
              </li>
            ) : null}
            {assigned.map((seat) => (
              <FilledSlot
                key={seat.id}
                roomId={roomId}
                companionId={seat.id}
                character={characterOf(settings, seat)}
                model={seat.companion?.model}
                initiative={seat.companion?.initiative}
                documentAccess={seat.companion?.documentAccess}
                busy={mutation.isPending}
                onRemove={() => mutation.mutate({ action: "remove", id: seat.id })}
              />
            ))}
            {held.map((seat) => {
              const character = settings.characters.find(
                (item) => item.id === seat.reservedCharacterId,
              );
              return (
                <PendingSlot
                  key={seat.id}
                  character={character}
                  busy={mutation.isPending}
                  onConfirm={() => {
                    if (seat.reservedCharacterId)
                      mutation.mutate({
                        action: "assign",
                        id: seat.id,
                        characterId: seat.reservedCharacterId,
                      });
                  }}
                  onCancel={() => mutation.mutate({ action: "remove", id: seat.id })}
                />
              );
            })}
            {held.length === 0 ? (
              <li>
                <Tooltip content={choices.length ? "选择角色加入小队" : unavailable.detail}>
                  <button
                    type="button"
                    className={`focus-visible:outline-ring flex aspect-[3/4] w-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50 ${picking ? "border-foreground/40 bg-foreground/5 text-foreground" : "border-foreground/15 bg-foreground/[0.03] text-muted-foreground hover:border-foreground/30 hover:text-foreground"}`}
                    disabled={mutation.isPending || choices.length === 0}
                    aria-expanded={picking}
                    aria-controls="party-candidates"
                    onClick={() => setPicking((open) => !open)}
                  >
                    <Plus className="size-5" strokeWidth={1.5} aria-hidden="true" />
                    <span className="text-xs">{choices.length ? "空位" : unavailable.label}</span>
                  </button>
                </Tooltip>
              </li>
            ) : null}
          </ul>
          {held.length === 0 && choices.length === 0 ? (
            <p role="status" className="text-muted-foreground mt-4 text-sm">
              {unavailable.detail}
            </p>
          ) : null}
          {picking && held.length === 0 && choices.length ? (
            <div id="party-candidates" className="mt-6">
              <p className="text-muted-foreground mb-3 text-xs">选择角色加入空位</p>
              <ul className="flex flex-wrap gap-3">
                {choices.map((character) => (
                  <li key={character.id}>
                    <button
                      type="button"
                      className="bg-muted ring-foreground/10 focus-visible:outline-ring relative aspect-[3/4] w-28 overflow-hidden rounded-xl text-left ring-1 transition-transform outline-none hover:scale-[1.03] focus-visible:outline-1 focus-visible:outline-offset-2 disabled:opacity-50 motion-reduce:transition-none"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          action: "recruit",
                          id: blank?.id,
                          characterId: character.id,
                        })
                      }
                    >
                      <Portrait
                        name={character.name}
                        image={character.image}
                        path={character.card?.sourcePath}
                      />
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 to-transparent px-2 pt-6 pb-2 text-xs font-medium text-white">
                        {character.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      {query.error || mutation.error ? (
        <div role="alert" className="text-destructive mt-4 text-sm">
          {query.error?.message ?? mutation.error?.message}
          <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
            重新读取
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function characterOf(settings: Settings, seat: Seat) {
  return settings.characters.find((item) => item.id === seat.companion?.characterId);
}
