import { useState, useEffect, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useCreateVenomBuildRun,
  useListVenomApps,
  useListVenomSops,
  useGetVenomApp,
  useGetVenomBuildTemplate,
  VenomBuildTargetType,
  getGetVenomAppQueryKey,
  getGetVenomBuildTemplateQueryKey,
} from "@workspace/api-client-react";
import {
  PackageSearch,
  Rocket,
  CheckCircle2,
  FileText,
  Hexagon,
  ArrowRight,
  Info,
  LayoutTemplate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { resolveAppDetailState, resolveAppPortfolioState } from "@/lib/appPortfolio";
import { resolveSopLibraryState } from "@/lib/sopLibrary";
import { useVenomWorkspace } from "@/context/venom-workspace";

export default function BuildsNewPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const presetAppId = searchParams.get("appId");
  const requestedType = searchParams.get("type");
  const presetType = (
    ["app", "website", "brand", "customer_service_flow"] as VenomBuildTargetType[]
  ).includes(requestedType as VenomBuildTargetType)
    ? requestedType as VenomBuildTargetType
    : null;
  const presetName = searchParams.get("name") || "";
  const presetReq = searchParams.get("requirements") || "";
  
  const presetProjectId = searchParams.get("projectId");
  const presetTemplateId = searchParams.get("templateId");
  
  const { toast } = useToast();
  const { state: workspaceState } = useVenomWorkspace();
  
  const [targetType, setTargetType] = useState<VenomBuildTargetType>(presetType || "app");
  const [targetName, setTargetName] = useState(presetName);
  const [requirements, setRequirements] = useState(presetReq);
  const [constraints, setConstraints] = useState("");
  const [brandDirection, setBrandDirection] = useState("");
  const [appId, setAppId] = useState<string>(presetAppId || "");
  const [projectId, setProjectId] = useState<string>(presetProjectId || workspaceState?.activeProjectId || "");
  const [sourceVersionId, setSourceVersionId] = useState<string>("");
  const [selectedSopIds, setSelectedSopIds] = useState<Set<string>>(new Set());
  
  // Data fetching. The generated client resolves failed requests (401/5xx)
  // to the JSON error body as data, so every record-shaped payload here is
  // resolved into an explicit state before anything reads it. The pickers
  // must also tell a broken source apart from a genuinely empty one — a
  // silently empty picker misleads during build creation.
  const appsQuery = useListVenomApps();
  const appsState = useMemo(
    () =>
      resolveAppPortfolioState({
        data: appsQuery.data,
        isLoading: appsQuery.isLoading,
        isError: appsQuery.isError,
      }),
    [appsQuery.data, appsQuery.isLoading, appsQuery.isError],
  );
  const apps = appsState.status === "ready" ? appsState.apps : [];

  const sopsQuery = useListVenomSops();
  const sopsState = useMemo(
    () =>
      resolveSopLibraryState({
        data: sopsQuery.data,
        isLoading: sopsQuery.isLoading,
        isError: sopsQuery.isError,
      }),
    [sopsQuery.data, sopsQuery.isLoading, sopsQuery.isError],
  );
  const sops = sopsState.status === "ready" ? sopsState.sops : [];

  const appDetailQuery = useGetVenomApp(appId, {
    query: { enabled: !!appId, queryKey: getGetVenomAppQueryKey(appId) }
  });
  const appDetailState = useMemo(
    () =>
      resolveAppDetailState({
        data: appDetailQuery.data,
        isLoading: appDetailQuery.isLoading,
        isError: appDetailQuery.isError,
      }),
    [appDetailQuery.data, appDetailQuery.isLoading, appDetailQuery.isError],
  );
  const appDetail =
    appDetailState.status === "ready" ? appDetailState.detail : null;

  const createRun = useCreateVenomBuildRun();

  // Template-started requests pre-fill the form from the template itself.
  // The generated client resolves error bodies as data, so the shape is
  // proven before anything reads it.
  const templateQuery = useGetVenomBuildTemplate(presetTemplateId ?? "", {
    query: {
      enabled: !!presetTemplateId,
      queryKey: getGetVenomBuildTemplateQueryKey(presetTemplateId ?? ""),
    },
  });
  const template =
    presetTemplateId &&
    templateQuery.data &&
    typeof templateQuery.data === "object" &&
    "requirements" in templateQuery.data
      ? templateQuery.data
      : null;
  const [templateApplied, setTemplateApplied] = useState(false);
  useEffect(() => {
    if (!template || templateApplied) return;
    // Fill once, and only fields the user (or an explicit URL preset) has
    // not already provided — everything stays editable afterwards.
    setTemplateApplied(true);
    if (!presetType) {
      setTargetType(template.targetType);
    }
    setTargetName((current) => current || template.targetName);
    setRequirements((current) => current || template.requirements);
    setConstraints((current) => current || template.constraints);
    setBrandDirection((current) => current || template.brandDirection);
  }, [template, templateApplied, presetType]);

  // Set default source version when app details load
  useEffect(() => {
    if (appDetail && appDetail.versions.length > 0 && !sourceVersionId) {
      setSourceVersionId(appDetail.versions[0].id);
    }
  }, [appDetail, sourceVersionId]);
  
  // Auto-fill brand direction and name if app selected and fields are empty.
  // Template-started runs skip this: the template is the source of truth
  // for those fields, and the app row it just created echoes the template
  // name rather than a real brand direction.
  useEffect(() => {
    if (appDetail && !presetTemplateId) {
      if (!brandDirection) setBrandDirection(appDetail.app.brand || "");
      if (!targetName) setTargetName(appDetail.app.name || "");
    }
  }, [appDetail, brandDirection, targetName, presetTemplateId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!targetName.trim() || !requirements.trim()) {
      toast({
        title: "Missing fields",
        description: "Target name and requirements are required.",
        variant: "destructive"
      });
      return;
    }
    
    try {
      const run = await createRun.mutateAsync({
        data: {
          targetType,
          targetName,
          requirements,
          constraints,
          brandDirection,
          appId: appId || null,
          sourceVersionId: sourceVersionId || null,
          projectId: projectId || null,
          sopRevisionIds: Array.from(selectedSopIds),
          templateId: presetTemplateId || null,
          idempotencyKey: crypto.randomUUID()
        }
      });
      
      toast({
        title: "Build request submitted",
        description: "Your request is being compiled into a build package."
      });
      
      setLocation(`/workspace/builds/${run.id}`);
    } catch (err: any) {
      toast({
        title: "Submission failed",
        description: err.message || "Failed to create build run.",
        variant: "destructive"
      });
    }
  };

  const toggleSop = (id: string) => {
    const newIds = new Set(selectedSopIds);
    if (newIds.has(id)) {
      newIds.delete(id);
    } else {
      newIds.add(id);
    }
    setSelectedSopIds(newIds);
  };

  return (
    <div className="flex h-full flex-col bg-background relative overflow-hidden">
      {/* Background detail */}
      <div className="absolute top-0 right-0 -mr-32 -mt-32 w-[500px] h-[500px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none" />

      <header className="shrink-0 border-b border-border/60 px-6 py-8 relative z-10">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground flex items-center gap-3">
            <PackageSearch className="h-8 w-8 text-foreground" strokeWidth={2.5} />
            New build request
          </h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
            Compile raw intent into a durable, reviewable build package before execution.
          </p>
          {template && (
            <div
              data-testid="banner-template-origin"
              className="mt-4 inline-flex items-start gap-2 border border-border/60 rounded-md px-3 py-2 bg-foreground/[0.03] text-sm"
            >
              <LayoutTemplate className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Started from the <strong>{template.name}</strong> template —
                every field below is editable before anything is generated.
              </span>
            </div>
          )}
        </div>
      </header>
      
      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto space-y-12 pb-24">
          
          {/* Target Type */}
          <section className="space-y-4">
            <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 flex items-center gap-2">
              <span className="bg-foreground text-background w-5 h-5 flex items-center justify-center text-xs rounded-full">1</span>
              Target specification
            </h2>
            
            <div className="space-y-4">
              <RadioGroup
                value={targetType}
                onValueChange={(val) => setTargetType(val as VenomBuildTargetType)}
                className="grid grid-cols-2 md:grid-cols-4 gap-4"
              >
                {[
                  { id: "app", label: "Application" },
                  { id: "website", label: "Website" },
                  { id: "brand", label: "Brand asset" },
                  { id: "customer_service_flow", label: "Service flow" }
                ].map(type => (
                  <div key={type.id} className="relative">
                    <RadioGroupItem
                      value={type.id}
                      id={`type-${type.id}`}
                      className="peer sr-only"
                    />
                    <Label
                      htmlFor={`type-${type.id}`}
                      className="flex flex-col items-center justify-between rounded-lg border border-border/60 surface p-4 shadow-soft hover:border-foreground/30 peer-data-[state=checked]:border-foreground peer-data-[state=checked]:bg-foreground/[0.05] peer-data-[state=checked]:shadow-lift cursor-pointer transition-all"
                    >
                      <span className="text-sm font-medium text-center mt-2">
                        {type.label}
                      </span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              
              <div className="space-y-2">
                <Label htmlFor="targetName" className="text-sm font-medium">
                  Target name
                </Label>
                <Input
                  id="targetName"
                  value={targetName}
                  onChange={(e) => setTargetName(e.target.value)}
                  placeholder="e.g. Acme Admin Portal"
                  className="rounded-md border-border/60 focus-visible:ring-2 h-10 shadow-soft"
                  maxLength={120}
                  required
                />
              </div>
            </div>
          </section>

          {/* Context Links */}
          <section className="space-y-4">
            <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 flex items-center gap-2">
              <span className="bg-foreground text-background w-5 h-5 flex items-center justify-center text-xs rounded-full">2</span>
              Workspace context
            </h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <Label htmlFor="appContext" className="text-sm font-medium flex items-center gap-2">
                  <Hexagon className="h-4 w-4" /> Link application
                </Label>
                <div className="text-xs text-muted-foreground">
                  Base the build on an existing app's source history. Apps that already have an approved version continue through Improve this app on their record, so every new version builds on its baseline.
                </div>
                
                <div className="flex flex-col gap-2">
                  <select
                    id="appContext"
                    value={appId}
                    onChange={(e) => {
                      setAppId(e.target.value);
                      setSourceVersionId("");
                    }}
                    className="flex h-10 w-full border border-border/60 bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 appearance-none rounded-md shadow-soft"
                  >
                    <option value="">None (standalone build)</option>
                    {apps.filter(app => !app.latestIterationNumber || app.id === presetAppId).map(app => (
                      <option key={app.id} value={app.id}>{app.name} ({app.brand})</option>
                    ))}
                  </select>

                  {appsState.status === "error" && (
                    <p
                      role="alert"
                      data-testid="status-build-apps-error"
                      className="text-xs text-destructive leading-relaxed"
                    >
                      The app portfolio could not be read, so existing apps
                      cannot be linked right now — this is not an empty
                      portfolio. Standalone builds still work.{" "}
                      <button
                        type="button"
                        onClick={() => void appsQuery.refetch()}
                        disabled={appsQuery.isFetching}
                        className="underline underline-offset-2 font-medium disabled:opacity-50"
                        data-testid="button-retry-build-apps"
                      >
                        {appsQuery.isFetching ? "Retrying…" : "Try again"}
                      </button>
                    </p>
                  )}

                  {appId && appDetailState.status === "error" && (
                    <p
                      role="alert"
                      data-testid="status-build-versions-error"
                      className="text-xs text-destructive leading-relaxed"
                    >
                      This app's source versions could not be read, so a
                      source version cannot be pinned right now.{" "}
                      <button
                        type="button"
                        onClick={() => void appDetailQuery.refetch()}
                        disabled={appDetailQuery.isFetching}
                        className="underline underline-offset-2 font-medium disabled:opacity-50"
                        data-testid="button-retry-build-versions"
                      >
                        {appDetailQuery.isFetching ? "Retrying…" : "Try again"}
                      </button>
                    </p>
                  )}

                  {appId && appDetail && (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                      <Label htmlFor="versionContext" className="text-xs font-medium mb-1 block">
                        Source version
                      </Label>
                      <select
                        id="versionContext"
                        value={sourceVersionId}
                        onChange={(e) => setSourceVersionId(e.target.value)}
                        className="flex h-10 w-full border border-border/60 bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring appearance-none rounded-md shadow-soft"
                      >
                        {appDetail.versions.length === 0 ? (
                          <option value="">No versions available</option>
                        ) : (
                          appDetail.versions.map(v => (
                            <option key={v.id} value={v.id}>v{v.versionNumber} ({v.archiveFilename})</option>
                          ))
                        )}
                      </select>
                    </div>
                  )}
                </div>
              </div>
              
              <div className="space-y-3">
                <Label className="text-sm font-medium flex items-center gap-2">
                  <FileText className="h-4 w-4" /> Standard operating procedures
                </Label>
                <div className="text-xs text-muted-foreground">
                  Attach active SOP revisions as strict build constraints.
                </div>
                
                <div className="max-h-[150px] overflow-y-auto border border-border/60 p-2 space-y-1 bg-background/50 rounded-md shadow-soft">
                  {sopsState.status === "error" ? (
                    <div
                      role="alert"
                      data-testid="status-build-sops-error"
                      className="text-xs text-destructive p-2 leading-relaxed"
                    >
                      The SOP library could not be read, so procedures cannot
                      be attached right now — this is not an empty library.{" "}
                      <button
                        type="button"
                        onClick={() => void sopsQuery.refetch()}
                        disabled={sopsQuery.isFetching}
                        className="underline underline-offset-2 font-medium disabled:opacity-50"
                        data-testid="button-retry-build-sops"
                      >
                        {sopsQuery.isFetching ? "Retrying…" : "Try again"}
                      </button>
                    </div>
                  ) : sopsState.status === "loading" ? (
                    <div className="text-xs text-muted-foreground p-2">
                      Loading SOPs…
                    </div>
                  ) : sops.length === 0 ? (
                    <div className="text-xs text-muted-foreground p-2">
                      No SOPs available
                    </div>
                  ) : (
                    sops.filter(sop => sop.activeRevisionId).map(sop => (
                      <button
                        type="button"
                        key={sop.id}
                        aria-pressed={selectedSopIds.has(sop.activeRevisionId!)}
                        onClick={() => toggleSop(sop.activeRevisionId!)}
                        className={cn(
                          "w-full text-left flex items-center gap-2 p-2 text-sm transition-colors rounded-sm",
                          selectedSopIds.has(sop.activeRevisionId!) 
                            ? "bg-foreground/10 font-semibold" 
                            : "hover:bg-accent hover:text-accent-foreground"
                        )}
                      >
                        <div className={cn(
                          "w-4 h-4 border rounded-full flex items-center justify-center",
                          selectedSopIds.has(sop.activeRevisionId!) ? "border-foreground bg-foreground text-background" : "border-border/60"
                        )}>
                          {selectedSopIds.has(sop.activeRevisionId!) && <CheckCircle2 className="w-2 h-2" />}
                        </div>
                        <span className="truncate">{sop.title}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Parameters */}
          <section className="space-y-6">
            <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 flex items-center gap-2">
              <span className="bg-foreground text-background w-5 h-5 flex items-center justify-center text-xs rounded-full">3</span>
              Build directives
            </h2>
            
            <div className="space-y-2">
              <Label htmlFor="requirements" className="text-sm font-medium flex justify-between">
                Core requirements <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="requirements"
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="What exactly needs to be built? Be as detailed as possible regarding functionality, scope, and user flows..."
                className="rounded-md border-border/60 focus-visible:ring-2 min-h-[150px] text-sm resize-y shadow-soft"
                maxLength={8000}
                required
              />
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <Label htmlFor="constraints" className="text-sm font-medium flex items-center gap-2">
                  Technical constraints
                  <span className="text-xs text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="constraints"
                  value={constraints}
                  onChange={(e) => setConstraints(e.target.value)}
                  placeholder="Specific technologies to use or avoid, performance budgets, compliance requirements..."
                  className="rounded-md border-border/60 focus-visible:ring-2 min-h-[100px] text-sm resize-none shadow-soft"
                  maxLength={4000}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="brandDirection" className="text-sm font-medium flex items-center gap-2">
                  Brand & aesthetic direction
                  <span className="text-xs text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="brandDirection"
                  value={brandDirection}
                  onChange={(e) => setBrandDirection(e.target.value)}
                  placeholder="Visual language, tone of voice, existing brand guidelines to follow..."
                  className="rounded-md border-border/60 focus-visible:ring-2 min-h-[100px] text-sm resize-none shadow-soft"
                  maxLength={3000}
                />
              </div>
            </div>
          </section>

          {/* Submission */}
          <div className="pt-6 border-t border-border/60 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-muted-foreground max-w-[200px] md:max-w-md">
              <Info className="h-4 w-4 shrink-0" />
              Submitting will draft a reviewable package. No code is executed until the package is approved.
            </div>
            
            <Button
              type="submit"
              disabled={createRun.isPending || !targetName.trim() || !requirements.trim()}
              className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium h-12 px-8 shadow-soft"
            >
              {createRun.isPending ? "Compiling..." : (
                <>
                  Draft package <Rocket className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
          
        </form>
      </div>
    </div>
  );
}
