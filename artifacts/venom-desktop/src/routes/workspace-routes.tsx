import { type ReactNode, Suspense, lazy, useEffect } from "react";
import { useAuth } from "@clerk/react";
import { AnimatePresence } from "framer-motion";
import { Redirect, Route, Switch, useLocation } from "wouter";
import WorkspaceLayout from "@/components/layout/Shell";
import { WorkspaceRouteFallback } from "@/components/route-fallback";
import { VenomWorkspaceProvider } from "@/context/venom-workspace";
import { SharedWorkspaceProvider } from "@/context/shared-workspace";
import { prefetchOnIdle } from "@/lib/prefetch-routes";
import NotFound from "@/pages/not-found";

/**
 * Each workspace page is its own chunk. Brain drags in the WebGL slime field,
 * Apps drags in the form/validation stack, and Chat and To-Do are the two
 * largest pages by source size, so none of them belong in the first download.
 *
 * The loaders are hoisted so they can double as prefetch handles below.
 */
const loadChat = () => import("@/pages/workspace/chat");
const loadFeed = () => import("@/pages/workspace/feed");
const loadThreadDetail = () => import("@/pages/workspace/feed/thread/[threadId]");
const loadBrain = () => import("@/pages/workspace/brain");
const loadTasks = () => import("@/pages/workspace/tasks");
const loadApps = () => import("@/pages/workspace/apps/index");
const loadAppDetail = () => import("@/pages/workspace/apps/[id]");
const loadTemplates = () => import("@/pages/workspace/templates");

const loadBuildNew = () => import("@/pages/workspace/builds/new");
const loadBuildDetail = () => import("@/pages/workspace/builds/[id]");
const loadSops = () => import("@/pages/workspace/sops/index");
const loadSopDetail = () => import("@/pages/workspace/sops/[id]");

const loadNotifications = () => import("@/pages/workspace/notifications/index");

const loadCompany = () => import("@/pages/workspace/company");
// Canon is a super-admin-only surface: lazy like the rest, but deliberately
// left out of the WORKSPACE_LOADERS prefetch group — for almost every
// account the chunk would be dead weight.
const loadCanon = () => import("@/pages/workspace/canon");
const ChatPage = lazy(loadChat);
const FeedPage = lazy(loadFeed);
const ThreadDetailPage = lazy(loadThreadDetail);
const BrainPage = lazy(loadBrain);
const TasksPage = lazy(loadTasks);
const AppsPage = lazy(loadApps);
const AppDetailPage = lazy(loadAppDetail);
const TemplatesPage = lazy(loadTemplates);

const BuildNewPage = lazy(loadBuildNew);
const BuildDetailPage = lazy(loadBuildDetail);
const SopsPage = lazy(loadSops);
const SopDetailPage = lazy(loadSopDetail);

const NotificationsPage = lazy(loadNotifications);

const CompanyPage = lazy(loadCompany);
const CanonPage = lazy(loadCanon);
const WORKSPACE_LOADERS = [
  loadChat,
  loadFeed,
  loadThreadDetail,
  loadTasks,
  loadApps,
  loadTemplates,
  loadSops,
  loadBrain,
  loadAppDetail,
  loadBuildNew,
  loadBuildDetail,
  loadSopDetail,
  loadNotifications,
  loadCompany,
] as const;

/**
 * Keys the workspace state to the signed-in account so switching users cannot
 * reuse another account's hydrated state.
 */
function AccountScopedWorkspace({ children }: { children: ReactNode }) {
  const { userId } = useAuth();

  return (
    <VenomWorkspaceProvider key={userId ?? "signed-out"}>
      <SharedWorkspaceProvider>{children}</SharedWorkspaceProvider>
    </VenomWorkspaceProvider>
  );
}

export default function WorkspaceRoutes() {
  return (
    <AccountScopedWorkspace>
      <WorkspacePages />
    </AccountScopedWorkspace>
  );
}

function WorkspacePages() {
  const [location] = useLocation();

  // Warm the sibling tabs once the current page has painted, so tab switching
  // keeps its instant, animated feel instead of waiting on a fetch.
  useEffect(() => prefetchOnIdle(WORKSPACE_LOADERS), []);

  return (
    <WorkspaceLayout>
      <AnimatePresence mode="wait" initial={false}>
        <Suspense key={location} fallback={<WorkspaceRouteFallback />}>
          <Switch location={location}>
            <Route path="/workspace">
              <Redirect to="/workspace/chat" />
            </Route>
            <Route path="/workspace/chat" component={ChatPage} />
            <Route path="/workspace/feed" component={FeedPage} />
            <Route
              path="/workspace/feed/thread/:threadId"
              component={ThreadDetailPage}
            />
            <Route path="/workspace/brain" component={BrainPage} />
            <Route path="/workspace/tasks" component={TasksPage} />
            <Route path="/workspace/apps" component={AppsPage} />
            <Route path="/workspace/apps/:id" component={AppDetailPage} />
            <Route path="/workspace/templates" component={TemplatesPage} />
            <Route path="/workspace/builds/new" component={BuildNewPage} />
            <Route path="/workspace/builds/:id" component={BuildDetailPage} />
            <Route path="/workspace/sops" component={SopsPage} />
            <Route path="/workspace/sops/:id" component={SopDetailPage} />
            <Route path="/workspace/notifications" component={NotificationsPage} />
            <Route path="/workspace/company" component={CompanyPage} />
            <Route path="/workspace/canon" component={CanonPage} />
            <Route component={NotFound} />
          </Switch>
        </Suspense>
      </AnimatePresence>
    </WorkspaceLayout>
  );
}
