import { productName } from "@shared/brand";
import {
  ApplicationMenu,
  BuildConfig,
  Utils,
  type ApplicationMenuItemConfig,
} from "electrobun/main";

import { focusedWindow, isWindowOpen, windowStates, type DesktopWindow } from "./native-window";

/** 窗口按钮与快捷键共用原生动作；关闭必须经过离开房间确认。 */
export function performDesktopAction(window: DesktopWindow, action: string): boolean {
  if (!isWindowOpen(window)) return false;
  if (action === "minimize") window.minimize();
  if (action === "maximize") {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  }
  if (action === "close") window.requestClose();
  if (action === "quit") Utils.quit();
  if (action === "settings") windowStates.get(window.id)?.send("open-settings");
  if (action === "full-screen") window.setFullScreen(!window.isFullScreen());
  if (!BuildConfig.getSync().isPackaged) {
    if (action === "reload") window.webview.executeJavascript("location.reload()");
    if (action === "devtools") window.webview.toggleDevTools();
  }
  if (action === "reset-zoom") window.setPageZoom(1);
  if (action === "zoom-in") window.setPageZoom(Math.min(3, window.getPageZoom() + 0.1));
  if (action === "zoom-out") window.setPageZoom(Math.max(0.5, window.getPageZoom() - 0.1));
  return isWindowOpen(window) && window.isMaximized();
}

/** macOS 与 Linux 使用系统菜单；Windows 使用应用标题栏和窗口内快捷键。 */
export function configureApplicationMenu(openSettings: () => void): void {
  const mac = process.platform === "darwin";
  if (process.platform === "win32") return;
  const settings = { label: "设置…", action: "settings", accelerator: "CmdOrCtrl+," };
  const menu: ApplicationMenuItemConfig[] = [
    ...(mac
      ? [
          {
            label: productName,
            submenu: [
              { role: "about", label: `关于 ${productName}` },
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "hide", label: `隐藏 ${productName}`, accelerator: "Cmd+H" },
              { role: "hideOthers", label: "隐藏其他应用", accelerator: "Cmd+Alt+H" },
              { role: "showAll", label: "显示全部" },
              { type: "separator" },
              { role: "quit", label: `退出 ${productName}`, accelerator: "CmdOrCtrl+Q" },
            ],
          } as ApplicationMenuItemConfig,
        ]
      : []),
    {
      label: "文件",
      submenu: [
        ...(!mac ? [settings, { type: "separator" } as const] : []),
        {
          role: "close",
          label: "关闭窗口",
          accelerator: "CmdOrCtrl+W",
        },
        ...(!mac
          ? [
              {
                role: "quit",
                label: "退出",
                accelerator: "CmdOrCtrl+Q",
              },
            ]
          : []),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销", accelerator: "CmdOrCtrl+Z" },
        { role: "redo", label: "重做", accelerator: "CmdOrCtrl+Shift+Z" },
        { type: "separator" },
        { role: "cut", label: "剪切", accelerator: "CmdOrCtrl+X" },
        { role: "copy", label: "复制", accelerator: "CmdOrCtrl+C" },
        { role: "paste", label: "粘贴", accelerator: "CmdOrCtrl+V" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式", accelerator: "CmdOrCtrl+Shift+V" },
        { role: "selectAll", label: "全选", accelerator: "CmdOrCtrl+A" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { action: "reset-zoom", label: "实际大小", accelerator: "CmdOrCtrl+0" },
        { action: "zoom-in", label: "放大", accelerator: "CmdOrCtrl+Plus" },
        { action: "zoom-out", label: "缩小", accelerator: "CmdOrCtrl+-" },
        { type: "separator" },
        {
          role: "toggleFullScreen",
          label: "切换全屏",
        },
        ...(!BuildConfig.getSync().isPackaged
          ? [
              { type: "separator" } as const,
              { action: "reload", label: "重新载入", accelerator: "CmdOrCtrl+R" },
              { action: "devtools", label: "开发者工具", accelerator: "CmdOrCtrl+Alt+I" },
            ]
          : []),
      ],
    },
    {
      label: "窗口",
      submenu: [
        {
          role: "minimize",
          label: "最小化",
          accelerator: "CmdOrCtrl+M",
        },
        { role: "zoom", label: "缩放窗口" },
        ...(mac ? [{ role: "bringAllToFront", label: "全部置于前台" }] : []),
      ],
    },
  ];
  ApplicationMenu.setApplicationMenu(menu);
  const onClick = (event: unknown) => {
    const { action } = (event as { data: { action: string } }).data;
    if (action === "settings") {
      openSettings();
      return;
    }
    const window = focusedWindow();
    if (!isWindowOpen(window)) return;
    performDesktopAction(window, action);
  };
  ApplicationMenu.on("application-menu-clicked", onClick);
}
