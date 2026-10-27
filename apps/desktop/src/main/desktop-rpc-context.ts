import type { GameContext } from "@jointarp/core/node";
import { os, ORPCError } from "@orpc/server";

import type { AppUpdateService } from "./app-update";
import { AppConfigError } from "./config/app-config";
import type { LocalGameSettings } from "./game/local-settings";
import type { RoomAiSettingsStore } from "./game/room-ai-settings";
import type { SubscriptionAuth } from "./game/subscription-auth";
import type { LanService } from "./lan/service";
import type { McpService } from "./mcp/service";
import type { ModuleImportService } from "./modules/import-service";
import type { LocalSessionLifecycle } from "./sessions/local-session-lifecycle";
import type { TtsService } from "./tts/service";

export interface DesktopRpcContext extends GameContext {
  readonly lan?: LanService;
  readonly updates: AppUpdateService;
  readonly moduleImports: ModuleImportService;
  readonly mcp: McpService;
  readonly tts: TtsService;
  readonly configFilePath: string;
  readonly sessionsRoot: string;
  readonly sessionLifecycle: LocalSessionLifecycle;
  readonly gameSettings: LocalGameSettings;
  readonly roomAi: RoomAiSettingsStore;
  readonly subscriptionAuth: SubscriptionAuth;
}

export const desktopProcedure = os.$context<DesktopRpcContext>().use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof AppConfigError)
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
    throw error;
  }
});
