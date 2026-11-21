import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { AppShell } from "./components/AppShell";
import { AppUpdateNotice } from "./components/AppUpdateNotice";
import { SettingsLayer } from "./components/SettingsLayer";
import { desktopOrpc, queryClient } from "./desktop-rpc";
import { HomePage, ModuleLibraryPage } from "./features/modules/HomePage";
import { HomeCatalogSkeleton } from "./features/modules/ModuleCardList";
import { ModuleImportNotice } from "./features/modules/ModuleImportNotice";
import { ModulePage } from "./features/modules/ModulePage";
import { ModulePagePending } from "./features/modules/ModuleWorkspace";
import { GamePage } from "./features/sessions/GamePage";
import { HistoryPage } from "./features/sessions/HistoryPage";
import { ModuleReferencePage } from "./features/sessions/ModuleReferencePage";
import { RoomSettingsPage } from "./features/sessions/RoomSettingsPage";

interface RootSearch {
  readonly overlay?: "settings";
}

function RootLayout() {
  return (
    <>
      <Outlet />
      <SettingsLayer />
      <AppUpdateNotice />
      <ModuleImportNotice />
    </>
  );
}

const rootRoute = createRootRoute({
  validateSearch: (search: Record<string, unknown>): RootSearch => ({
    overlay: search.overlay === "settings" ? "settings" : undefined,
  }),
  component: RootLayout,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppShell,
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  loader: () => queryClient.fetchQuery(desktopOrpc.modules.list.queryOptions({ staleTime: 0 })),
  pendingComponent: HomeCatalogSkeleton,
  component: HomePage,
});

const moduleLibraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/modules",
  loader: () => queryClient.fetchQuery(desktopOrpc.modules.list.queryOptions({ staleTime: 0 })),
  pendingComponent: HomeCatalogSkeleton,
  component: ModuleLibraryPage,
});

const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/history",
  component: HistoryPage,
});

interface ModuleSearch {
  readonly path: string;
  readonly type?: string;
  readonly page?: "types" | "prelude" | "starts" | "creation" | "maps";
  readonly define?: string;
  readonly reading?: string;
}

const moduleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/module",
  validateSearch: (search: Record<string, unknown>): ModuleSearch => {
    if (typeof search.path !== "string" || search.path.trim().length === 0) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      path: search.path,
      type: typeof search.type === "string" && search.type.length > 0 ? search.type : undefined,
      page:
        search.page === "types" ||
        search.page === "prelude" ||
        search.page === "starts" ||
        search.page === "creation" ||
        search.page === "maps"
          ? search.page
          : undefined,
      define:
        typeof search.define === "string" && search.define.length > 0 ? search.define : undefined,
      reading:
        typeof search.reading === "string" && search.reading.length > 0
          ? search.reading
          : undefined,
    };
  },
  loaderDeps: ({ search }) => ({ path: search.path }),
  loader: ({ deps }) =>
    queryClient.fetchQuery(
      desktopOrpc.modules.load.queryOptions({ input: { path: deps.path }, staleTime: 0 }),
    ),
  pendingComponent: ModulePagePending,
  component: ModulePage,
});

const settingsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({
      to: "/",
      search: { overlay: "settings" },
      replace: true,
    });
  },
});

const referenceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reference/$roomId",
  component: ModuleReferencePage,
});

const gameRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/game/$roomId",
  component: GamePage,
});
const roomSettingsRoute = createRoute({
  getParentRoute: () => gameRoute,
  path: "settings",
  component: RoomSettingsPage,
});

const routeTree = rootRoute.addChildren([
  appRoute.addChildren([homeRoute, moduleLibraryRoute, historyRoute]),
  moduleRoute,
  referenceRoute,
  gameRoute.addChildren([roomSettingsRoute]),
  settingsRedirectRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  defaultPendingMs: 120,
  defaultPendingMinMs: 220,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
