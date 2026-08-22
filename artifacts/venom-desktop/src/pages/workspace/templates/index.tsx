import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { motion } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListVenomBuildTemplates,
  useGetVenomBuildTemplate,
  useUseVenomBuildTemplate,
  getListVenomBuildTemplatesQueryKey,
  getGetVenomBuildTemplateQueryKey,
  getListVenomAppsQueryKey,
  type VenomBuildTemplateSummary,
} from "@workspace/api-client-react";
import {
  LayoutTemplate,
  ArrowRight,
  CheckCircle2,
  Package,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const TARGET_TYPE_LABELS: Record<string, string> = {
  app: "Application",
  website: "Website",
  brand: "Brand asset",
  customer_service_flow: "Service flow",
};

type CategoryFilter = "all" | "app" | "widget";

/**
 * Global template gallery: curated starting points anyone can browse and
 * use. Templates are read-only here by design — "Use this template" creates
 * a normal portfolio app plus a pre-filled build request, and everything
 * stays editable before generation.
 */
export default function TemplatesPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [appName, setAppName] = useState("");

  const listQuery = useListVenomBuildTemplates({
    query: { queryKey: getListVenomBuildTemplatesQueryKey() },
  });
  // The generated client resolves failed requests to the JSON error body,
  // so the array shape must be proven before anything maps over it.
  const templates: VenomBuildTemplateSummary[] = Array.isArray(listQuery.data)
    ? listQuery.data
    : [];
  const listBroken = !listQuery.isLoading && !Array.isArray(listQuery.data);

  const visibleTemplates = useMemo(
    () =>
      filter === "all"
        ? templates
        : templates.filter((template) => template.category === filter),
    [templates, filter],
  );

  const detailQuery = useGetVenomBuildTemplate(selectedId ?? "", {
    query: {
      enabled: !!selectedId,
      queryKey: getGetVenomBuildTemplateQueryKey(selectedId ?? ""),
    },
  });
  const detail =
    selectedId &&
    detailQuery.data &&
    typeof detailQuery.data === "object" &&
    "requirements" in detailQuery.data
      ? detailQuery.data
      : null;

  const useTemplate = useUseVenomBuildTemplate();

  const openTemplate = (id: string) => {
    setAppName("");
    setSelectedId(id);
  };

  const handleUse = async () => {
    if (!selectedId) return;
    try {
      const result = await useTemplate.mutateAsync({
        templateId: selectedId,
        data: appName.trim() ? { name: appName.trim() } : {},
      });
      // The new app belongs in every portfolio listing immediately.
      void queryClient.invalidateQueries({
        queryKey: getListVenomAppsQueryKey(),
      });
      toast({
        title: "App created from template",
        description:
          "The build request is pre-filled — review and edit everything before generating.",
      });
      setSelectedId(null);
      setLocation(
        `/workspace/builds/new?appId=${result.app.id}&templateId=${result.templateId}`,
      );
    } catch (err: any) {
      toast({
        title: "Could not use this template",
        description: err?.message || "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-background relative overflow-hidden">
      <div className="absolute top-0 left-1/3 -mt-40 w-[560px] h-[560px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none" />

      <header className="shrink-0 border-b border-border/60 px-6 py-8 relative z-10">
        <div className="max-w-5xl mx-auto flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-foreground flex items-center gap-3">
              <LayoutTemplate
                className="h-8 w-8 text-foreground"
                strokeWidth={2.5}
              />
              Templates
            </h1>
            <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
              Curated starting points for apps and widgets. Pick one, make it
              yours, and it flows through the same review and approval as any
              other build.
            </p>
          </div>

          <div
            role="group"
            aria-label="Filter templates by category"
            className="flex items-center gap-1 border border-border/60 rounded-md p-1 shadow-soft"
          >
            {(
              [
                { id: "all", label: "All" },
                { id: "app", label: "Apps" },
                { id: "widget", label: "Widgets" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setFilter(option.id)}
                aria-pressed={filter === option.id}
                data-testid={`button-filter-${option.id}`}
                className={cn(
                  "px-3 h-8 text-xs font-medium rounded-sm transition-colors",
                  filter === option.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-5xl mx-auto pb-24">
          {listQuery.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-44 rounded-xl" />
              ))}
            </div>
          ) : listBroken ? (
            <div
              role="alert"
              data-testid="status-templates-error"
              className="border border-border/60 surface rounded-xl p-8 text-center shadow-soft"
            >
              <p className="text-sm font-medium">
                The template gallery could not be read.
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                This is not an empty gallery — the request failed.
              </p>
              <Button
                variant="outline"
                className="mt-4 rounded-md"
                onClick={() => void listQuery.refetch()}
                disabled={listQuery.isFetching}
                data-testid="button-retry-templates"
              >
                {listQuery.isFetching ? "Retrying…" : "Try again"}
              </Button>
            </div>
          ) : visibleTemplates.length === 0 ? (
            <div
              data-testid="status-templates-empty"
              className="border border-border/60 surface rounded-xl p-8 text-center shadow-soft"
            >
              <p className="text-sm font-medium">No templates here yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                {filter === "all"
                  ? "The global gallery is empty right now."
                  : "Nothing in this category yet — try another filter."}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {visibleTemplates.map((template, index) => (
                <motion.button
                  key={template.id}
                  type="button"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: index * 0.04 }}
                  onClick={() => openTemplate(template.id)}
                  data-testid={`card-template-${template.slug}`}
                  className="group text-left border border-border/60 surface rounded-xl p-5 shadow-soft hover:border-foreground/40 hover:shadow-lift transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 border border-border/60 rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      {template.category === "app" ? "App" : "Widget"}
                    </span>
                    {template.hasExamplePackage && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground"
                        title="Includes an example approved package"
                      >
                        <Package className="h-3 w-3" /> Example included
                      </span>
                    )}
                  </div>
                  <h2 className="text-base font-semibold tracking-tight mt-3 group-hover:underline underline-offset-4">
                    {template.name}
                  </h2>
                  <p className="text-sm text-muted-foreground mt-2 line-clamp-3">
                    {template.description}
                  </p>
                  <div className="flex items-center gap-1.5 text-xs font-medium mt-4 text-foreground">
                    View template
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={!!selectedId}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          {!detail ? (
            detailQuery.isLoading ? (
              <div className="space-y-3 py-6">
                <Skeleton className="h-6 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <div
                role="alert"
                data-testid="status-template-detail-error"
                className="py-6 text-sm text-destructive"
              >
                This template could not be read. Close and try again.
              </div>
            )
          ) : (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center border border-border/60 rounded-sm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {detail.category === "app" ? "App" : "Widget"}
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    {TARGET_TYPE_LABELS[detail.targetType] ?? detail.targetType}
                  </span>
                </div>
                <DialogTitle
                  className="text-xl tracking-tight"
                  data-testid="text-template-detail-name"
                >
                  {detail.name}
                </DialogTitle>
                <DialogDescription>{detail.description}</DialogDescription>
              </DialogHeader>

              <div className="space-y-5 text-sm">
                {detail.previewSummary && (
                  <div className="border border-border/60 rounded-md p-4 bg-foreground/[0.03]">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" /> What this produces
                    </h3>
                    <p className="leading-relaxed">{detail.previewSummary}</p>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                    Requirements skeleton
                  </h3>
                  <p className="leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {detail.requirements}
                  </p>
                </div>

                {detail.brandDirection && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                      Brand direction
                    </h3>
                    <p className="leading-relaxed text-muted-foreground">
                      {detail.brandDirection}
                    </p>
                  </div>
                )}

                {detail.acceptanceChecks.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                      Acceptance checks
                    </h3>
                    <ul className="space-y-1.5">
                      {detail.acceptanceChecks.map((check, index) => (
                        <li key={index} className="flex items-start gap-2">
                          <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                          <span className="text-muted-foreground">{check}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {detail.examplePackage && (
                  <div className="border border-border/60 rounded-md p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1.5">
                      <Package className="h-3.5 w-3.5" /> Example approved
                      package
                    </h3>
                    <p className="text-muted-foreground">
                      “{detail.examplePackage.title}” ships with this template
                      as reference material for generation.
                    </p>
                  </div>
                )}

                {detail.networkImprovementCount > 0 && (
                  <div
                    className="border border-border/60 rounded-md p-4 bg-foreground/[0.03]"
                    data-testid="text-template-network-note"
                  >
                    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1 flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5" /> Learned from the
                      network
                    </h3>
                    <p className="text-muted-foreground">
                      This template has picked up{" "}
                      {detail.networkImprovementCount} improvement
                      {detail.networkImprovementCount === 1
                        ? ""
                        : "s"}{" "}
                      from how builders refined their packages — shared
                      anonymously, applied automatically to new builds.
                    </p>
                  </div>
                )}

                <div className="border-t border-border/60 pt-5 space-y-3">
                  <div className="space-y-2">
                    <Label htmlFor="template-app-name" className="text-sm">
                      Name your app{" "}
                      <span className="text-xs text-muted-foreground">
                        (optional)
                      </span>
                    </Label>
                    <Input
                      id="template-app-name"
                      value={appName}
                      onChange={(event) => setAppName(event.target.value)}
                      placeholder={detail.targetName}
                      maxLength={120}
                      className="rounded-md border-border/60 h-10 shadow-soft"
                      data-testid="input-template-app-name"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-xs text-muted-foreground max-w-xs">
                      Creates an app in your portfolio and pre-fills a build
                      request. Nothing is generated until you submit it.
                    </p>
                    <Button
                      onClick={() => void handleUse()}
                      disabled={useTemplate.isPending}
                      className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium h-11 px-6 shadow-soft shrink-0"
                      data-testid="button-use-template"
                    >
                      {useTemplate.isPending ? (
                        "Creating…"
                      ) : (
                        <>
                          Use this template
                          <ArrowRight className="ml-2 h-4 w-4" />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
