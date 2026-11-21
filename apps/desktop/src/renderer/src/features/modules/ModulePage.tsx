import { typeFormatLabel } from "@jointarp/module/document-path";
import { searchItems } from "@shared/query";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { BookOpenText, FileCode2, FileText, MapIcon, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageToolbarHeader } from "../../components/StickyPageToolbar";
import { desktopOrpc } from "../../desktop-rpc";
import { DocumentImageScope } from "./document-image";
import { DocumentLibraryScope } from "./document-library-context";
import { DocumentReferences } from "./DocumentReferences";
import { DocumentTypesPage } from "./DocumentTypesPage";
import { LaunchOverviewPage } from "./LaunchOverviewPage";
import { MapInspector } from "./MapInspector";
import { ModuleDocuments } from "./ModuleDocuments";
import {
  creationPageIcon,
  creationPageId,
  preludePageIcon,
  preludePageId,
  startsPageIcon,
  startsPageId,
  typesPageId,
  typesPageIcon,
  type ModuleNavGroup,
  type ModuleNavItem,
} from "./ModuleNavigation";
import { ModuleReading } from "./ModuleReading";
import { ModuleWorkspace } from "./ModuleWorkspace";

const untypedId = "__untyped__";

export function ModulePage() {
  const { path, type, page, define, reading } = useSearch({ from: "/module" });
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDocumentPath, setSelectedDocumentPath] = useState<string | null>(null);
  const loaded = useQuery(desktopOrpc.modules.load.queryOptions({ input: { path } }));
  const opened = loaded.error
    ? {
        status: "error" as const,
        message: loaded.error instanceof Error ? loaded.error.message : "打开模组失败",
      }
    : (loaded.data ?? null);

  useEffect(() => {
    setSelectedDocumentPath(null);
  }, [path, type]);

  const documentItems = useMemo((): readonly ModuleNavItem[] => {
    if (opened?.status !== "success") return [];
    const types: ModuleNavItem[] = opened.documentTypes.map((documentType) => ({
      id: documentType.id,
      label: documentType.name,
      icon:
        typeFormatLabel(documentType.id, opened.documents) === "Markdown" ? FileText : FileCode2,
    }));
    if (opened.documents.some((document) => !document.docType)) {
      return [...types, { id: untypedId, label: "未分类", icon: FileCode2 }];
    }
    return types;
  }, [opened]);

  const readingItems = useMemo((): readonly ModuleNavItem[] => {
    if (opened?.status !== "success") return [];
    return opened.pages.map((item) => ({
      id: `reading:${item.path}`,
      label: item.title,
      icon: BookOpenText,
      reading: item.path,
    }));
  }, [opened]);

  const navGroups = useMemo((): readonly ModuleNavGroup[] => {
    const typesItem: ModuleNavItem = {
      id: typesPageId,
      label: "文档类型",
      icon: typesPageIcon,
      page: "types",
    };
    const documents = searchQuery.trim()
      ? searchItems(documentItems, searchQuery, (item) => [item.label, item.id])
      : documentItems;
    const metaItems: ModuleNavItem[] = [
      typesItem,
      { id: "maps", label: "地图校对", icon: MapIcon, page: "maps" },
      { id: preludePageId, label: "开场文案", icon: preludePageIcon, page: "prelude" },
      { id: startsPageId, label: "开局方案", icon: startsPageIcon, page: "starts" },
      { id: creationPageId, label: "角色创建", icon: creationPageIcon, page: "creation" },
    ];
    const meta = searchQuery.trim()
      ? searchItems(metaItems, searchQuery, (item) => [item.label])
      : metaItems;
    const readings = searchQuery.trim()
      ? searchItems(readingItems, searchQuery, (item) => [item.label, item.reading ?? ""])
      : readingItems;
    return [
      ...(readings.length > 0 ? [{ label: "阅读", items: readings }] : []),
      ...(documents.length > 0 ? [{ label: "文档", items: documents }] : []),
      ...(meta.length > 0 ? [{ label: "模组", items: meta }] : []),
    ];
  }, [documentItems, readingItems, searchQuery]);

  const onTypesPage = !reading && page === "types";
  const selectedReading =
    opened?.status === "success" && reading
      ? opened.pages.find((item) => item.path === reading)
      : undefined;
  const activeId = reading
    ? `reading:${reading}`
    : onTypesPage
      ? typesPageId
      : type && documentItems.some((item) => item.id === type)
        ? type
        : (documentItems[0]?.id ?? null);

  const selectedDocuments =
    opened?.status === "success"
      ? opened.documents.filter((document) =>
          activeId === untypedId ? !document.docType : document.docType === activeId,
        )
      : [];
  const documentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (opened?.status !== "success") return counts;
    for (const document of opened.documents) {
      if (!document.docType) continue;
      counts.set(document.docType, (counts.get(document.docType) ?? 0) + 1);
    }
    return counts;
  }, [opened]);
  const selectedDocumentType =
    opened?.status === "success"
      ? opened.documentTypes.find((documentType) => documentType.id === activeId)
      : undefined;
  const title =
    selectedDocumentType?.name ??
    (activeId === untypedId ? "未分类" : opened ? "打开失败" : "正在打开…");

  return (
    <DocumentImageScope scope={`module:${opened?.status === "success" ? opened.path : path}`}>
      <DocumentLibraryScope>
        <DocumentReferences
          documents={opened?.status === "success" ? opened.documents : []}
          types={opened?.status === "success" ? opened.documentTypes : []}
        >
          <ModuleWorkspace
            modulePath={path}
            groups={navGroups}
            searchQuery={searchQuery}
            activeId={reading ? activeId : (page ?? activeId)}
            onSearchChange={setSearchQuery}
          >
            {opened?.status === "error" ? (
              <>
                <PageToolbarHeader
                  widthClassName="max-w-4xl"
                  title="打开失败"
                  description="无法打开这个模组"
                />
                <div className="mx-auto w-full max-w-4xl px-9">
                  <div
                    className="border-destructive/30 bg-destructive/5 mt-10 flex gap-3 rounded-xl border p-4 text-sm"
                    role="alert"
                  >
                    <TriangleAlert
                      className="text-destructive mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span>{opened.message}</span>
                  </div>
                </div>
              </>
            ) : null}
            {opened?.status === "success" && page === "maps" && !reading ? (
              <MapInspector key={path} path={path} />
            ) : null}
            {opened?.status === "success" && onTypesPage ? (
              <DocumentTypesPage
                modulePath={path}
                documentTypes={opened.documentTypes}
                documents={opened.documents}
                documentCounts={documentCounts}
                defineId={define}
              />
            ) : null}
            {opened?.status === "success" &&
            !reading &&
            (page === "prelude" || page === "starts" || page === "creation") ? (
              <LaunchOverviewPage
                modulePath={path}
                page={page}
                metadata={opened.metadata}
                documentTypes={opened.documentTypes}
                documents={opened.documents}
                defineId={define}
              />
            ) : null}
            {opened?.status === "success" && selectedReading ? (
              <ModuleReading page={selectedReading} />
            ) : null}
            {opened?.status === "success" && reading && !selectedReading ? (
              <>
                <PageToolbarHeader widthClassName="max-w-5xl" title="找不到这篇" />
                <div className="mx-auto w-full max-w-5xl px-9">
                  <p className="text-muted-foreground mt-10 text-sm" role="alert">
                    module.json / module.toml 的 pages 里没有 {reading}
                  </p>
                </div>
              </>
            ) : null}
            {opened?.status === "success" && !page && !reading ? (
              <>
                <PageToolbarHeader
                  widthClassName="max-w-5xl"
                  title={title}
                  description={`${selectedDocuments.length} 份文档`}
                  resetKey={activeId ?? "documents"}
                />
                <div className="mx-auto w-full max-w-5xl px-9">
                  <div className="mt-10">
                    <ModuleDocuments
                      documents={selectedDocuments}
                      documentTypes={opened.documentTypes}
                      selectedDocumentPath={selectedDocumentPath}
                      onSelectDocument={setSelectedDocumentPath}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </ModuleWorkspace>
        </DocumentReferences>
      </DocumentLibraryScope>
    </DocumentImageScope>
  );
}
