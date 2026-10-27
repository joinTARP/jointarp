import { isAbsolute, join } from "node:path";

import { ChatService, createPiRuntime } from "@jointarp/core/node";
import { narrationGapMs } from "@jointarp/core/shared/narration";
import { modulePreviewHash } from "@jointarp/module-cli/commands";
import { parseModuleImportLink } from "@shared/module-import";
import { NativeMessagePort, type NativeBridge } from "@shared/native-bridge";
import Electrobun, { BrowserView, BuildConfig, Updater, Utils } from "electrobun/main";

import manifest from "../../package.json";
import { AppUpdateService, createAcceleratedUpdater } from "./app-update";
import { readAppConfig, resolveAppConfigLocation } from "./config/app-config";
import { acquireDesktopInstance } from "./desktop-instance";
import { configureApplicationMenu, performDesktopAction } from "./desktop-menu";
import { createDesktopRpcHandler } from "./desktop-rpc";
import { LocalGameSettings } from "./game/local-settings";
import { RoomAiSettingsStore } from "./game/room-ai-settings";
import { SubscriptionAuth } from "./game/subscription-auth";
import { registerImportProtocol } from "./import-protocol";
import { PlaytestService } from "./mcp/playtest";
import { McpService } from "./mcp/service";
import { createMediaServer } from "./media-protocol";
import { ModuleImportService } from "./modules/import-service";
import { readModulesDirectory } from "./modules/module-router";
import {
  configureDesktopWindows,
  createDesktopWindow,
  focusedWindow,
  isWindowOpen,
  loadWindow,
  showWindow,
  windowStates,
  type DesktopWindow,
} from "./native-window";
import {
  closeAllModuleReferences,
  closeModuleReference,
  configureReferenceWindows,
  flushReferenceWindowState,
} from "./reference-window";
import { LocalSessionLifecycle } from "./sessions/local-session-lifecycle";
import { TtsService } from "./tts/service";
import { openHttpLink } from "./window-security";

// 尽早订阅原生事件，初始化期间的请求留给完成启动的宿主。
const earlyImportLinks: string[] = [];
let importLinkHandler: ((url: string) => void) | undefined;
Electrobun.events.on("open-url", (event) => {
  if (importLinkHandler) importLinkHandler(event.data.url);
  else if (earlyImportLinks.length < 2) earlyImportLinks.push(event.data.url);
});

