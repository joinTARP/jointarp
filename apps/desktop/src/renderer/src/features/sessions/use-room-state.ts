import type { LaunchState } from "@jointarp/core/shared/launch";
import type { RoomEntity, RoomReplica } from "@jointarp/core/shared/room-state";
import { publicDocumentType, type Character } from "@jointarp/module/character";
import type { ModuleDocument } from "@shared/desktop-api";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { desktopOrpc, desktopRpc } from "../../desktop-rpc";
import { localRoomModuleLoader } from "./local-room-module";
import { roomConnection } from "./room-connection";
import { computedDraftView, roomDraftIdentity } from "./room-draft-view";
import { workbenchReferenceEntities, restoreWorkbenchReferencePreviews } from "./room-launch-view";

const launchPreviewError = new Error("开局资料计算失败，请重试");

export function useRoomReplica(roomId: string) {
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  useEffect(() => connection.retain(), [connection]);
  return useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().replica);
}

export function useRoomError(roomId: string) {
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  return useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().error);
}

const documentCache = new WeakMap<RoomEntity, ModuleDocument>();
const characterCache = new WeakMap<
  RoomEntity,
  { document?: ModuleDocument; character: Character }
>();
const documentsCache = new WeakMap<RoomReplica["entities"], ModuleDocument[]>();
export function roomDocuments(replica: RoomReplica): ModuleDocument[] {
  const cached = documentsCache.get(replica.entities);
  if (cached) return cached;
  const documents = Object.values(replica.entities).map((entity) => {
    const previous = documentCache.get(entity);
    if (previous) return previous;
    const document: ModuleDocument = {
      id: entity.id,
      revision: entity.revision,
      path: entity.document.path,
      title: entity.document.title,
      docType: entity.document.docType,
      contentType: entity.document.contentType,
      valid: entity.document.valid,
      values: entity.document.values,
    };
    documentCache.set(entity, document);
    return document;
  });
  documentsCache.set(replica.entities, documents);
  return documents;
}

export function useRoomSession(roomId: string, debug = false) {
  const client = useQueryClient();
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  const resources = useSyncExternalStore(
    connection.subscribe,
    () => connection.getSnapshot().resources,
  );
  const debugOptions = desktopOrpc.sessions.load.queryOptions({ input: { id: roomId } });
  const local = useQuery({ ...debugOptions, enabled: debug, staleTime: Infinity });
  const replica = useRoomReplica(roomId);
  const syncError = useRoomError(roomId);
  const revision = replica?.documentRevision;
  useEffect(() => {
    if (debug) void client.invalidateQueries({ queryKey: debugOptions.queryKey });
  }, [client, roomId, debug, revision]);
  const data = useMemo(() => {
    if (debug) return local.data;
    return resources && replica
      ? {
          ...resources,
          documentTypes: resources.documentTypes.map(publicDocumentType),
          room: replica.sections.room,
          documents: roomDocuments(replica),
        }
      : undefined;
  }, [resources, replica, debug, local.data]);
  const error = (debug ? local.error : undefined) ?? syncError;
  return {
    data,
    error,
    isPending: !data && !error,
    isSuccess: !!data,
    refetch: () => {
      roomConnection(desktopRpc.game, roomId, localRoomModuleLoader).reconnect();
      if (debug) return local.refetch();
    },
  };
}

