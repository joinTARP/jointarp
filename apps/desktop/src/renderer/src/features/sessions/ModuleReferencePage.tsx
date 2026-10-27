import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { Button } from "../../components/ui/button";
import { LoadingIndicator } from "../../components/ui/loading-indicator";
import { desktopOrpc } from "../../desktop-rpc";
import { DocumentReferences } from "../modules/DocumentReferences";
import { RoomDocumentScope } from "./room-document";
import { RoomModule } from "./RoomModule";
import { useRoomSession } from "./use-room-state";

/** 单独的游戏资料窗口：按当前房间状态读取，不带游戏房导航。 */
export function ModuleReferencePage() {
  const { roomId } = useParams({ from: "/reference/$roomId" });
  const display = useQuery(desktopOrpc.sessions.display.get.queryOptions({ input: { roomId } }));
  const lan = useQuery(desktopOrpc.lan.status.queryOptions({ input: { roomId } }));
  const debug = lan.data?.remote === false && display.data?.showAllDocuments === true;
  const session = useRoomSession(roomId, debug);
  const title = session.data ? `模组设定 · ${session.data.room.moduleName}` : "模组设定";
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <RoomDocumentScope roomId={roomId} debug={debug}>
      <main className="bg-background text-foreground relative flex h-full min-h-0 overflow-hidden">
        <div
          className="absolute inset-x-0 top-0 z-50 h-12 [-webkit-app-region:drag]"
          aria-hidden="true"
        />
        <h1 className="sr-only">{title}</h1>
        {session.isPending ? (
          <div className="grid min-h-0 flex-1 place-items-center">
            <LoadingIndicator label="正在读取模组设定…" />
          </div>
        ) : null}
        {session.error ? (
          <div role="alert" className="grid min-h-0 flex-1 place-items-center p-8">
            <div className="max-w-sm text-center">
              <p className="text-destructive mb-4">无法打开模组设定：{session.error.message}</p>
              <Button onClick={() => void session.refetch()}>重试</Button>
            </div>
          </div>
        ) : null}
        {session.data ? (
          <DocumentReferences
            documents={session.data.documents}
            types={session.data.documentTypes}
            view="game"
          >
            <RoomModule session={session.data} />
          </DocumentReferences>
        ) : null}
      </main>
    </RoomDocumentScope>
  );
}
