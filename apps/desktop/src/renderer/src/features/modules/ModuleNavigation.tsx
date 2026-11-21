import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import {
  ArrowLeft,
  BookOpen,
  Flag,
  Search,
  Shapes,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Button, buttonVariants } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from "../../components/ui/scroll-area";

export const typesPageId = "types";
export const preludePageId = "prelude";
export const startsPageId = "starts";
export const creationPageId = "creation";
export type ModuleMetaPage = "types" | "prelude" | "starts" | "creation" | "maps";

export interface ModuleNavItem {
  readonly icon: LucideIcon;
  readonly id: string;
  readonly label: string;
  readonly page?: ModuleMetaPage;
  /** module.json / module.toml pages 里的 Markdown 路径。 */
  readonly reading?: string;
}

export interface ModuleNavGroup {
  readonly items: readonly ModuleNavItem[];
  readonly label: string;
}

export function moduleNavItemClass(active: boolean) {
  return cn(
    buttonVariants({ variant: "ghost" }),
    "h-9 w-full justify-start gap-3 px-2.5 text-sm",
    active
      ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-foreground/5"
      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
  );
}

export function ModuleNavSearch({
  searchQuery,
  pending = false,
  onSearchChange,
}: {
  readonly searchQuery: string;
  readonly pending?: boolean;
  readonly onSearchChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
      <Input
        className="bg-sidebar-accent/60 placeholder:text-muted-foreground/70 focus-visible:bg-sidebar-accent h-9 border-transparent pl-9"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="搜索…"
        aria-label="搜索菜单"
        disabled={pending}
      />
    </div>
  );
}

export function ModuleNavScroll({ children }: { readonly children: ReactNode }) {
  return (
    <nav className="mt-7 min-h-0 flex-1" aria-label="模组导航">
      <ScrollArea className="h-full">
        <ScrollAreaViewport>
          <ScrollAreaContent className="space-y-6">{children}</ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollAreaScrollbar>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollArea>
    </nav>
  );
}

function ModuleNavPending() {
  return (
    <div className="space-y-1" aria-hidden="true">
      {["w-24", "w-20", "w-28"].map((width) => (
        <div className={`bg-sidebar-accent/70 h-9 rounded-md ${width}`} key={width} />
      ))}
    </div>
  );
}

export function ModuleNavGroups({
  groups,
  activeId,
  children,
}: {
  readonly groups: readonly ModuleNavGroup[];
  readonly activeId: string | null;
  readonly children: (item: ModuleNavItem, active: boolean) => ReactNode;
}) {
  if (groups.length === 0) {
    return <p className="text-muted-foreground px-2.5 text-sm">没有匹配的项目</p>;
  }
  return groups.map((group) => (
    <div key={group.label}>
      <p className="text-muted-foreground mb-2 px-2 text-xs font-medium">{group.label}</p>
      <div className="space-y-1">
        {group.items.map((item) => children(item, item.id === activeId))}
      </div>
    </div>
  ));
}

export function ModuleNavIcon({
  item,
  active,
}: {
  readonly item: ModuleNavItem;
  readonly active: boolean;
}) {
  const Icon = item.icon;
  return <Icon className="size-4" strokeWidth={active ? 2 : 1.8} aria-hidden="true" />;
}

/** 模组库侧栏：返回模组库，并用路由切换阅读页、文档类型和模组页。 */
export function ModuleNavigation({
  modulePath,
  groups,
  searchQuery,
  activeId,
  pending = false,
  onSearchChange,
}: {
  readonly modulePath?: string;
  readonly groups: readonly ModuleNavGroup[];
  readonly searchQuery: string;
  readonly activeId: string | null;
  readonly pending?: boolean;
  readonly onSearchChange: (value: string) => void;
}) {
  return (
    <aside className="border-border/60 bg-sidebar text-sidebar-foreground flex w-64 shrink-0 flex-col border-r px-3 pt-16 pb-4">
      <Link
        data-ui-control
        className={cn(
          buttonVariants({ variant: "ghost" }),
          "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground mb-4 w-full justify-start gap-2 px-2.5 [-webkit-app-region:no-drag]",
        )}
        to="/modules"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        返回模组库
      </Link>
      <ModuleNavSearch
        searchQuery={searchQuery}
        pending={pending}
        onSearchChange={onSearchChange}
      />
      <ModuleNavScroll>
        {pending ? (
          <ModuleNavPending />
        ) : (
          <ModuleNavGroups groups={groups} activeId={activeId}>
            {(item, active) =>
              modulePath ? (
                <Link
                  data-ui-control
                  className={moduleNavItemClass(active)}
                  key={item.id}
                  to="/module"
                  search={
                    item.reading
                      ? { path: modulePath, reading: item.reading }
                      : item.page
                        ? { path: modulePath, page: item.page }
                        : { path: modulePath, type: item.id }
                  }
                  replace
                  preload={false}
                  aria-current={active ? "page" : undefined}
                >
                  <ModuleNavIcon item={item} active={active} />
                  {item.label}
                </Link>
              ) : (
                <Button
                  className={moduleNavItemClass(active)}
                  key={item.id}
                  variant="ghost"
                  disabled
                >
                  <ModuleNavIcon item={item} active={active} />
                  {item.label}
                </Button>
              )
            }
          </ModuleNavGroups>
        )}
      </ModuleNavScroll>
    </aside>
  );
}

export {
  Shapes as typesPageIcon,
  BookOpen as preludePageIcon,
  Flag as startsPageIcon,
  UserRound as creationPageIcon,
};
