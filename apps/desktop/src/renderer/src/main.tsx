import { appThemeStorageKey, appThemes, defaultAppTheme, type AppTheme } from "@shared/app-config";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import { SplashScreen } from "./components/SplashScreen";
import { ThemeProvider } from "./components/ThemeProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import { WindowsTitleBar } from "./components/WindowsTitleBar";
import { desktopRpc, queryClient } from "./desktop-rpc";
import { listenForModuleSync } from "./features/sessions/room-module-sync";
import { desktopReady } from "./native-bridge";
import { router } from "./router";

import "./styles.css";

const rootElement = document.getElementById("app");
const stopModuleSyncListener = listenForModuleSync(queryClient);
window.addEventListener("unload", stopModuleSyncListener, { once: true });

if (!rootElement) {
  throw new Error("桌面应用挂载节点 #app 不存在。");
}

function isAppTheme(value: string): value is AppTheme {
  return (appThemes as readonly string[]).includes(value);
}

async function loadInitialTheme(): Promise<AppTheme> {
  try {
    const theme = (await desktopRpc.config.get()).theme;
    if (theme && isAppTheme(theme)) return theme;
  } catch (error) {
    console.error("读取应用配置失败", error);
  }

  return defaultAppTheme;
}

/** 配置读取完成后、React 挂载前校准主题；本地选择与 next-themes 保持相同优先级。 */
function applyInitialTheme(initialTheme: AppTheme): void {
  let theme = initialTheme;
  try {
    const saved = localStorage.getItem(appThemeStorageKey);
    if (saved && isAppTheme(saved)) theme = saved;
  } catch {
    // 本地存储不可用时仍可使用配置文件里的主题。
  }

  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

void Promise.all([
  loadInitialTheme(),
  window.desktopEvents?.claimStartupAnimation() ?? Promise.resolve(false),
  desktopReady,
]).then(([initialTheme, playStartupAnimation]) => {
  applyInitialTheme(initialTheme);
  const page = <RouterProvider router={router} />;
  // 播放资格由主进程一次性发放，换窗、返回首页和刷新都不重复播放。
  const content =
    playStartupAnimation && router.state.location.pathname === "/" ? (
      <SplashScreen router={router}>{page}</SplashScreen>
    ) : (
      page
    );
  ReactDOM.createRoot(rootElement).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider initialTheme={initialTheme}>
        <TooltipProvider>
          <WindowsTitleBar>{content}</WindowsTitleBar>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
});
