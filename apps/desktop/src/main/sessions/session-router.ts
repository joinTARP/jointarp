import {
  bindModuleSource,
  checkModuleUpdate,
  readModuleSource,
} from "@jointarp/core/node/sessions/module-sync";
import { roomDisplaySettings } from "@jointarp/core/node/sessions/room-display-settings";
import { readRoomSettings, patchRoomSettings } from "@jointarp/core/node/sessions/room-settings";
import { roomDirectory, createSession } from "@jointarp/core/node/sessions/session-store";
import {
  compactionRoleSchema,
  compactionSettingsSchema,
} from "@jointarp/core/shared/compaction-settings";
import { companionInputSchema } from "@jointarp/core/shared/companion";
import { companionInitiativeSchema } from "@jointarp/core/shared/companion-initiative";
import { thinkingLevelSchema } from "@jointarp/core/shared/game";
import { roomConfigurationPatchSchema } from "@jointarp/core/shared/game-defaults";
import { identityIdSchema } from "@jointarp/core/shared/identity";
import { ORPCError } from "@orpc/server";
import { ttsVoiceOverrideSchema } from "@shared/tts";
import { z } from "zod";

import { assertAbsolutePath } from "../config/app-config";
import { desktopProcedure as procedure } from "../desktop-rpc-context";
import { resolveModuleRoot } from "../modules/module-root";
import { showPathPicker, type PathPickerOptions } from "../native-dialog";
import {
  listLocalSessions,
  loadLocalSession,
  loadLocalSessionModuleResources,
} from "./local-room-resources";
import { roomNotesRouter } from "./room-notes-router";

const moduleProcedure = procedure.use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    throw new ORPCError("PRECONDITION_FAILED", {
      message: error instanceof Error ? error.message : "无法同步模组，请重试",
    });
  }
});