export function useRoomLaunch(roomId: string) {
  const client = useQueryClient();
  const syncError = useRoomError(roomId);
  const replica = useRoomReplica(roomId);
  const connection = roomConnection(desktopRpc.game, roomId, localRoomModuleLoader);
  const resources = useSyncExternalStore(
    connection.subscribe,
    () => connection.getSnapshot().resources,
  );
  const draft = replica?.sections.launch?.draftView;
  const draftIdentity = draft ? roomDraftIdentity(roomId, draft) : undefined;
  const previousDraft = useRef<{ identity: string; document: ModuleDocument } | undefined>(
    undefined,
  );
  if (previousDraft.current?.identity !== draftIdentity) previousDraft.current = undefined;
  const draftDocument = useQuery({
    queryKey: [
      "room-draft",
      draftIdentity,
      resources?.baseline.version,
      replica?.documentRevision,
      draft,
    ],
    queryFn: ({ signal }) => connection.loadDraft(draft!, signal),
    enabled: !!draft && !!resources,
    placeholderData: (previous, query) =>
      query?.queryKey[1] === draftIdentity ? previous : undefined,
    staleTime: Infinity,
    gcTime: 0,
  });
  if (draftDocument.data?.valid && draftIdentity)
    previousDraft.current = { identity: draftIdentity, document: draftDocument.data };
  const detailEntities = useMemo(() => {
    if (!replica) return [];
    const selected = new Map<string, RoomEntity>();
    const entities = Object.values(replica.entities);
    const characters = new Map(
      entities.flatMap((entity) =>
        entity.character ? [[entity.character.id, entity] as const] : [],
      ),
    );
    for (const id of replica.sections.launch?.characterIds ?? []) {
      const entity = characters.get(id);
      if (entity) selected.set(entity.id, entity);
    }
    for (const entity of workbenchReferenceEntities(replica.sections.launch, replica.entities))
      selected.set(entity.id, entity);
    return [...selected.values()];
  }, [replica]);
  // 可见选角与工作台预览需要本地背景；同一实体与资料面板共用查询键。
  const details = useQueries({
    queries: detailEntities.map((entity) => ({
      queryKey: [
        "room-document",
        replica!.sections.viewerId,
        roomId,
        entity.document.path,
        replica!.documentRevision,
      ],
      queryFn: ({ signal }: { signal: AbortSignal }) => connection.loadDocument(entity, signal),
      placeholderData: keepPreviousData,
      staleTime: Infinity,
      gcTime: 0,
    })),
    combine: (results) => ({
      documents: results.map((query) => query.data),
      error: results.find((query) => query.error)?.error,
      invalid: results.some((query) => query.data && !query.data.valid),
      isFetching: results.some((query) => query.isFetching),
    }),
  });
  const previousDetails = useRef(new Map<string, ModuleDocument>());
  const previousRoom = useRef(roomId);
  if (previousRoom.current !== roomId) {
    previousRoom.current = roomId;
    previousDetails.current.clear();
  }
  const data = useMemo<LaunchState | null | undefined>(() => {
    if (!replica || !resources) return undefined;
    const launch = replica.sections.launch;
    if (!launch) return null;
    if (!resources.launchConfig) return null;
    const currentDetails = new Map<string, ModuleDocument>();
    for (const [index, entity] of detailEntities.entries()) {
      const document = details.documents[index];
      if (document?.valid) previousDetails.current.set(entity.document.path, document);
      const current =
        (document?.valid ? document : undefined) ??
        previousDetails.current.get(entity.document.path);
      if (current) currentDetails.set(entity.id, current);
    }
    const visiblePaths = new Set(detailEntities.map((entity) => entity.document.path));
    for (const path of previousDetails.current.keys()) {
      if (!visiblePaths.has(path)) previousDetails.current.delete(path);
    }
    const charactersById = new Map(
      Object.values(replica.entities).flatMap((entity) =>
        entity.character ? [[entity.character.id, entity] as const] : [],
      ),
    );
    const characters = launch.characterIds.flatMap((id): Character[] => {
      const entity = charactersById.get(id);
      if (!entity?.character) return [];
      const document = currentDetails.get(entity.id);
      const cached = characterCache.get(entity);
      if (cached && cached.document === document) return [cached.character];
      const character = {
        ...entity.character,
        name: document?.title ?? "正在读取角色…",
        description: document?.description ?? "",
        body: document?.body,
        image: document?.image,
        avatar: document?.avatar,
        fieldErrors: document?.fieldErrors,
        displayValues: document?.displayValues,
        displayErrors: document?.displayErrors,
        values: document?.values ?? {},
      };
      characterCache.set(entity, { document, character });
      return [character];
    });
    const references = roomDocuments(replica).map(
      (document) => currentDetails.get(document.id!) ?? document,
    );
    return {
      ...launch,
      ...(launch.workbench
        ? {
            workbench: restoreWorkbenchReferencePreviews(
              launch.workbench,
              launch.progress.workbench?.stage ?? 0,
              references,
            ),
          }
        : {}),
      config: resources.launchConfig,
      types: resources.documentTypes.map(publicDocumentType),
      ...(launch.draftView
        ? {
            draftView: computedDraftView(launch.draftView, previousDraft.current?.document),
          }
        : {}),
      openingMessage: undefined,
      characters,
      references,
    };
  }, [replica, resources, details.documents, detailEntities, draftDocument.data]);
  const previewError =
    details.error ??
    (draft ? draftDocument.error : undefined) ??
    (details.invalid || (draft && draftDocument.data && !draftDocument.data.valid)
      ? launchPreviewError
      : undefined);
  const error = syncError ?? previewError;
  return {
    data,
    error,
    isPending: data === undefined && !error,
    isSuccess: data !== undefined,
    isFetching: details.isFetching || (!!draft && draftDocument.isFetching),
    refetch: async () => {
      const keys: readonly unknown[][] = [
        ["room-document", replica?.sections.viewerId, roomId],
        ...(draftIdentity ? [["room-draft", draftIdentity]] : []),
      ];
      if (previewError)
        await Promise.all(keys.map((queryKey) => client.cancelQueries({ queryKey })));
      connection.reconnect(Boolean(previewError));
      if (connection.getSnapshot().resources)
        await Promise.all(
          keys.map((queryKey) => client.refetchQueries({ queryKey, type: "active" })),
        );
    },
  };
}
