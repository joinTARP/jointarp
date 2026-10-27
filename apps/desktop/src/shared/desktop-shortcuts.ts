import type { DesktopAction } from "./desktop-events";

/** 文本编辑快捷键继续交给系统 WebView，仅接管窗口与应用动作。 */
export function desktopShortcut(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): DesktopAction | undefined {
  if (event.metaKey) return;
  if (event.ctrlKey && event.altKey && !event.shiftKey && event.key.toLowerCase() === "i")
    return "devtools";
  if (event.altKey) return;
  if (!event.ctrlKey) {
    if (event.shiftKey) return;
    if (event.key === "F11") return "full-screen";
    return;
  }
  const key = event.key.toLowerCase();
  if (event.shiftKey && key !== "+") return;
  switch (key) {
    case ",":
      return "settings";
    case "w":
      return "close";
    case "q":
      return "quit";
    case "m":
      return "minimize";
    case "r":
      return "reload";
    case "0":
      return "reset-zoom";
    case "+":
    case "=":
      return "zoom-in";
    case "-":
      return "zoom-out";
  }
}