export async function startDesktop(modulePath?: string, importUrl?: string): Promise<void> {
  let mainWindow: DesktopWindow | null = null;
  let shuttingDown = false;
  let shutdownComplete = false;
  let shutdownPromise: Promise<void> | undefined;
  let startupAnimationPending = true;
  const configLocation = resolveAppConfigLocation();
  let pendingPreview = modulePath;
  let initialized = false;
  const pendingImports = [
    ...new Set([importUrl, ...earlyImportLinks].filter((url): url is string => Boolean(url))),
  ];
  earlyImportLinks.length = 0;
  const firstImportUrl = pendingImports[0];
  const instance = await acquireDesktopInstance(
    configLocation.directory,
    firstImportUrl
      ? { kind: "import", url: firstImportUrl }
      : modulePath
        ? { kind: "preview", path: modulePath }
        : { kind: "activate" },
    (request) => {
      if (request.kind === "import") {
        if (!initialized) {
          if (pendingImports.length < 2) pendingImports.push(request.url);
        } else receiveImport(request.url);
        return;
      }
      const path = request.kind === "preview" ? request.path : undefined;
      if (path && isAbsolute(path)) pendingPreview = path;
      if (!initialized) return;
      if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow();
      else {
        if (path && isAbsolute(path)) loadWindow(mainWindow, modulePreviewHash(path));
        showWindow(mainWindow);
      }
    },
  );
  if (!instance) {
    process.exit(0);
  }

  await readAppConfig(configLocation.filePath);
  const moduleImports = new ModuleImportService(
    async () => (await readModulesDirectory(configLocation.filePath)).path,
  );
  function receiveImport(url: string) {
    if (shuttingDown) return;
    if (!initialized) {
      if (pendingImports.length < 2) pendingImports.push(url);
      return;
    }
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow();
    else showWindow(mainWindow);
    try {
      moduleImports.start(parseModuleImportLink(url));
    } catch (error) {
      moduleImports.report(error);
    }
  }
  importLinkHandler = receiveImport;
  // 实例锁初始化时到达的原生事件也必须交给当前任务服务。
  pendingImports.push(...earlyImportLinks.splice(0));
  const media = createMediaServer();
  const gameSettings = new LocalGameSettings(configLocation.directory);
  const subscriptionAuth = new SubscriptionAuth(
    () => gameSettings.modelRuntime(),
    async (url) => {
      if (!(await openHttpLink(url, Utils.openExternal))) throw new Error("无法打开登录页面");
    },
  );
  const tts = new TtsService(configLocation.directory);
  const sessionsRoot = join(configLocation.directory, "sessions");
  const roomAi = new RoomAiSettingsStore(sessionsRoot, gameSettings);
  const chat = new ChatService(
    sessionsRoot,
    createPiRuntime({ modelRuntime: () => gameSettings.modelRuntime() }),
    (roomId, selection) => roomAi.credentials(roomId, selection),
    { narrationGap: narrationGapMs },
  );
  const sessionLifecycle = new LocalSessionLifecycle(sessionsRoot, chat, closeModuleReference);
  function showRoom(roomId?: string | null) {
    if (shuttingDown) return;
    const hash = roomId ? `/game/${roomId}` : "/";
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow(hash);
    else {
      loadWindow(mainWindow, hash);
      showWindow(mainWindow);
    }
  }
  const mcp = new McpService({
    directory: configLocation.directory,
    copyText: Utils.clipboardWriteText,
    createPlaytest: () =>
      new PlaytestService({
        root: sessionsRoot,
        chat,
        player: () => gameSettings.player(),
        defaults: () => gameSettings.defaults(),
        showRoom,
      }),
  });
  const handler = createDesktopRpcHandler();
  const updates = new AppUpdateService(
    {
      ...createAcceleratedUpdater(Updater),
      applyUpdate: async () => {
        try {
          await shutdown();
          await Updater.applyUpdate();
          if (Updater.updateInfo().error) throw new Error(Updater.updateInfo().error);
        } catch (error) {
          try {
            await Utils.showMessageBox({
              type: "error",
              title: "更新未能安装",
              message: "TARP 将退出，请重新打开后重试更新。",
              detail: error instanceof Error ? error.message : String(error),
            });
          } finally {
            shutdownComplete = true;
            Utils.quit();
          }
        }
      },
    },
    manifest.version,
    async () => {
      const { response } = await Utils.showMessageBox({
        type: "question",
        title: "重启更新 TARP",
        message: "现在结束当前运行并重启安装更新吗？",
        detail: "重启将停止正在进行的 AI 回复和语音播放。请先保存正在编辑的内容。",
        buttons: ["稍后", "重启更新"],
        defaultId: 0,
        cancelId: 0,
      });
      return response === 1;
    },
  );
  configureDesktopWindows((window) => {
    let port: NativeMessagePort | undefined;
    const rpc = BrowserView.defineRPC<NativeBridge>({
      handlers: {
        requests: {
          bootstrap: () => {
            // 页面刷新关闭上一条连接，释放房间订阅与在途请求。
            port?.close();
            port = new NativeMessagePort((packet) => rpc.send.orpc(packet));
            handler.upgrade(port, {
              context: async () => ({
                configFilePath: configLocation.filePath,
                sessionsRoot,
                sessionLifecycle,
                gameSettings,
                tts,
                roomAi,
                subscriptionAuth,
                chat,
                mcp,
                updates,
                moduleImports,
                isHost: true,
                player: await gameSettings.player(),
              }),
            });
            return { mediaBase: media.base };
          },
          claimStartupAnimation: () => {
            if (!startupAnimationPending || window !== mainWindow) return false;
            startupAnimationPending = false;
            return true;
          },
          openExternal: ({ url }) => openHttpLink(url, Utils.openExternal),
          setGamePage: ({ active }) => {
            const state = windowStates.get(window.id);
            if (state) state.gamePage = active;
          },
          windowAction: ({ action }) => performDesktopAction(window, action),
        },
        messages: { orpc: (packet) => port?.receive(packet) },
      },
    });
    window.webview.rpc = rpc;
    rpc.setTransport(window.webview.createTransport());
    windowStates.set(window.id, { gamePage: false, send: (name) => rpc.send.desktop({ name }) });
    window.on("close", () => port?.close());
  });
  function createMainWindow(hash = pendingPreview ? modulePreviewHash(pendingPreview) : "/") {
    const window = createDesktopWindow({}, hash);
    window.on("will-close", (event) => {
      if (!shuttingDown && windowStates.get(window.id)?.gamePage) {
        (event as { response: { allow: boolean } }).response = { allow: false };
        windowStates.get(window.id)?.send("request-leave-room");
      }
    });
    window.on("close", () => {
      if (mainWindow === window) mainWindow = null;
      closeAllModuleReferences();
      if (process.platform !== "darwin" && !shuttingDown) Utils.quit();
    });
    return window;
  }
  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    tts.close();
    closeAllModuleReferences();
    shutdownPromise = Promise.allSettled([
      (async () => {
        try {
          await mcp.close();
        } finally {
          await chat.close();
        }
      })(),
      subscriptionAuth.cancel(),
      flushReferenceWindowState(),
      instance!.close(),
    ]).then(() => {
      media.close();
      shutdownComplete = true;
    });
    return shutdownPromise;
  }
  Electrobun.events.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.response = { allow: false };
    if (updates.get().state === "installing") return;
    void shutdown().finally(() => Utils.quit());
  });
  Electrobun.events.on("reopen", () => {
    if (!isWindowOpen(mainWindow)) mainWindow = createMainWindow();
    else showWindow(mainWindow);
  });
  configureApplicationMenu(() => {
    const target = focusedWindow();
    if (isWindowOpen(target)) windowStates.get(target.id)?.send("open-settings");
    else mainWindow = createMainWindow("/?overlay=settings");
  });
  await configureReferenceWindows({
    boundsFile: join(configLocation.directory, "reference-window.json"),
    parent: () => mainWindow,
  });
  initialized = true;
  mainWindow = createMainWindow();
  for (const url of pendingImports) receiveImport(url);
  void registerImportProtocol(BuildConfig.getSync().channel).catch((error) => {
    console.error("注册官网导入协议失败", error);
    void Utils.showMessageBox({
      type: "error",
      title: "无法启用官网一键导入",
      message: "你仍可在模组库中手动导入。请重新启动应用后重试。",
      detail: error instanceof Error ? error.message : String(error),
    });
  });
  await mcp.initialize();
  void updates.check();
}
