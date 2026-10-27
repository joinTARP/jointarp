import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Activity as ActivityIcon,
  Archive,
  AudioLines,
  Eye,
  MessagesSquare,
  Sparkles,
  Users,
} from "lucide-react";
import { Activity, useId, useRef, useState } from "react";

import { NavigationHighlight, NavigationMotion } from "../../components/NavigationMotion";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { ScrollAreaPane } from "../../components/ui/scroll-area";
import { desktopOrpc } from "../../desktop-rpc";
import { AutosaveScope, useFlushSettings } from "../settings/AutosaveScope";
import { SettingsCardLayout, SettingsSection } from "../settings/SettingsSection";
import { speechPlayer } from "../tts/use-speech";
import { RoomCompanionSettings } from "./RoomCompanionSettings";
import { RoomConfigurationSettings } from "./RoomConfigurationSettings";
import { RoomMentionSettings } from "./RoomMentionSettings";
import {
  RoomAdventureManagement,
  RoomChatSettings,
  RoomDisplaySettings,
  RoomHostSettings,
  RoomVoiceSettings,
} from "./RoomSettingsPanels";
import { SessionStatus } from "./SessionStatus";
import { useRoomSession } from "./use-room-state";

const settingsGroups = [
  {
    label: "冒险配置",
    items: [
      {
        id: "host",
        label: "模型与主持",
        icon: Sparkles,
        description: "选择主持模型，调整这段冒险的主持指令。",
      },
      {
        id: "chat",
        label: "对话与上下文",
        icon: MessagesSquare,
        description: "配置主持插话、文档字段订阅和上下文压缩。",
      },
      {
        id: "party",
        label: "冒险小队",
        icon: Users,
        description: "管理同伴、点名交流和新加入队友的默认配置。",
      },
      {
        id: "voice",
        label: "语音朗读",
        icon: AudioLines,
        description: "设置本局的默认声音、自动朗读和主持音色。",
      },
      {
        id: "display",
        label: "显示与调试",
        icon: Eye,
        description: "调整推理细节和模组资料的可见范围。",
      },
    ],
  },
  {
    label: "运行与存档",
    items: [
      {
        id: "status",
        label: "会话状态",
        icon: ActivityIcon,
        description: "查看主持人和队友的上下文、用量与运行状态。",
      },
      {
        id: "module",
        label: "模组与存档",
        icon: Archive,
        description: "同步模组更新，或管理这段冒险的存档。",
      },
    ],
  },
] as const;
const settingsSections = settingsGroups.flatMap((group) => [...group.items]);
type SettingsSectionId = (typeof settingsSections)[number]["id"];

export function RoomSettingsPage() {
  const { roomId } = useParams({ from: "/game/$roomId/settings" });
  const navigate = useNavigate();
  const lan = useQuery(desktopOrpc.lan.status.queryOptions({ input: { roomId } }));
  return (
    <AutosaveScope>
      <Dialog
        open
        onOpenChange={(open) => {
          // 路由离开前提交当前分类；失败时保留设置与草稿。
          if (!open) void navigate({ to: "/game/$roomId", params: { roomId } });
        }}
      >
        <DialogContent className="flex h-[85dvh] flex-col gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-6xl">
          <DialogTitle className="sr-only">冒险设置</DialogTitle>
          <DialogDescription className="sr-only">
            按分类管理当前冒险的主持、小队、语音、状态和存档。
          </DialogDescription>
          {lan.data?.remote === false ? (
            <RoomSettingsContent key={roomId} roomId={roomId} />
          ) : (
            <p className="p-6">{lan.data?.remote ? "冒险设置由房主管理。" : "正在读取房间…"}</p>
          )}
        </DialogContent>
      </Dialog>
    </AutosaveScope>
  );
}

