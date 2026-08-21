import { Link } from "wouter";
import { useListVenomApps, type VenomApp } from "@workspace/api-client-react";
import {
  Hexagon,
  Plus,
  ArrowRight,
  PackageSearch,
  Activity,
  ServerCrash,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import CreateAppDialog from "@/components/workspace/apps/create-app-dialog";
import { resolveAppPortfolioState } from "@/lib/appPortfolio";
import { cn } from "@/lib/utils";

export default function AppsPage() {
  const { data, isLoading, isError, isFetching, refetch } = useListVenomApps();
  // The response is never trusted to be a list: a failing or unauthenticated
  // backend answers with an error payload, and rendering it directly would
  // crash the whole workspace route instead of this page's error state.
  const portfolio = resolveAppPortfolioState({ data, isLoading, isError });

  return (
    <div className="flex h-full flex-col bg-background relative overflow-hidden">
      {/* Edgy background detail */}
      <div className="absolute top-0 right-0 -mr-32 -mt-32 w-[500px] h-[500px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none animate-breathe" />

      <header className="shrink-0 border-b border-border/60 px-6 py-8 relative z-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between max-w-6xl mx-auto">
          <div>
            <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-foreground">
              <Hexagon className="h-6 w-6 text-foreground" strokeWidth={2} aria-hidden="true" />
              Apps
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Product records, source packages, and deployments
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <Link href="/workspace/builds/new">
              <Button
                variant="outline"
                className="rounded-md border-border/60 shadow-soft font-medium"
              >
                <PackageSearch className="mr-2 h-4 w-4" />
                New build
              </Button>
            </Link>
            <CreateAppDialog>
              <Button
                className="rounded-md shadow-soft font-medium"
                data-testid="button-create-app"
              >
                <Plus className="mr-2 h-4 w-4" />
                New app
              </Button>
            </CreateAppDialog>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-6xl mx-auto">
          {portfolio.status === "loading" ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-48 rounded-xl border border-border/60 bg-muted/20 surface"
                />
              ))}
            </div>
          ) : portfolio.status === "error" ? (
            <div
              className="flex h-64 flex-col items-center justify-center border border-dashed border-destructive/30 bg-destructive/5 text-destructive p-8 text-center rounded-xl"
              role="alert"
              data-testid="status-apps-error"
            >
              <ServerCrash className="h-12 w-12 mb-4 opacity-80" />
              <h3 className="text-lg font-semibold tracking-tight">
                 Portfolio unavailable
              </h3>
              <p className="text-sm mt-2 opacity-80 max-w-md">
                {portfolio.reason === "malformed-response"
                  ? "Your app records came back in an unexpected shape. Try again in a moment."
                  : "We could not load your app records. Try again in a moment."}
              </p>
              <Button
                variant="outline"
                className="mt-6 rounded-md font-medium border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
                onClick={() => {
                  void refetch();
                }}
                disabled={isFetching}
                data-testid="button-retry-apps"
              >
                {isFetching ? "Retrying" : "Try again"}
              </Button>
            </div>
          ) : portfolio.status === "empty" ? (
            <div className="flex flex-col items-center justify-center py-24 text-center border border-border/60 rounded-xl surface">
              <PackageSearch className="h-16 w-16 text-muted-foreground mb-6 opacity-50" strokeWidth={1} />
              <h3 className="text-xl font-semibold tracking-tight mb-2">
                 No apps registered
              </h3>
              <p className="text-muted-foreground text-sm max-w-sm mb-8">
                 Add a product record when you are ready to track its source history.
              </p>
              <CreateAppDialog>
                <Button 
                  variant="outline" 
                  className="rounded-md font-medium border-border/60 shadow-soft"
                  data-testid="button-create-first-app"
                >
                   Register first app
                </Button>
              </CreateAppDialog>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {portfolio.apps.map((app) => (
                <AppCard key={app.id} app={app} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AppCard({ app }: { app: VenomApp }) {
  return (
    <Link 
      href={`/workspace/apps/${app.id}`}
      className="group relative flex h-full flex-col border border-border/60 surface rounded-xl p-5 shadow-soft transition-all hover:border-foreground/30 hover:shadow-lift focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring overflow-hidden cursor-pointer"
      data-testid={`card-app-${app.id}`}
    >
      {/* Hover accent line */}
      <div className="absolute left-0 top-0 h-full w-1 bg-foreground transform -translate-x-full group-hover:translate-x-0 transition-transform duration-300 ease-out" />

      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-xs text-muted-foreground mb-1">
            {app.brand}
          </div>
          <h3 className="text-lg font-semibold tracking-tight group-hover:underline underline-offset-4 decoration-foreground/30">
            {app.name}
          </h3>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <AppStatusBadge status={app.status} />
          {app.improvementSignal && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full border border-foreground/40 bg-foreground/5 text-foreground"
              data-testid={`badge-new-data-${app.id}`}
            >
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              New data
            </span>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2 mb-6 font-medium leading-relaxed flex-1">
        {app.purpose}
      </p>

      <div className="mt-auto pt-4 border-t border-border/60 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-foreground/70">
          {app.sourceType === "none" ? (
            <span className="opacity-50">Unlinked</span>
          ) : (
            <>
              <span className="font-semibold">v{app.sourceVersion}</span>
              <span className="w-1 h-1 bg-foreground rounded-full opacity-30" />
              <span>{app.sourceType}</span>
            </>
          )}
        </div>
        <ArrowRight className="h-4 w-4 text-foreground/40 group-hover:text-foreground transform group-hover:translate-x-1 transition-all" />
      </div>
    </Link>
  );
}

function AppStatusBadge({ status }: { status: VenomApp["status"] }) {
  return (
    <div
      className={cn(
        "px-2 py-1 text-xs font-medium capitalize rounded-full flex items-center gap-1.5",
        status === "ready"
          ? "bg-foreground text-background"
          : status === "importing"
          ? "bg-muted text-foreground border border-border"
          : status === "attention"
          ? "bg-destructive text-destructive-foreground animate-pulse"
          : "bg-transparent text-muted-foreground border border-border/50",
      )}
    >
      {status === "importing" && <Activity className="w-3 h-3 animate-pulse" />}
      {status}
    </div>
  );
}
