import { Menu } from "@base-ui/react/menu";
import type { Player } from "@jointarp/core/shared/game";
import type { GameSession } from "@jointarp/core/shared/session";
import type { Character } from "@jointarp/module/character";
import { useMutation } from "@tanstack/react-query";
import { MoreHorizontal, UserRound } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Tooltip } from "../../components/ui/tooltip";
import { desktopRpc } from "../../desktop-rpc";
import { useDocumentPortrait } from "../modules/document-image";
import { CharacterAvatarMenu } from "./CharacterAvatarMenu";
import { CharacterCardDialog } from "./CharacterCardDialog";
import { playerLabel } from "./player-role";
import { useRoomCompanions } from "./use-room-companions";

function PartyMember({
  character,
  nickname,
  onClick,
  onMention,
}: {
  character: Character;
  nickname?: string;
  onClick: () => void;
  onMention?: () => void;
}) {
  const portrait = useDocumentPortrait(character.sourcePath, character.avatar, character.image);
  const label =
    nickname !== undefined
      ? playerLabel(nickname, { playerId: character.playerId ?? "", name: character.name })
      : character.name;
  return (
    <CharacterAvatarMenu
      name={label}
      onOpenCard={onClick}
      onMention={onMention}
      className="hover:bg-sidebar-accent focus-visible:outline-ring flex w-full max-w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors outline-none focus-visible:outline-1 focus-visible:outline-offset-2"
    >
      <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {portrait.src ? (
          <img
            src={portrait.src}
            onError={portrait.onError}
            alt=""
            draggable={false}
            className="size-full object-cover object-top"
          />
        ) : (
          <UserRound className="size-4" aria-hidden="true" />
        )}
      </span>
      <Tooltip content={label} overflowOnly>
        <span data-overflow-text className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {label}
        </span>
      </Tooltip>
    </CharacterAvatarMenu>
  );
}

