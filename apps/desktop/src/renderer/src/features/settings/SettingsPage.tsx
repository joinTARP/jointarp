import { indexById, searchItems } from "@shared/query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useTheme } from "../../components/ThemeProvider";
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "../../components/ui/scroll-area";
import { useSettingsOverlay } from "../../components/useSettingsOverlay";
import { desktopOrpc } from "../../desktop-rpc";
import { AiSettingsPanel } from "./AiSettingsPanel";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import { useFlushSettings } from "./AutosaveScope";
import { GameDefaultsSettingsPanel } from "./GameDefaultsSettingsPanel";
import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { McpSettingsPanel } from "./McpSettingsPanel";
import { settingsNavGroups, SettingsNavigation } from "./SettingsNavigation";
import type { ThemeChoice } from "./ThemePreview";
import { TtsSettingsPanel } from "./TtsSettingsPanel";
const themeOptions: readonly {
  readonly description: string;
  readonly id: ThemeChoice;
  readonly label: string;
}[] = [
  { id: "system", label: "系统", description: "跟随系统外观" },
  { id: "light", label: "浅色", description: "明亮、清晰的工作区" },
  { id: "dark", label: "深色", description: "适合长时间创作" },
];
export default function SettingsPage() {
  const flush = useFlushSettings();
  const { closeSettings } = useSettingsOverlay();
  const { setTheme, theme } = useTheme();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSection, setActiveSection] = useState("general");
  const [modulesPathError, setModulesPathError] = useState<string | null>(null);
  const modulesDirectory = useQuery(desktopOrpc.modules.getDirectory.queryOptions());
  const pickPath = useMutation(desktopOrpc.modules.pickPath.mutationOptions());
  const resetPath = useMutation(desktopOrpc.modules.resetPath.mutationOptions());
  const modulesPathBusy = pickPath.isPending || resetPath.isPending;
  const visibleGroups = useMemo(() => {
    if (!searchQuery.trim()) return settingsNavGroups;
    return settingsNavGroups
      .map((group) => ({
        ...group,
        items: searchItems(group.items, searchQuery, (item) =>
          item.id === "general"
            ? [
                item.label,
                "模组保存路径",
                "玩家",
                "昵称",
                "更新",
                "版本",
                "下载",
                "重启",
                "隐私",
                "政策",
              ]
            : item.id === "ai"
              ? [item.label, "模型", "服务商", "API Key", "兼容服务", "订阅", "ChatGPT", "登录"]
              : item.id === "game-defaults"
                ? [
                    item.label,
                    "游戏默认配置",
                    "主持",
                    "默认",
                    "指令",
                    "prompt",
                    "插话",
                    "压缩",
                    "上下文",
                    "订阅",
                    "Token",
                    "提交",
                    "队友",
                    "声音",
                    "朗读",
                    "推理",
                    "显示",
                  ]
                : item.id === "tts"
                  ? [item.label, "TTS", "MiMo", "音色", "朗读", "语音", "API Key"]
                  : item.id === "developer"
                    ? [item.label, "MCP", "Agent", "预演", "模组测试", "托管", "连接"]
                    : [item.label],
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [searchQuery]);
  const themeById = useMemo(() => indexById(themeOptions), []);
  const currentThemeLabel = (theme && themeById.get(theme)?.label) || "系统";
  const isDefaultModulesPath = modulesDirectory.data?.path === modulesDirectory.data?.defaultPath;
  async function invalidateModuleQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: desktopOrpc.modules.getDirectory.key() }),
      queryClient.invalidateQueries({ queryKey: desktopOrpc.modules.list.key() }),
    ]);
  }
  async function pickModulesPath() {
    setModulesPathError(null);
    try {
      const next = await pickPath.mutateAsync();
      if (next.status === "cancelled") return;
      if (next.status === "error") {
        setModulesPathError(next.message);
        return;
      }
      await invalidateModuleQueries();
    } catch (error) {
      setModulesPathError(error instanceof Error ? error.message : "选择模组保存路径失败");
    }
  }
  async function resetModulesPath() {
    setModulesPathError(null);
    try {
      await resetPath.mutateAsync();
      await invalidateModuleQueries();
    } catch (error) {
      setModulesPathError(error instanceof Error ? error.message : "恢复默认模组保存路径失败");
    }
  }
  return (
    <main className="bg-background text-foreground relative flex h-full min-h-0 w-full overflow-hidden">
      <div
        className="absolute inset-x-0 top-0 z-50 h-12 [-webkit-app-region:drag]"
        aria-hidden="true"
      />
      <SettingsNavigation
        visibleGroups={visibleGroups}
        searchQuery={searchQuery}
        activeSection={activeSection}
        onSearchChange={setSearchQuery}
        onBack={closeSettings}
        onSelect={(section) => {
          if (section === activeSection) return;
          void flush().then((saved) => {
            if (saved) setActiveSection(section);
          });
        }}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <ScrollArea className="h-full">
          <ScrollAreaViewport>
            <ScrollAreaContent>
              <div className="pt-3 pb-16">
                {activeSection === "general" ? (
                  <GeneralSettingsPanel
                    modulesPath={modulesDirectory.data?.path ?? null}
                    busy={modulesPathBusy}
                    isDefaultPath={isDefaultModulesPath}
                    error={modulesPathError}
                    onPick={() => void pickModulesPath()}
                    onReset={() => void resetModulesPath()}
                  />
                ) : activeSection === "ai" ? (
                  <AiSettingsPanel />
                ) : activeSection === "tts" ? (
                  <TtsSettingsPanel />
                ) : activeSection === "game-defaults" ? (
                  <GameDefaultsSettingsPanel />
                ) : activeSection === "developer" ? (
                  <McpSettingsPanel />
                ) : (
                  <AppearanceSettingsPanel
                    theme={theme as ThemeChoice | undefined}
                    currentThemeLabel={currentThemeLabel}
                    themeOptions={themeOptions}
                    onThemeChange={setTheme}
                  />
                )}
              </div>
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollAreaScrollbar>
            <ScrollAreaThumb />
          </ScrollAreaScrollbar>
        </ScrollArea>
      </div>
    </main>
  );
}
