import type { DesktopAction } from "@shared/desktop-events";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "./ui/button";

/** 独立占用一行，避免窗口按钮遮挡设置、模组和参考资料窗口的内容。 */
export function WindowsTitleBar({ children }: { readonly children: ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  const windows = navigator.userAgent.includes("Windows");
  async function action(command: DesktopAction) {
    const state = await window.desktopEvents?.windowAction(command);
    if (state !== undefined) setMaximized(state);
  }

  useEffect(() => {
    if (!windows) return;
    const refresh = () => void action("window-state");
    refresh();
    window.addEventListener("resize", refresh);
    return () => window.removeEventListener("resize", refresh);
  }, [windows]);

  if (!windows) return children;
  return (
    <div className="bg-background text-foreground flex h-full min-h-0 flex-col">
      <header
        className="bg-sidebar border-border/60 electrobun-webkit-app-region-drag relative z-[100] flex h-9 shrink-0 items-center border-b select-none"
        onDoubleClick={(event) => {
          if (event.target instanceof Element && event.target.closest("button")) return;
          void action("maximize");
        }}
      >
        <span className="text-muted-foreground ml-4 text-[11px] font-semibold tracking-[0.16em]">
          TARP
        </span>
        <div className="h-full flex-1" />
        <div className="electrobun-webkit-app-region-no-drag flex h-full">
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-11 rounded-none"
            aria-label="最小化"
            onClick={() => void action("minimize")}
          >
            <Minus className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-11 rounded-none"
            aria-label={maximized ? "还原窗口" : "最大化"}
            onClick={() => void action("maximize")}
          >
            {maximized ? <Copy className="size-3" /> : <Square className="size-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-full w-11 rounded-none hover:bg-[#c42b1c] hover:text-white active:bg-[#a92317]"
            aria-label="关闭窗口"
            onClick={() => void action("close")}
          >
            <X className="size-4" />
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">{children}</div>
    </div>
  );
}
