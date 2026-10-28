import { useQuery } from "@tanstack/react-query";

import { desktopOrpc } from "../../desktop-rpc";
import { LanJoin } from "../sessions/LanRoom";
import { RecentJoinedRooms } from "../sessions/LanRoom";
import { RoomList } from "../sessions/RoomList";
import { ModuleCardList } from "./ModuleCardList";

export function ModuleLibraryPage() {
  return <HomePage section="modules" />;
}

export function HomePage({ section = "home" }: { section?: "home" | "modules" }) {
  const isLibrary = section === "modules";
  const catalog = useQuery(desktopOrpc.modules.list.queryOptions());
  return (
    <>
      {!isLibrary ? (
        <>
          <LanJoin />
          <RoomList />
          <RecentJoinedRooms />
        </>
      ) : null}
      <ModuleCardList
        title={isLibrary ? undefined : "模组"}
        catalog={
          catalog.error
            ? {
                status: "error",
                message:
                  catalog.error instanceof Error ? catalog.error.message : "读取模组列表失败",
              }
            : (catalog.data ?? null)
        }
        loading={catalog.isPending}
      />
    </>
  );
}
