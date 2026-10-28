import {
  companionInputSchema,
  companionModelSchema,
  type CompanionInput,
  type CompanionModel,
} from "../../../shared/companion";
import {
  companionInitiativeSchema,
  type CompanionInitiative,
} from "../../../shared/companion-initiative";
import type { Player } from "../../../shared/game";
import { ttsVoiceOverrideSchema, type TtsVoiceOverride } from "../../../shared/voice";
import { createIdentityId } from "../../identity";
import {
  readAdventureState,
  updateAdventureState,
  markStateChanged,
} from "../../sessions/adventure-state";
import { readCharacters } from "../../sessions/character-db";
import {
  claimCharacter,
  clearCompanionSelection,
  isPlayableCharacter,
  selectCompanionCharacter,
  selectedCompanionCharacter,
} from "../../sessions/character-ownership";
import {
  allLaunchProgress,
  readLaunchRoom,
  saveLaunchProgress,
  saveLaunchRoom,
} from "../../sessions/launch-db";
import { readRoomSettings } from "../../sessions/room-settings";
import type { CompanionSeat } from "../../sessions/room-storage";
import { roomDirectoryForDatabase } from "../../sessions/session-paths";
import { companionCharacters, moduleCompanionPrompt, readCompanions } from "../companion";
import type { ChatContext, RoomState } from "./types";
type CompanionContext = Pick<ChatContext, "state" | "store" | "activity">;

/** 队友席位、控制权和个人设置。 */
export class ChatCompanions {
  constructor(private readonly context: CompanionContext) {}

  async companionSettings(roomId: string) {
    const state = await this.context.state(roomId);
    const companions = readCompanions(state.db);
    const storedCharacters = new Map(readCharacters(state.db).map((item) => [item.id, item]));
    const seats = readAdventureState(state.db).party.companions.map((seat) => {
      const id = seat.id;
      const selected = selectedCompanionCharacter(seat);
      return {
        id,
        companion: companions.find((item) => item.id === id) ?? null,
        reservedCharacterId: selected,
      };
    });
    return {
      members: readAdventureState(state.db).party.members.map((member) => ({
        ...member,
        online: this.context.activity.players(state).some((player) => player.id === member.id),
      })),
      seats,
      characters: (await companionCharacters(state.db))
        .filter(
          (item) =>
            item.playable || companions.some((companion) => companion.characterId === item.id),
        )
        .map(
          ({
            id,
            name,
            description,
            body,
            image,
            avatar,
            values,
            controllerId,
            reservedBy,
            playable,
            aiConfigured,
          }) => {
            const stored = storedCharacters.get(id);
            return {
              id,
              name,
              description,
              image,
              avatar,
              controllerId,
              reservedBy,
              playable,
              aiConfigured,
              card: stored
                ? {
                    id,
                    typeId: stored.typeId,
                    playerId: controllerId,
                    sourcePath: stored.sourcePath,
                    name,
                    description,
                    body,
                    image,
                    avatar,
                    values,
                    version: stored.version,
                  }
                : undefined,
            };
          },
        ),
    };
  }

  private async configureCompanions(
    roomId: string,
    operation: (state: RoomState) => void | Promise<void>,
  ) {
    const state = await this.context.state(roomId);
    const finishConfiguration = this.context.activity.beginConfiguration(state);
    try {
      await operation(state);
      return await this.companionSettings(roomId);
    } finally {
      finishConfiguration();
    }
  }

