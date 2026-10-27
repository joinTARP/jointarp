import { gameRouter } from "@jointarp/core/node";
import { gameDefaultsPatchSchema } from "@jointarp/core/shared/game-defaults";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/message-port";
import { appConfigSchema } from "@shared/app-config";
import { z } from "zod";

import { readAppConfig, updateAppConfig } from "./config/app-config";
import { desktopProcedure as procedure } from "./desktop-rpc-context";
import { connectProviderSchema } from "./game/local-settings";
import { lanForwarder } from "./lan/forwarder";
import { lanRouter } from "./lan/router";
import { moduleRouter } from "./modules/module-router";
import { closeModuleReference, openModuleReference } from "./reference-window";
import { sessionRouter } from "./sessions/session-router";
import { ttsRouter } from "./tts/router";
export type { DesktopRpcContext } from "./desktop-rpc-context";

export const desktopRouter = {
  lan: lanRouter,
  updates: {
    get: procedure.handler(({ context }) => context.updates.get()),
    check: procedure.handler(({ context }) => context.updates.check()),
    download: procedure.handler(({ context }) => context.updates.download()),
    restart: procedure.handler(({ context }) => context.updates.restart()),
  },
  mcp: {
    get: procedure.handler(({ context }) => context.mcp.get()),
    setEnabled: procedure
      .input(z.strictObject({ enabled: z.boolean() }))
      .handler(({ context, input }) => context.mcp.setEnabled(input.enabled)),
    copyConfiguration: procedure.handler(({ context }) => context.mcp.copyConfiguration()),
  },
  gameDefaults: {
    get: procedure.handler(({ context }) => context.gameSettings.defaults()),
    update: procedure
      .input(gameDefaultsPatchSchema)
      .handler(({ context, input }) => context.gameSettings.updateDefaults(input)),
  },
  tts: ttsRouter,
  windows: {
    openModule: procedure.input(z.object({ roomId: z.string().uuid() })).handler(({ input }) => {
      openModuleReference(input.roomId);
    }),
    closeModule: procedure.input(z.object({ roomId: z.string().uuid() })).handler(({ input }) => {
      closeModuleReference(input.roomId);
    }),
  },
  game: gameRouter,
  player: {
    get: procedure.handler(({ context }) => context.gameSettings.player()),
    update: procedure
      .input(z.object({ nickname: z.string().trim().min(1).max(32) }))
      .handler(({ context, input }) => context.gameSettings.updatePlayer(input.nickname)),
  },
  ai: {
    subscription: {
      status: procedure.handler(({ context }) => context.subscriptionAuth.status()),
      start: procedure
        .input(z.object({ method: z.enum(["browser", "device_code"]) }))
        .handler(({ context, input }) => context.subscriptionAuth.start(input.method)),
      cancel: procedure
        .input(z.object({ id: z.string() }))
        .handler(({ context, input }) => context.subscriptionAuth.cancel(input.id)),
      submit: procedure
        .input(z.object({ id: z.string(), value: z.string().trim().min(1).max(8192) }))
        .handler(({ context, input }) => context.subscriptionAuth.submit(input.id, input.value)),
      logout: procedure.handler(({ context }) => context.subscriptionAuth.logout()),
    },
    get: procedure.handler(({ context }) => context.gameSettings.get()),
    availableModels: procedure.handler(({ context }) => context.gameSettings.availableModels()),
    disconnect: procedure
      .input(z.object({ provider: z.string().min(1) }))
      .handler(({ context, input }) => context.gameSettings.disconnect(input.provider)),
    connect: procedure
      .input(connectProviderSchema)
      .handler(({ context, input }) => context.gameSettings.connect(input)),
    providers: procedure.handler(({ context }) => context.gameSettings.providers()),
  },
  sessions: sessionRouter,
  config: {
    get: procedure.handler(({ context }) => readAppConfig(context.configFilePath)),
    update: procedure.input(appConfigSchema).handler(async ({ context, input }) => {
      const next = await updateAppConfig(context.configFilePath, input);
      return next;
    }),
  },
  modules: moduleRouter,
};

export type DesktopRouter = typeof desktopRouter;

export function createDesktopRpcHandler() {
  return new RPCHandler(desktopRouter, {
    clientInterceptors: [lanForwarder],
    interceptors: [
      onError((error) => {
        console.error("桌面 RPC 失败", error);
      }),
    ],
  });
}
