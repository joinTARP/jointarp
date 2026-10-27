import { BrowserWindow, BuildConfig, type WindowOptionsType } from "electrobun/main";

import { rendererEntry, rendererNavigationRules } from "./window-security";

export type DesktopWindow = BrowserWindow;
export const windowStates = new Map<
  number,
  { gamePage: boolean; send: (name: "open-settings" | "request-leave-room") => void }
>();
let configure: (window: DesktopWindow) => void = () => {};
export function configureDesktopWindows(callback: typeof configure): void {
  configure = callback;
}
export function isWindowOpen(window: DesktopWindow | null): window is DesktopWindow {
  return window !== null && BrowserWindow.getById(window.id) !== undefined;
}
export function focusedWindow(): DesktopWindow | null {
  return BrowserWindow.getById(focusedId) ?? null;
}
let focusedId = 0;
export function createDesktopWindow(
  options: Partial<WindowOptionsType> = {},
  hash = "/",
  minimum = { width: 960, height: 640 },
): DesktopWindow {
  const entry = rendererEntry({
    development: !BuildConfig.getSync().isPackaged,
    devUrl: process.env.TARP_RENDERER_URL,
  });
  const window = new BrowserWindow({
    title: "TARP",
    frame: { width: 1280, height: 800 },
    titleBarStyle: process.platform === "linux" ? "default" : "hiddenInset",
    trafficLightOffset: { x: 16, y: 16 },
    renderer: "native",
    ...options,
    // RPC 只向受原生导航白名单保护的应用页面开放；不开放用户目录协议。
    allowedProtocols: { views: true, appData: false },
    navigationRules: JSON.stringify(rendererNavigationRules(entry)),
    url: `${entry}#${hash}`,
  });
  focusedId = window.id;
  window.on("focus", () => {
    focusedId = window.id;
  });
  window.on("close", () => {
    windowStates.delete(window.id);
  });
  window.on("resize", () => {
    const frame = window.getFrame();
    if (frame.width < minimum.width || frame.height < minimum.height)
      window.setSize(Math.max(frame.width, minimum.width), Math.max(frame.height, minimum.height));
  });
  configure(window);
  return window;
}
export function showWindow(window: DesktopWindow): void {
  if (window.isMinimized()) window.unminimize();
  window.show();
  window.activate();
}
export function loadWindow(window: DesktopWindow, hash: string): void {
  window.webview.loadURL(`${window.url?.split("#")[0] ?? rendererEntry()}#${hash}`);
}