  async setRelay(roomId: string, playerId: string, enabled: boolean) {
    const state = await this.context.state(roomId);
    const finish = enabled
      ? this.context.activity.beginConfiguration(state)
      : this.context.activity.beginHandoff(state);
    try {
      // 后续队友行动通过回应队列启动；交接锁使队列等到控制权切换完成。
      if (!enabled) await this.context.activity.running(state)?.done;
      this.context.store.transaction(state, () => {
        const adventure = readAdventureState(state.db);
        const member = adventure.party.members.find((item) => item.id === playerId);
        if (!member) throw new Error("成员不存在");
        if (member.relay === enabled) return;
        if (
          enabled &&
          this.context.activity.players(state).some((player) => player.id === playerId)
        )
          throw new Error("成员在线时不能开启 AI 接力");
        const character = readCharacters(state.db).find(
          (item) => item.playerId === playerId && !item.retired,
        );
        if (enabled && !character) throw new Error("成员尚未选择角色");
        const defaults = readRoomSettings(roomDirectoryForDatabase(state.db)).companion;
        updateAdventureState(state.db, (current) => {
          current.party.members.find((item) => item.id === playerId)!.relay = enabled;
          current.party.companions = current.party.companions.filter(
            (seat) => seat.id !== playerId,
          );
          if (enabled)
            current.party.companions.push({
              id: playerId,
              status: "active",
              characterId: character!.id,
              joinedSequence: 0,
              model: defaults.model,
              initiative: structuredClone(defaults.initiative),
              documentAccess: defaults.documentAccess,
              voice: null,
              defaultVoice: defaults.voice,
            });
        });
        markStateChanged(state.db);
      });
    } finally {
      finish();
    }
  }

  async removeMember(roomId: string, playerId: string) {
    return this.configureCompanions(roomId, (state) =>
      this.context.store.transaction(state, () => {
        updateAdventureState(state.db, (current) => {
          current.party.members = current.party.members.filter((member) => member.id !== playerId);
          current.party.companions = current.party.companions.filter(
            (seat) => seat.id !== playerId,
          );
          for (const character of current.party.characters)
            if (character.playerId === playerId) character.playerId = null;
          delete current.launch.players[playerId];
        });
        markStateChanged(state.db);
      }),
    );
  }

  async selectCompanion(roomId: string, characterId: string, seatId?: string) {
    return this.configureCompanions(roomId, (state) =>
      this.context.store.transaction(state, () => {
        const character = readCharacters(state.db).find((item) => item.id === characterId);
        if (!character || !isPlayableCharacter(state.db, character))
          throw new Error("只能选择当前开局允许的玩家角色，不能直接接管 NPC");
        if (!moduleCompanionPrompt(state.db, character))
          throw new Error("模组没有为此角色预设 AI 提示词");
        const pending = seatId
          ? readAdventureState(state.db).party.companions.find((seat) => seat.id === seatId)
          : readAdventureState(state.db).party.companions.find((seat) => seat.status === "empty");
        if (seatId && (!pending || pending.status === "active"))
          throw new Error("角色已分配或选择已取消，请刷新");
        const adventure = readAdventureState(state.db);
        const id =
          pending?.id ??
          createIdentityId([
            ...adventure.party.companions.map((seat) => seat.id),
            ...adventure.party.characters.flatMap((character) =>
              character.playerId ? [character.playerId] : [],
            ),
            ...Object.keys(adventure.launch.players),
          ]);
        if (!pending)
          updateAdventureState(state.db, (selection) => {
            selection.party.companions.push({ id, status: "empty" });
          });
        selectCompanionCharacter(state.db, characterId, id);
      }),
    );
  }