export function GameParty({
  roomId,
  session,
  characters,
  player,
  onMention,
  isHost = false,
}: {
  isHost?: boolean;
  roomId: string;
  session: GameSession;
  characters: readonly Character[];
  player?: Player;
  onMention?: (id: string) => void;
}) {
  const party = useRoomCompanions(roomId);
  const [removing, setRemoving] = useState<{ id: string; nickname: string } | null>(null);
  const action = useMutation({
    mutationFn: async ({ id, kind }: { id: string; kind: "relay" | "reclaim" | "remove" }) => {
      if (kind === "relay") await desktopRpc.sessions.companion.relay({ roomId, playerId: id });
      if (kind === "reclaim") await desktopRpc.sessions.companion.reclaim({ roomId });
      if (kind === "remove") await desktopRpc.lan.removeMember({ roomId, playerId: id });
      await party.refetch();
      if (kind === "remove") setRemoving(null);
    },
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const members = new Map(
    characters
      .filter((character) => character.playerId)
      .map((character) => [character.id, character]),
  );
  for (const seat of party.data?.seats ?? []) {
    if (!seat.companion) continue;
    const character = party.data?.characters.find(
      (item) => item.id === seat.companion?.characterId,
    )?.card;
    if (character) members.set(character.id, character);
  }
  const players = party.data?.members ?? [];
  const unbound = players.filter(
    (member) => ![...members.values()].some((character) => character.playerId === member.id),
  );
  const controls = (id: string, hasCharacter: boolean) => {
    const member = players.find((item) => item.id === id);
    if (!member) return null;
    return (
      <div className="flex min-h-6 flex-wrap items-center gap-2 px-2 pb-2 text-xs">
        <span className="text-muted-foreground">
          {member.online ? "在线" : "离线"}
          {member.relay ? " · AI 接力中" : ""}
        </span>
        {member.relay && id === player?.id ? (
          <button
            disabled={action.isPending}
            onClick={() => action.mutate({ id, kind: "reclaim" })}
          >
            {action.isPending ? "等待当前行动结束…" : "接回角色"}
          </button>
        ) : null}
        {isHost && id !== player?.id ? (
          <Menu.Root>
            <Menu.Trigger
              aria-label={`管理成员“${member.nickname}”`}
              disabled={action.isPending}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-ring ml-auto grid size-6 shrink-0 place-items-center rounded-md outline-none focus-visible:outline-1"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner
                side="bottom"
                align="end"
                sideOffset={4}
                className="z-50 outline-none"
              >
                <Menu.Popup className="border-border bg-popover text-popover-foreground min-w-40 rounded-lg border p-1 text-xs shadow-lg outline-none">
                  {!member.online && !member.relay && hasCharacter ? (
                    <Menu.Item
                      onClick={() => action.mutate({ id, kind: "relay" })}
                      className="data-highlighted:bg-muted flex cursor-default items-center rounded-md px-2.5 py-2 outline-none"
                    >
                      开启 AI 接力
                    </Menu.Item>
                  ) : null}
                  <Menu.Item
                    onClick={() => {
                      action.reset();
                      setRemoving({ id, nickname: member.nickname });
                    }}
                    className="text-destructive data-highlighted:bg-destructive/10 flex cursor-default items-center rounded-md px-2.5 py-2 outline-none"
                  >
                    移除成员
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : null}
      </div>
    );
  };
  const selected = selectedId ? members.get(selectedId) : undefined;
  return (
    <section aria-label="冒险小队" className="mb-3 flex min-w-0 flex-col">
      <div className="text-muted-foreground/65 flex shrink-0 items-center gap-2 px-2 pb-3 text-[11px] font-medium">
        <h2>冒险小队</h2>
        <span className="text-muted-foreground/45 text-[10px] tabular-nums">
          {members.size + unbound.length}
        </span>
      </div>
      <div>
        <ul className="space-y-0.5">
          {[...members.values()].map((character) => (
            <li
              key={character.id}
              className={
                players.some((member) => member.id === character.playerId && !member.online)
                  ? "opacity-50 grayscale"
                  : undefined
              }
            >
              <PartyMember
                character={character}
                nickname={
                  players.find((member) => member.id === character.playerId)?.nickname ??
                  (player && character.playerId === player.id ? player.nickname : undefined)
                }
                onMention={
                  onMention && character.playerId !== player?.id
                    ? (() => {
                        const id =
                          party.data?.seats.find(
                            (seat) => seat.companion?.characterId === character.id,
                          )?.id ?? character.playerId;
                        return id ? () => onMention(id) : undefined;
                      })()
                    : undefined
                }
                onClick={() => setSelectedId(character.id)}
              />
              {character.playerId ? controls(character.playerId, true) : null}
            </li>
          ))}
          {unbound.map((member) => (
            <li key={member.id} className={member.online ? "" : "opacity-50 grayscale"}>
              <div className="flex items-center gap-2.5 px-2 py-2">
                <span className="bg-muted flex size-9 items-center justify-center rounded-full">
                  <UserRound className="size-4" />
                </span>
                <span className="truncate text-[13px]">{member.nickname} · 未选角色</span>
              </div>
              {controls(member.id, false)}
            </li>
          ))}
        </ul>
        {action.error ? (
          <p role="alert" className="text-destructive px-2 text-xs">
            {action.error.message}
          </p>
        ) : null}
        {members.size + unbound.length === 0 ? (
          <p role="status" className="text-muted-foreground px-3 py-2 text-xs">
            {party.isPending ? "正在读取小队…" : "暂无入队角色"}
          </p>
        ) : null}
        {party.error ? (
          <button
            type="button"
            className="text-destructive px-3 py-2 text-xs"
            onClick={() => void party.refetch()}
          >
            队友读取失败，点击重试
          </button>
        ) : null}
      </div>
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !action.isPending) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>移除成员“{removing?.nickname}”？</DialogTitle>
            <DialogDescription>
              该成员将离开小队并解除角色绑定，再次加入需要房主重新批准。
            </DialogDescription>
          </DialogHeader>
          {action.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={action.isPending} onClick={() => setRemoving(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() => removing && action.mutate({ id: removing.id, kind: "remove" })}
            >
              {action.isPending ? "正在移除…" : "移除成员"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CharacterCardDialog
        character={selected}
        session={session}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      />
    </section>
  );
}
