import { useMutation, useQuery } from "@tanstack/react-query";
import { FileArchive, Folder, FolderInput, GitBranch, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldError, FieldLabel, Form, FieldDescription } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { desktopOrpc, desktopRpc, queryClient } from "../../desktop-rpc";

type ImportSource = { kind: "zip" | "folder" } | { kind: "git"; url: string };

export function ImportModuleButton({ directory }: { directory?: string }) {
  const [open, setOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<ImportSource["kind"]>("zip");
  const [url, setUrl] = useState("");
  const [importedName, setImportedName] = useState<string | null>(null);
  const importer = useMutation({
    mutationFn: async (source: ImportSource) =>
      source.kind === "git"
        ? await desktopRpc.modules.importGit({ url: source.url })
        : await desktopRpc.modules.importLocal(source),
    onSuccess: async (module, source) => {
      if (source.kind !== "git" && !module) return;
      if (!module) {
        setOpen(false);
        return;
      }
      setImportedName(module.name);
      await queryClient.invalidateQueries(desktopOrpc.modules.list.queryOptions());
      setOpen(false);
      setUrl("");
    },
  });
  const importState = useQuery({
    ...desktopOrpc.modules.importState.queryOptions(),
    enabled: importer.isPending && importer.variables?.kind !== "git",
    staleTime: 0,
    refetchInterval: 250,
  });
  const importing =
    importer.isPending &&
    importState.dataUpdatedAt > importer.submittedAt &&
    importState.data?.status === "running";
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {importedName ? (
        <p role="status" className="text-muted-foreground text-xs">
          已导入「{importedName}」
        </p>
      ) : null}
      <Button
        variant="outline"
        className="h-8 gap-1.5 rounded-lg px-3 text-xs"
        onClick={() => {
          importer.reset();
          setImportedName(null);
          setOpen(true);
        }}
      >
        <FolderInput className="size-3.5" aria-hidden="true" />
        导入模组
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!importer.isPending) setOpen(next);
        }}
      >
        <DialogContent
          className="gap-6 rounded-2xl p-6 sm:max-w-md"
          showCloseButton={!importer.isPending}
        >
          <DialogHeader>
            <DialogTitle>导入模组</DialogTitle>
            <DialogDescription>
              选择 ZIP、文件夹或 Git 仓库，将模组保存到你的模组库。
            </DialogDescription>
          </DialogHeader>
          <Tabs
            value={sourceKind}
            onValueChange={(value) => {
              if (importer.isPending || !value) return;
              setSourceKind(value as ImportSource["kind"]);
              importer.reset();
            }}
          >
            <TabsList className="w-full" aria-label="模组导入方式">
              <TabsTrigger value="zip" disabled={importer.isPending}>
                <FileArchive aria-hidden="true" />
                ZIP
              </TabsTrigger>
              <TabsTrigger value="folder" disabled={importer.isPending}>
                <Folder aria-hidden="true" />
                文件夹
              </TabsTrigger>
              <TabsTrigger value="git" disabled={importer.isPending}>
                <GitBranch aria-hidden="true" />
                Git
              </TabsTrigger>
            </TabsList>
            <TabsContent value="zip" className="space-y-4 pt-3">
              <p className="text-muted-foreground text-sm leading-6">
                选择一份模组 ZIP。支持直接打包模组内容，或在外层保留模组文件夹。
              </p>
              <Button
                className="w-full"
                disabled={importer.isPending}
                onClick={() => importer.mutate({ kind: "zip" })}
              >
                {importing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <FileArchive className="size-4" aria-hidden="true" />
                )}
                {importing
                  ? "正在导入并校验…"
                  : importer.isPending
                    ? "请选择 ZIP 文件…"
                    : "选择 ZIP 文件并导入"}
              </Button>
            </TabsContent>
            <TabsContent value="folder" className="space-y-4 pt-3">
              <p className="text-muted-foreground text-sm leading-6">
                选择包含 module.toml 或 module.json 的完整模组文件夹，也可以选择包含 module/
                的仓库目录。应用会复制模组内容到模组库，保留原文件夹。
              </p>
              <Button
                className="w-full"
                disabled={importer.isPending}
                onClick={() => importer.mutate({ kind: "folder" })}
              >
                {importing ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Folder className="size-4" aria-hidden="true" />
                )}
                {importing
                  ? "正在导入并校验…"
                  : importer.isPending
                    ? "请选择文件夹…"
                    : "选择文件夹并导入"}
              </Button>
            </TabsContent>
            <TabsContent value="git" className="pt-3">
              <Form
                className="space-y-4"
                aria-busy={importer.isPending}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (url.trim() && !importer.isPending)
                    importer.mutate({
                      kind: "git",
                      url: url.trim(),
                    });
                }}
              >
                <Field
                  name="url"
                  className="space-y-2 text-sm"
                  validate={(value) =>
                    String(value ?? "").trim() ? null : "请填写 Git 仓库地址。"
                  }
                >
                  <FieldLabel>Git 仓库地址</FieldLabel>
                  <Input
                    autoFocus
                    aria-required
                    maxLength={2048}
                    className="h-10"
                    placeholder="https://github.com/作者/模组.git"
                    value={url}
                    disabled={importer.isPending}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <FieldDescription className="text-muted-foreground block text-xs leading-5">
                    支持 HTTPS、SSH 地址；私有仓库使用本机已有的 Git 凭据。
                  </FieldDescription>
                  <FieldError />
                </Field>
                <p className="text-muted-foreground text-xs leading-5">
                  导入默认分支的最新内容，仓库须在 module/
                  中提供完整模组。同一仓库已导入时会询问是否替换，替换会丢弃本地修改。
                </p>
                <Button type="submit" className="w-full" disabled={importer.isPending}>
                  {importer.isPending ? (
                    <>
                      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                      正在下载并校验…
                    </>
                  ) : (
                    "导入模组"
                  )}
                </Button>
              </Form>
            </TabsContent>
          </Tabs>
          {directory ? (
            <p className="text-muted-foreground text-xs leading-5 break-all">保存到：{directory}</p>
          ) : null}
          {importer.error ? (
            <p role="alert" className="text-destructive text-sm break-words whitespace-pre-wrap">
              {importer.error.message}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