  async saveCompanion(roomId: string, id: string, input: CompanionInput | null, _player: Player) {
    return this.configureCompanions(roomId, async (state) => {
      const seat = readAdventureState(state.db).party.companions.find((seat) => seat.id === id);
      if (!seat) throw new Error("队友席位不存在，请刷新");
      if (readAdventureState(state.db).party.members.some((member) => member.id === id))
        throw new Error("请通过成员的接力入口操作");
      const before = seat.status === "active" ? seat : undefined;
      const value = input ? companionInputSchema.parse(input) : null;
      if (value) {
        const character = readCharacters(state.db).find((item) => item.id === value.characterId);
        if (!character || !isPlayableCharacter(state.db, character))
          throw new Error("只能选择当前开局允许的玩家角色，不能直接接管 NPC");
        if (!moduleCompanionPrompt(state.db, character))
          throw new Error("模组没有为此角色预设 AI 提示词");
        if (before && before.characterId !== value.characterId)
          throw new Error("队友已确认；更换角色请移除后重新添加");
        if (before && character.playerId !== id) throw new Error("角色控制权已变化，请刷新");
      }
      const defaults =
        value && !before
          ? readRoomSettings(roomDirectoryForDatabase(state.db)).companion
          : undefined;
      const companion = value
        ? {
            ...value,
            status: "active" as const,
            model: before ? before.model : defaults!.model,
            initiative: before?.initiative ?? structuredClone(defaults!.initiative),
            documentAccess: before ? before.documentAccess : defaults!.documentAccess,
            voice: before?.voice ?? null,
            defaultVoice: before ? before.defaultVoice : defaults!.voice,
            id,
            joinedSequence:
              before?.joinedSequence ??
              Number(
                state.db.get(
                  state.db.query
                    .selectFrom("chat_messages")
                    .select((eb) =>
                      eb.fn.coalesce(eb.fn.max<number>("sequence"), eb.val(0)).as("n"),
                    ),
                )!.n,
              ),
          }
        : null;
      this.context.store.transaction(state, () => {
        if (!companion) {
          updateAdventureState(state.db, (selection) => {
            for (const character of selection.party.characters)
              if (character.playerId === id) character.playerId = null;
          });
          clearCompanionSelection(state.db, id);
          updateAdventureState(state.db, (selection) => {
            selection.party.companions = selection.party.companions.filter(
              (seat) => seat.id !== id,
            );
          });
          markStateChanged(state.db);
          return;
        }
        if (!before) {
          claimCharacter(state.db, companion.characterId, id);
          // 和真人确认一样锁定当前开局，避免已加入的角色被切到不允许它的开局。
          const room = readLaunchRoom(state.db);
          if (!room.locked) {
            room.locked = true;
            room.revision++;
            saveLaunchRoom(state.db, room);
            for (const [playerId, progress] of allLaunchProgress(state.db)) {
              if (progress.stage === "start") {
                progress.stage = "character";
                progress.revision++;
                saveLaunchProgress(state.db, playerId, progress);
              }
            }
          }
        }
        updateAdventureState(state.db, (selection) => {
          const index = selection.party.companions.findIndex((seat) => seat.id === id);
          selection.party.companions[index] = companion;
        });
        markStateChanged(state.db);
      });
    });
  }

  async setCompanionModel(roomId: string, id: string, model: CompanionModel | null) {
    const state = await this.context.state(roomId);
    const selection = model ? companionModelSchema.parse(model) : null;
    this.updateCompanionSettings(state, id, (current) => ({ ...current, model: selection }));
    return this.companionSettings(roomId);
  }

  async setCompanionInitiative(roomId: string, id: string, initiative: CompanionInitiative) {
    const parsed = companionInitiativeSchema.parse(initiative);
    if (parsed.level === "custom" && !parsed.prompt) throw new Error("请填写自定义提示词");
    const state = await this.context.state(roomId);
    this.updateCompanionSettings(state, id, (current) => ({ ...current, initiative: parsed }));
    return this.companionSettings(roomId);
  }

  async setCompanionDocumentAccess(roomId: string, id: string, enabled: boolean) {
    const state = await this.context.state(roomId);
    this.updateCompanionSettings(state, id, (current) => ({ ...current, documentAccess: enabled }));
    return this.companionSettings(roomId);
  }

  async setCompanionVoice(roomId: string, id: string, voice: TtsVoiceOverride | null) {
    const parsed = voice === null ? null : ttsVoiceOverrideSchema.parse(voice);
    const state = await this.context.state(roomId);
    this.updateCompanionSettings(state, id, (current) => ({ ...current, voice: parsed }));
    return this.companionSettings(roomId);
  }

  private updateCompanionSettings(
    state: RoomState,
    id: string,
    change: (
      companion: Extract<CompanionSeat, { status: "active" }>,
    ) => Extract<CompanionSeat, { status: "active" }>,
  ) {
    this.context.store.transaction(state, () => {
      updateAdventureState(state.db, (current) => {
        const index = current.party.companions.findIndex((seat) => seat.id === id);
        const seat = current.party.companions[index];
        if (!seat || seat.status !== "active") throw new Error("队友席位不存在，请刷新");
        current.party.companions[index] = change(seat);
      });
    });
  }
}