function RoomSettingsContent({ roomId }: { roomId: string }) {
  const flush = useFlushSettings();
  const session = useRoomSession(roomId);
  const [section, setSection] = useState<SettingsSectionId>("host");
  const [visited, setVisited] = useState(() => new Set<SettingsSectionId>(["host"]));
  const [switching, setSwitching] = useState(false);
  const changingSection = useRef(false);
  const sectionId = useId();
  async function selectSection(next: SettingsSectionId) {
    if (next === section || changingSection.current) return;
    changingSection.current = true;
    setSwitching(true);
    try {
      if (!(await flush())) return;
      speechPlayer.stop(`configuration-voice-preview:${roomId}`);
      setVisited((previous) => new Set(previous).add(next));
      setSection(next);
    } finally {
      changingSection.current = false;
      setSwitching(false);
    }
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <aside className="border-border/50 bg-sidebar text-sidebar-foreground flex w-44 shrink-0 flex-col border-r px-3 py-4 lg:w-48">
        <ScrollAreaPane className="min-h-0 flex-1">
          <NavigationMotion>
            <nav aria-label="冒险设置分类" aria-busy={switching} className="space-y-3">
              {settingsGroups.map((group) => (
                <div key={group.label} role="group" aria-label={group.label}>
                  <div className="space-y-1">
                    {group.items.map(({ id, label, icon: Icon }) => {
                      const selected = section === id;
                      return (
                        <Button
                          key={id}
                          variant="ghost"
                          className={`relative h-9 w-full justify-start gap-2.5 px-2.5 text-[13px] ${selected ? "text-sidebar-accent-foreground hover:bg-transparent dark:hover:bg-transparent" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"}`}
                          aria-current={selected ? "page" : undefined}
                          aria-controls={visited.has(id) ? `${sectionId}-${id}` : undefined}
                          disabled={switching}
                          onClick={() => void selectSection(id)}
                        >
                          <NavigationHighlight active={selected} />
                          <Icon
                            className="relative size-4 shrink-0"
                            strokeWidth={selected ? 2 : 1.8}
                            aria-hidden="true"
                          />
                          <span className="relative">{label}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </NavigationMotion>
        </ScrollAreaPane>
        <p
          role="status"
          className={switching ? "text-muted-foreground shrink-0 px-3 pt-4 text-xs" : "sr-only"}
        >
          {switching ? "正在保存当前分类…" : ""}
        </p>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {session.error ? (
          <div role="alert" className="text-destructive shrink-0 px-7 pt-5 text-sm">
            无法读取冒险：{session.error.message}
            <Button variant="ghost" onClick={() => void session.refetch()}>
              重试
            </Button>
          </div>
        ) : null}
        {settingsSections.map((item) =>
          visited.has(item.id) ? (
            <Activity key={item.id} mode={section === item.id ? "visible" : "hidden"}>
              <section
                id={`${sectionId}-${item.id}`}
                aria-labelledby={`${sectionId}-${item.id}-heading`}
                aria-describedby={`${sectionId}-${item.id}-description`}
                className="flex min-h-0 min-w-0 flex-1 flex-col"
              >
                <div className="bg-background mx-auto w-full max-w-5xl shrink-0 px-6 pt-6 pb-4 lg:px-7">
                  <h2 id={`${sectionId}-${item.id}-heading`} className="pr-10 text-lg font-medium">
                    {item.label}
                  </h2>
                  <p id={`${sectionId}-${item.id}-description`} className="sr-only">
                    {item.description}
                  </p>
                </div>
                <ScrollAreaPane className="min-h-0 flex-1">
                  <div className="mx-auto w-full max-w-5xl px-6 pt-3 pb-6 lg:px-7">
                    <SettingsCardLayout>
                      {item.id === "host" ? (
                        <RoomHostSettings roomId={roomId} />
                      ) : item.id === "chat" ? (
                        <RoomChatSettings roomId={roomId} />
                      ) : item.id === "party" ? (
                        <>
                          <SettingsSection title="当前小队">
                            <RoomCompanionSettings roomId={roomId} />
                          </SettingsSection>
                          <RoomMentionSettings roomId={roomId} />
                          <RoomConfigurationSettings roomId={roomId} section="party" />
                        </>
                      ) : item.id === "voice" ? (
                        <RoomVoiceSettings roomId={roomId} />
                      ) : item.id === "display" ? (
                        <RoomDisplaySettings roomId={roomId} />
                      ) : item.id === "status" ? (
                        <SessionStatus roomId={roomId} />
                      ) : (
                        <RoomAdventureManagement roomId={roomId} />
                      )}
                    </SettingsCardLayout>
                  </div>
                </ScrollAreaPane>
              </section>
            </Activity>
          ) : null,
        )}
      </div>
    </div>
  );
}
