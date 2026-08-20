import { Link } from "wouter";
import { useListVenomApps, type VenomApp } from "@workspace/api-client-react";
import {
  Hexagon,
  Plus,
  ArrowRight,
  PackageSearch,
  Activity,
  ServerCrash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import CreateAppDialog from "@/components/workspace/apps/create-app-dialog";
import { cn } from "@/lib/utils";

export default function AppsPage() {
  const { data: apps, isLoading, isError } = useListVenomApps();

  return (
    <div className="flex h-full flex-col bg-background relative overflow-hidden">
      {/* Edgy background detail */}
      <div className="absolute top-0 right-0 -mr-32 -mt-32 w-[500px] h-[500px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none animate-breathe" />

      <header className="shrink-0 border-b border-border/40 px-6 py-8 relative z-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between max-w-6xl mx-auto">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tighter text-foreground flex items-center gap-3">
              <Hexagon className="h-8 w-8 text-foreground animate-pulse" strokeWidth={2.5} />
              App Portfolio
            </h1>
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mt-2">
              Track product records, source packages, and existing deployments
            </p>
          </div>

          <CreateAppDialog>
            <Button
              className="rounded-none bg-foreground text-background hover:bg-foreground/90 transition-transform hover:scale-[1.02] active:scale-[0.98] font-bold uppercase tracking-widest shadow-2xl"
              data-testid="button-create-app"
            >
              <Plus className="mr-2 h-4 w-4" />
               New App
            </Button>
          </CreateAppDialog>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-6xl mx-auto">
          {isLoading ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton
                  key={i}
                  className="h-48 rounded-none border border-border/50 bg-muted/20"
                />
              ))}
            </div>
          ) : isError ? (
            <div className="flex h-64 flex-col items-center justify-center border-2 border-dashed border-destructive/20 bg-destructive/5 text-destructive p-8 text-center">
              <ServerCrash className="h-12 w-12 mb-4 opacity-80" />
              <h3 className="text-lg font-black uppercase tracking-widest">
                 Portfolio unavailable
              </h3>
              <p className="text-sm font-mono mt-2 opacity-80 max-w-md">
                 We could not load your app records. Try again in a moment.
              </p>
            </div>
          ) : apps?.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center border border-border/20 bg-foreground/[0.01]">
              <PackageSearch className="h-16 w-16 text-muted-foreground mb-6 opacity-50" strokeWidth={1} />
              <h3 className="text-xl font-black uppercase tracking-tighter mb-2">
                 No apps registered
              </h3>
              <p className="text-muted-foreground font-mono text-sm max-w-sm mb-8 uppercase tracking-widest">
                 Add a product record when you are ready to track its source history.
              </p>
              <CreateAppDialog>
                <Button 
                  variant="outline" 
                  className="rounded-none uppercase font-bold tracking-widest border-foreground/20 hover:bg-foreground hover:text-background transition-colors"
                  data-testid="button-create-first-app"
                >
                   Register first app
                </Button>
              </CreateAppDialog>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {apps?.map((app) => (
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
      className="group relative flex h-full flex-col border border-border/40 bg-card p-5 transition-all hover:border-foreground/50 hover:bg-foreground/[0.02] hover:shadow-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground overflow-hidden cursor-pointer"
      data-testid={`card-app-${app.id}`}
    >
      {/* Hover accent line */}
      <div className="absolute left-0 top-0 h-full w-1 bg-foreground transform -translate-x-full group-hover:translate-x-0 transition-transform duration-300 ease-out" />

      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
            {app.brand}
          </div>
          <h3 className="text-lg font-black uppercase tracking-tight group-hover:underline underline-offset-4 decoration-foreground/30">
            {app.name}
          </h3>
        </div>
        <AppStatusBadge status={app.status} />
      </div>

      <p className="text-sm text-muted-foreground line-clamp-2 mb-6 font-medium leading-relaxed flex-1">
        {app.purpose}
      </p>

      <div className="mt-auto pt-4 border-t border-border/30 flex items-center justify-between text-xs font-mono uppercase tracking-widest">
        <div className="flex items-center gap-2 text-foreground/70">
          {app.sourceType === "none" ? (
            <span className="opacity-50">Unlinked</span>
          ) : (
            <>
              <span className="font-bold">v{app.sourceVersion}</span>
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
        "px-2 py-1 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5",
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