export const sessionRouter = {
  settings: {
    get: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) =>
        readRoomSettings(roomDirectory(context.sessionsRoot, input.roomId)),
      ),
    update: procedure
      .input(z.object({ roomId: z.string().uuid(), patch: roomConfigurationPatchSchema }))
      .handler(({ context, input }) =>
        patchRoomSettings(roomDirectory(context.sessionsRoot, input.roomId), input.patch),
      ),
  },
  module: {
    source: moduleProcedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => readModuleSource(context.sessionsRoot, input.roomId)),
    selectSource: moduleProcedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(async ({ context, input }) => {
        const options: PathPickerOptions = {
          title: "选择同步模组来源",
          properties: ["openDirectory"],
        };
        const selection = await showPathPicker(options);
        if (selection.canceled || !selection.filePaths[0]) return null;
        const path = await resolveModuleRoot(selection.filePaths[0]);
        return bindModuleSource(context.sessionsRoot, input.roomId, path);
      }),
    checkUpdate: moduleProcedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => checkModuleUpdate(context.sessionsRoot, input.roomId)),
    sync: moduleProcedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => context.chat.syncModule(input.roomId)),
    resources: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) =>
        loadLocalSessionModuleResources(context.sessionsRoot, input.roomId),
      ),
  },
  companion: {
    relay: procedure
      .input(z.object({ roomId: z.string().uuid(), playerId: identityIdSchema }))
      .handler(({ context, input }) => {
        if (!context.isHost) throw new Error("请由房主开启 AI 接力");
        return context.chat.setMemberRelay(input.roomId, input.playerId, true);
      }),
    reclaim: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) =>
        context.chat.setMemberRelay(input.roomId, context.player.id, false),
      ),

    select: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          characterId: identityIdSchema,
          id: identityIdSchema.optional(),
        }),
      )
      .handler(({ context, input }) =>
        context.chat.selectCompanion(input.roomId, input.characterId, input.id),
      ),
    get: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => context.chat.companionSettings(input.roomId)),
    save: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          id: identityIdSchema,
          companion: companionInputSchema.nullable(),
        }),
      )
      .handler(({ context, input }) =>
        context.chat.saveCompanion(input.roomId, input.id, input.companion, context.player),
      ),
    setModel: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          id: identityIdSchema,
          provider: z.string().min(1),
          model: z.string().trim().min(1),
          thinkingLevel: thinkingLevelSchema.optional(),
        }),
      )
      .handler(async ({ context, input }) => {
        const model = await context.roomAi.resolve(
          input.provider,
          input.model,
          input.thinkingLevel,
        );
        return context.chat.setCompanionModel(input.roomId, input.id, model);
      }),
    clearModel: procedure
      .input(z.object({ roomId: z.string().uuid(), id: identityIdSchema }))
      .handler(({ context, input }) =>
        context.chat.setCompanionModel(input.roomId, input.id, null),
      ),
    setVoice: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          id: identityIdSchema,
          voice: ttsVoiceOverrideSchema.nullable(),
        }),
      )
      .handler(({ context, input }) =>
        context.chat.setCompanionVoice(input.roomId, input.id, input.voice),
      ),
    setDocumentAccess: procedure
      .input(z.object({ roomId: z.string().uuid(), id: identityIdSchema, enabled: z.boolean() }))
      .handler(({ context, input }) =>
        context.chat.setCompanionDocumentAccess(input.roomId, input.id, input.enabled),
      ),
    setInitiative: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          id: identityIdSchema,
          initiative: companionInitiativeSchema,
        }),
      )
      .handler(({ context, input }) =>
        context.chat.setCompanionInitiative(input.roomId, input.id, input.initiative),
      ),
  },
  display: {
    get: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => roomDisplaySettings(context.sessionsRoot, input.roomId)),
    save: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          showReasoning: z.boolean().optional(),
          showAllDocuments: z.boolean().optional(),
        }),
      )
      .handler(({ context, input }) =>
        roomDisplaySettings(context.sessionsRoot, input.roomId, {
          showReasoning: input.showReasoning,
          showAllDocuments: input.showAllDocuments,
        }),
      ),
  },
  details: procedure
    .input(z.object({ roomId: z.string().uuid(), messageId: z.string().uuid() }))
    .handler(async ({ context, input }) => {
      const settings = await roomDisplaySettings(context.sessionsRoot, input.roomId);
      return settings.showReasoning ? context.chat.details(input.roomId, input.messageId) : [];
    }),
  notes: roomNotesRouter,
  ai: {
    context: procedure
      .input(z.object({ roomId: z.string().uuid(), companionId: identityIdSchema.optional() }))
      .handler(({ context, input }) => context.chat.context(input.roomId, input.companionId)),
    compact: procedure
      .input(z.object({ roomId: z.string().uuid(), companionId: identityIdSchema.optional() }))
      .handler(({ context, input }) => context.chat.compact(input.roomId, input.companionId)),
    compaction: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => context.roomAi.compaction(input.roomId)),
    saveCompaction: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          role: compactionRoleSchema,
          settings: compactionSettingsSchema,
        }),
      )
      .handler(({ context, input }) =>
        context.roomAi.saveCompaction(input.roomId, input.role, input.settings),
      ),
    get: procedure
      .input(z.object({ roomId: z.string().uuid() }))
      .handler(({ context, input }) => context.roomAi.get(input.roomId)),
    select: procedure
      .input(
        z.object({
          roomId: z.string().uuid(),
          provider: z.string().min(1),
          model: z.string().trim().min(1),
          thinkingLevel: thinkingLevelSchema.optional(),
        }),
      )
      .handler(({ context, input }) =>
        context.roomAi.select(input.roomId, input.provider, input.model, input.thinkingLevel),
      ),
  },
  list: procedure.handler(({ context }) => listLocalSessions(context.sessionsRoot)),
  create: procedure
    .input(z.object({ modulePath: z.string().min(1), name: z.string().trim().min(1).max(80) }))
    .handler(async ({ context, input }) =>
      createSession(
        context.sessionsRoot,
        assertAbsolutePath(input.modulePath),
        input.name,
        await context.gameSettings.defaults(),
      ),
    ),
  end: procedure
    .input(z.object({ id: z.string().uuid() }))
    .handler(({ context, input }) => context.sessionLifecycle.end(input.id)),
  reopen: procedure
    .input(z.object({ id: z.string().uuid() }))
    .handler(({ context, input }) => context.sessionLifecycle.reopen(input.id)),
  remove: procedure
    .input(z.object({ id: z.string().uuid() }))
    .handler(({ context, input }) => context.sessionLifecycle.remove(input.id)),
  load: procedure
    .input(z.object({ id: z.string().uuid() }))
    .handler(({ context, input }) => loadLocalSession(context.sessionsRoot, input.id)),
};
