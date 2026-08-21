import { useEffect, useRef, useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import {
  useGetVenomSop,
  useUpdateVenomSop,
  usePublishVenomSop,
  useArchiveVenomSop,
  useDuplicateVenomSop,
  useAssignVenomSopApps,
  useListVenomApps,
  getGetVenomSopQueryKey,
  type VenomSopRevision,
  type VenomSopUpdate,
} from "@workspace/api-client-react";
import {
  ScrollText,
  ArrowLeft,
  Trash2,
  AlertTriangle,
  Loader2,
  Save,
  CheckCircle2,
  Copy,
  Archive,
  ShieldAlert,
  Hexagon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import { asList } from "@/lib/as-list";

export default function SopDetailPage() {
  const [, params] = useRoute("/workspace/sops/:id");
  const [, setLocation] = useLocation();
  const sopId = params?.id;
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail, isLoading, isError } = useGetVenomSop(sopId!, {
    query: {
      enabled: !!sopId,
      queryKey: getGetVenomSopQueryKey(sopId!),
    },
  });

  const { data: appsResponse } = useListVenomApps();
  const appsData = asList(appsResponse);

  const updateSop = useUpdateVenomSop();
  const publishSop = usePublishVenomSop();
  const archiveSop = useArchiveVenomSop();
  const duplicateSop = useDuplicateVenomSop();
  const assignApps = useAssignVenomSopApps();

  const [localData, setLocalData] = useState<VenomSopUpdate | null>(null);
  const [localAppIds, setLocalAppIds] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(
    null,
  );
  const initializedForId = useRef<string | null>(null);

  useEffect(() => {
    if (detail && initializedForId.current !== detail.sop.id) {
      initializedForId.current = detail.sop.id;
      setLocalAppIds(new Set(detail.assignments.map(a => a.appId)));
      setLocalData({
        title: detail.sop.title,
        category: detail.sop.category,
        tags: [...detail.sop.tags],
        provenance: detail.sop.provenance,
        content: {
          purpose: detail.sop.content.purpose,
          prerequisites: [...detail.sop.content.prerequisites],
          inputs: [...detail.sop.content.inputs],
          guidance: [...detail.sop.content.guidance],
          requiredApprovals: [...detail.sop.content.requiredApprovals],
          acceptanceChecks: [...detail.sop.content.acceptanceChecks],
        },
      });
      setSelectedRevisionId(detail.revisions[0]?.id ?? null);
    }
  }, [detail]);

  if (isLoading || !localData) {
    return (
      <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
        <Skeleton className="h-12 w-64 rounded-lg bg-muted/20" />
        <Skeleton className="h-[600px] rounded-xl bg-muted/20" />
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
        <h2 className="text-xl font-semibold tracking-tight">
          SOP Not Found
        </h2>
        <p className="text-muted-foreground text-sm mt-2 mb-6">
          This SOP does not exist or belongs to another workspace.
        </p>
        <Link 
          href="/workspace/sops"
          className="inline-flex items-center justify-center whitespace-nowrap text-sm h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md font-medium"
        >
          Return to Library
        </Link>
      </div>
    );
  }

  const { sop, revisions, assignments } = detail;
  const isArchived = sop.lifecycle === "archived";
  const isModelAssisted = localData.provenance !== "manual";
  const selectedRevision =
    revisions.find((revision) => revision.id === selectedRevisionId) ?? null;

  const validatedDraft = (): VenomSopUpdate | null => {
    const normalized: VenomSopUpdate = {
      ...localData,
      title: localData.title.trim(),
      tags: localData.tags.map((tag) => tag.trim()).filter(Boolean),
      content: {
        purpose: localData.content.purpose.trim(),
        prerequisites: localData.content.prerequisites.map((item) => item.trim()),
        inputs: localData.content.inputs.map((item) => item.trim()),
        guidance: localData.content.guidance.map((item) => item.trim()),
        requiredApprovals: localData.content.requiredApprovals.map((item) =>
          item.trim(),
        ),
        acceptanceChecks: localData.content.acceptanceChecks.map((item) =>
          item.trim(),
        ),
      },
    };
    if (!normalized.title) {
      setFormError("Enter a title before saving.");
      return null;
    }
    if (!normalized.content.purpose) {
      setFormError("Describe the SOP purpose before saving.");
      return null;
    }
    if (
      normalized.content.guidance.length === 0 ||
      normalized.content.guidance.some((item) => !item)
    ) {
      setFormError("Add at least one complete guidance step before saving.");
      return null;
    }
    const listEntries = [
      ...normalized.content.prerequisites,
      ...normalized.content.inputs,
      ...normalized.content.requiredApprovals,
      ...normalized.content.acceptanceChecks,
    ];
    if (listEntries.some((item) => !item)) {
      setFormError("Complete or remove every empty structured field.");
      return null;
    }
    if (
      normalized.tags.length > 20 ||
      normalized.tags.some((tag) => tag.length > 50)
    ) {
      setFormError("Use no more than 20 tags, with 50 characters per tag.");
      return null;
    }
    setFormError(null);
    setLocalData(normalized);
    return normalized;
  };

  const handleSave = () => {
    const draft = validatedDraft();
    if (!draft) return;
    updateSop.mutate(
      {
        sopId: sop.id,
        data: draft,
      },
      {
        onSuccess: (updated) => {
          // Update assignments
          assignApps.mutate({
            sopId: sop.id,
            data: { appIds: Array.from(localAppIds) }
          }, {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getGetVenomSopQueryKey(sop.id) });
              toast({
                title: "Draft Saved",
                description: "Your SOP draft and app assignments have been updated.",
              });
            },
            onError: (err: any) => {
              toast({
                title: "SOP Saved, but App Assignments Failed",
                description: err.message || "An error occurred.",
                variant: "destructive",
              });
            }
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to save",
            description: err.message || "An error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handlePublish = () => {
    const draft = validatedDraft();
    if (!draft) return;
    // Save first then publish
    updateSop.mutate(
      {
        sopId: sop.id,
        data: draft,
      },
      {
        onSuccess: () => {
          assignApps.mutate({
            sopId: sop.id,
            data: { appIds: Array.from(localAppIds) }
          }, {
            onSuccess: () => {
              publishSop.mutate(
                { sopId: sop.id },
                {
                  onSuccess: () => {
                    queryClient.invalidateQueries({ queryKey: getGetVenomSopQueryKey(sop.id) });
                    toast({
                      title: "SOP Published",
                      description: "A new immutable revision has been created.",
                    });
                  },
                  onError: (err: any) => {
                    toast({
                      title: "Failed to publish",
                      description: err.message || "An error occurred.",
                      variant: "destructive",
                    });
                  },
                }
              );
            },
            onError: (err: any) => {
              toast({
                title: "Failed to save assignments",
                description: err.message || "An error occurred.",
                variant: "destructive",
              });
            }
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to save draft",
            description: err.message || "An error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleDuplicate = () => {
    duplicateSop.mutate(
      { sopId: sop.id },
      {
        onSuccess: (newSop) => {
          toast({
            title: "SOP Duplicated",
            description: "A new draft has been created.",
          });
          setLocation(`/workspace/sops/${newSop.id}`);
        },
        onError: (err: any) => {
          toast({
            title: "Failed to duplicate",
            description: err.message || "An error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const handleArchive = () => {
    archiveSop.mutate(
      { sopId: sop.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetVenomSopQueryKey(sop.id) });
          toast({
            title: "SOP Archived",
            description: "The SOP has been archived.",
          });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to archive",
            description: err.message || "An error occurred.",
            variant: "destructive",
          });
        },
      }
    );
  };

  type ListField = Exclude<keyof VenomSopUpdate["content"], "purpose">;

  const updateContentArray = (key: ListField, index: number, value: string) => {
    const nextArr = [...localData.content[key]];
    nextArr[index] = value;
    setLocalData({
      ...localData,
      content: { ...localData.content, [key]: nextArr },
    });
  };

  const addToArray = (key: ListField) => {
    setLocalData({
      ...localData,
      content: { ...localData.content, [key]: [...localData.content[key], ""] },
    });
  };

  const removeFromArray = (key: ListField, index: number) => {
    const nextArr = [...localData.content[key]];
    nextArr.splice(index, 1);
    setLocalData({
      ...localData,
      content: { ...localData.content, [key]: nextArr },
    });
  };

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden relative">
      <div className="absolute inset-0 bg-foreground/[0.01] pointer-events-none" />

      {/* Header */}
      <header className="shrink-0 border-b border-border/60 px-6 py-6 relative z-10 bg-background/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <Link
              href="/workspace/sops"
              className="inline-flex items-center text-[10px] font-medium text-muted-foreground hover:text-foreground mb-4 transition-colors group"
            >
              <ArrowLeft className="mr-2 h-3 w-3 group-hover:-translate-x-1 transition-transform" />
              SOP Library
            </Link>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                {sop.title}
              </h1>
              <Badge variant="outline" className="rounded-md font-medium text-[9px]">
                {sop.lifecycle}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Revision: {sop.activeRevisionNumber ? `v${sop.activeRevisionNumber}` : "Draft"}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleDuplicate}
              disabled={duplicateSop.isPending}
              className="rounded-md font-medium border-border/60 hover:bg-foreground hover:text-background"
            >
              <Copy className="h-4 w-4 md:mr-2" />
              <span className="hidden md:inline">Duplicate</span>
            </Button>
            
            {!isArchived && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    className="rounded-md font-medium border-destructive/20 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-all"
                  >
                    <Archive className="h-4 w-4 md:mr-2" />
                    <span className="hidden md:inline">Archive</span>
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent className="rounded-2xl border border-border/60 bg-background p-0 sm:max-w-[420px]">
                  <div className="p-6">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-xl font-semibold tracking-tight text-destructive flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5" />
                        Archive SOP?
                      </AlertDialogTitle>
                      <AlertDialogDescription className="text-xs mt-2">
                        This SOP will be removed from active circulation but its revision history will be preserved.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="mt-8">
                      <AlertDialogCancel className="rounded-md font-medium border-border/60">Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleArchive}
                        className="rounded-md font-medium bg-destructive text-destructive-foreground"
                      >
                        Archive
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </div>
                </AlertDialogContent>
              </AlertDialog>
            )}

            {!isArchived && (
              <Button
                onClick={handleSave}
                disabled={updateSop.isPending}
                className="rounded-md font-medium bg-muted text-muted-foreground hover:bg-foreground hover:text-background transition-all"
              >
                {updateSop.isPending ? <Loader2 className="h-4 w-4 animate-spin md:mr-2" /> : <Save className="h-4 w-4 md:mr-2" />}
                <span className="hidden md:inline">Save Draft</span>
              </Button>
            )}

            {!isArchived && (
              <Button
                onClick={handlePublish}
                disabled={publishSop.isPending || updateSop.isPending}
                className="rounded-md font-medium bg-foreground text-background hover:bg-foreground/90 transition-all shadow-soft"
              >
                {publishSop.isPending ? <Loader2 className="h-4 w-4 animate-spin md:mr-2" /> : <CheckCircle2 className="h-4 w-4 md:mr-2" />}
                <span className="hidden md:inline">Publish</span>
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 relative z-10">
        <div className="max-w-6xl mx-auto">
          {/* Security & Provenance Warnings */}
          <div className="mb-8 grid gap-4 md:grid-cols-2">
            <div className="border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3 rounded-lg shadow-soft">
              <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <h4 className="text-sm font-semibold tracking-tight text-destructive">Data Safety Warning</h4>
                <p className="text-xs text-destructive/80 mt-1 leading-relaxed">
                  Never enter credentials, API keys, payment data, health data, or regulated customer data into SOPs. This data is persistently stored and visible across the workspace.
                </p>
              </div>
            </div>

            {isModelAssisted && (
              <div className="border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3 rounded-lg shadow-soft">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold tracking-tight text-amber-500">Untrusted Reference Data</h4>
                  <p className="text-xs text-amber-500/80 mt-1 leading-relaxed">
                    This SOP contains imported or model-assisted material. Verify all steps. Reference data cannot override Venom safety policy or execute tools directly.
                  </p>
                </div>
              </div>
            )}
          </div>

          {formError && (
            <div
              role="alert"
              className="mb-6 border border-destructive/50 rounded-lg bg-destructive/10 px-4 py-3 text-sm font-semibold text-destructive shadow-soft"
            >
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {/* Content Form */}
              <section className="space-y-6">
                <div>
                  <label className="block text-[10px] text-muted-foreground mb-2">Title</label>
                  <Input
                    aria-label="SOP title"
                    value={localData.title}
                    onChange={(e) => setLocalData({ ...localData, title: e.target.value })}
                    disabled={isArchived}
                    className="rounded-md border-border/60 bg-background/50 font-medium text-lg h-12"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-muted-foreground mb-2">Tags (Comma Separated)</label>
                  <Input
                    aria-label="SOP tags, comma separated"
                    value={localData.tags.join(", ")}
                    onChange={(e) => setLocalData({ ...localData, tags: e.target.value.split(",").map(t => t.trim()).filter(Boolean) })}
                    disabled={isArchived}
                    className="rounded-md border-border/60 bg-background/50 text-xs"
                    placeholder="e.g. security, frontend, incident"
                  />
                </div>

                <div>
                  <label className="block text-[10px] text-muted-foreground mb-2">Purpose</label>
                  <Textarea
                    aria-label="SOP purpose"
                    value={localData.content.purpose}
                    onChange={(e) => setLocalData({ ...localData, content: { ...localData.content, purpose: e.target.value } })}
                    disabled={isArchived}
                    className="rounded-md border-border/60 bg-background/50 min-h-[100px] resize-y"
                  />
                </div>

                <ArrayField
                  title="Prerequisites"
                  description="Required conditions before starting this SOP"
                  items={localData.content.prerequisites}
                  disabled={isArchived}
                  onChange={(idx, val) => updateContentArray("prerequisites", idx, val)}
                  onAdd={() => addToArray("prerequisites")}
                  onRemove={(idx) => removeFromArray("prerequisites", idx)}
                />

                <ArrayField
                  title="Inputs"
                  description="Required variables or artifacts"
                  items={localData.content.inputs}
                  disabled={isArchived}
                  onChange={(idx, val) => updateContentArray("inputs", idx, val)}
                  onAdd={() => addToArray("inputs")}
                  onRemove={(idx) => removeFromArray("inputs", idx)}
                />

                <ArrayField
                  title="Guidance (Ordered Steps)"
                  description="Step-by-step execution instructions"
                  items={localData.content.guidance}
                  disabled={isArchived}
                  onChange={(idx, val) => updateContentArray("guidance", idx, val)}
                  onAdd={() => addToArray("guidance")}
                  onRemove={(idx) => removeFromArray("guidance", idx)}
                  multiline
                />

                <ArrayField
                  title="Required Approvals"
                  description="Human approvals that must be obtained before completion"
                  items={localData.content.requiredApprovals}
                  disabled={isArchived}
                  onChange={(idx, val) =>
                    updateContentArray("requiredApprovals", idx, val)
                  }
                  onAdd={() => addToArray("requiredApprovals")}
                  onRemove={(idx) => removeFromArray("requiredApprovals", idx)}
                />

                <ArrayField
                  title="Acceptance Checks"
                  description="Verification conditions for completion"
                  items={localData.content.acceptanceChecks}
                  disabled={isArchived}
                  onChange={(idx, val) => updateContentArray("acceptanceChecks", idx, val)}
                  onAdd={() => addToArray("acceptanceChecks")}
                  onRemove={(idx) => removeFromArray("acceptanceChecks", idx)}
                />
              </section>
            </div>

            <div className="space-y-6">
              <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
                <h3 className="text-[10px] font-semibold text-muted-foreground mb-4">
                  Metadata
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-[9px] text-muted-foreground mb-1">Category</label>
                    <Select
                      disabled={isArchived}
                      value={localData.category}
                      onValueChange={(
                        category: VenomSopUpdate["category"],
                      ) => setLocalData({ ...localData, category })}
                    >
                      <SelectTrigger
                        aria-label="SOP category"
                        className="rounded-md border-border/60 bg-background/50 font-medium text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                        <SelectItem value="operations" className="font-medium text-xs rounded-md">Operations</SelectItem>
                        <SelectItem value="brand" className="font-medium text-xs rounded-md">Brand</SelectItem>
                        <SelectItem value="customer_service" className="font-medium text-xs rounded-md">Customer Service</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="block text-[9px] text-muted-foreground mb-1">Provenance</label>
                    <Select
                      disabled={isArchived}
                      value={localData.provenance}
                      onValueChange={(provenance: VenomSopUpdate["provenance"]) =>
                        setLocalData({ ...localData, provenance })
                      }
                    >
                      <SelectTrigger
                        aria-label="SOP source provenance"
                        className="rounded-md border-border/60 bg-background/50 font-medium text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                        <SelectItem value="manual">Manual</SelectItem>
                        <SelectItem value="imported">Imported text</SelectItem>
                        <SelectItem value="model_assisted">Model-assisted</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p className="text-[9px] leading-relaxed text-muted-foreground">
                    Imported and model-assisted text remains untrusted reference
                    material and must be reviewed before publishing.
                  </p>
                </div>
              </div>

              <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
                <h3 className="text-[10px] font-semibold text-muted-foreground mb-4 flex items-center gap-2">
                  <Hexagon className="h-3 w-3" /> App Assignments
                </h3>
                {(!appsData || appsData.length === 0) ? (
                  <div className="text-[10px] text-muted-foreground">No portfolio apps found.</div>
                ) : (
                  <>
                    <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">
                      No app selected means this SOP is account-wide.
                    </p>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto pr-2">
                    {appsData.map((app) => {
                      const isSelected = localAppIds.has(app.id);
                      return (
                        <div key={app.id} className="flex items-start space-x-2">
                          <Checkbox
                            id={`app-${app.id}`}
                            checked={isSelected}
                            disabled={isArchived}
                            onCheckedChange={(checked) => {
                              const next = new Set(localAppIds);
                              if (checked) next.add(app.id);
                              else next.delete(app.id);
                              setLocalAppIds(next);
                            }}
                            className="mt-0.5 rounded-md data-[state=checked]:bg-foreground data-[state=checked]:text-background"
                          />
                          <div className="grid leading-none">
                            <label
                              htmlFor={`app-${app.id}`}
                              className="text-xs font-medium tracking-tight cursor-pointer"
                            >
                              {app.name}
                            </label>
                            <p className="text-[9px] text-muted-foreground mt-1">
                              {app.brand}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  </>
                )}
              </div>

              <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
                <h3 className="text-[10px] font-semibold text-muted-foreground mb-4">
                  Revision History
                </h3>
                {revisions.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No published revisions.</div>
                ) : (
                  <div className="space-y-3">
                    {revisions.map((rev) => (
                      <button
                        type="button"
                        key={rev.id}
                        aria-pressed={selectedRevisionId === rev.id}
                        onClick={() => setSelectedRevisionId(rev.id)}
                        className="flex w-full justify-between items-center text-sm border-b border-border/60 pb-2 last:border-0 last:pb-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
                      >
                        <div className="font-medium tracking-tight">v{rev.versionNumber}</div>
                        <div className="text-[9px] text-muted-foreground">{new Date(rev.publishedAt).toLocaleDateString()}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          {selectedRevision && (
            <RevisionComparison
              revision={selectedRevision}
              draft={localData}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function RevisionComparison({
  revision,
  draft,
}: {
  revision: VenomSopRevision;
  draft: VenomSopUpdate;
}) {
  const fields: Array<[string, unknown, unknown]> = [
    ["Title", revision.title, draft.title],
    ["Category", revision.category, draft.category],
    ["Tags", revision.tags, draft.tags],
    ["Purpose", revision.content.purpose, draft.content.purpose],
    [
      "Prerequisites",
      revision.content.prerequisites,
      draft.content.prerequisites,
    ],
    ["Inputs", revision.content.inputs, draft.content.inputs],
    ["Guidance", revision.content.guidance, draft.content.guidance],
    [
      "Required approvals",
      revision.content.requiredApprovals,
      draft.content.requiredApprovals,
    ],
    [
      "Acceptance checks",
      revision.content.acceptanceChecks,
      draft.content.acceptanceChecks,
    ],
  ];
  const changed = fields
    .filter(([, published, current]) => {
      return JSON.stringify(published) !== JSON.stringify(current);
    })
    .map(([label]) => label);

  return (
    <section
      aria-labelledby="revision-comparison-title"
      className="mt-8 border border-border/60 surface p-5 rounded-xl shadow-soft"
    >
      <div className="mb-5">
        <h2
          id="revision-comparison-title"
          className="text-sm font-semibold"
        >
          Revision comparison — v{revision.versionNumber} to current draft
        </h2>
        <p className="mt-2 text-xs text-muted-foreground">
          {changed.length === 0
            ? "The current draft matches this immutable revision."
            : `Changed sections: ${changed.join(", ")}.`}
        </p>
        <p className="mt-1 break-all text-[10px] text-muted-foreground">
          Revision {revision.id} · SHA-256 {revision.checksumSha256}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RevisionSnapshot
          label={`Immutable v${revision.versionNumber}`}
          title={revision.title}
          category={revision.category}
          tags={revision.tags}
          content={revision.content}
        />
        <RevisionSnapshot
          label="Current mutable draft"
          title={draft.title}
          category={draft.category}
          tags={draft.tags}
          content={draft.content}
        />
      </div>
    </section>
  );
}

function RevisionSnapshot({
  label,
  title,
  category,
  tags,
  content,
}: {
  label: string;
  title: string;
  category: string;
  tags: string[];
  content: VenomSopUpdate["content"];
}) {
  const rows: Array<[string, string | string[]]> = [
    ["Title", title],
    ["Category", category.replace("_", " ")],
    ["Tags", tags],
    ["Purpose", content.purpose],
    ["Prerequisites", content.prerequisites],
    ["Inputs", content.inputs],
    ["Guidance", content.guidance],
    ["Required approvals", content.requiredApprovals],
    ["Acceptance checks", content.acceptanceChecks],
  ];
  return (
    <div className="border border-border/60 bg-background/50 p-4">
      <h3 className="mb-4 text-[10px] font-semibold text-muted-foreground">
        {label}
      </h3>
      <dl className="space-y-3">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt className="text-[9px] text-muted-foreground">
              {name}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
              {Array.isArray(value)
                ? value.length > 0
                  ? value.map((item, index) => `${index + 1}. ${item}`).join("\n")
                  : "None"
                : value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function ArrayField({
  title,
  description,
  items,
  disabled,
  onChange,
  onAdd,
  onRemove,
  multiline = false,
}: {
  title: string;
  description: string;
  items: string[];
  disabled: boolean;
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  multiline?: boolean;
}) {
  return (
    <div className="border border-border/60 surface p-5 rounded-xl shadow-soft">
      <div className="mb-4">
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="text-[10px] text-muted-foreground mt-1">{description}</p>
      </div>
      
      <div className="space-y-3">
        {items.map((item, idx) => (
          <div key={idx} className="flex gap-2 items-start">
            <div className="shrink-0 w-6 h-6 flex items-center justify-center bg-muted/30 text-[10px] font-medium text-muted-foreground rounded-md border border-border/60 mt-1">
              {idx + 1}
            </div>
            <div className="flex-1">
              {multiline ? (
                <Textarea
                  value={item}
                  aria-label={`${title} item ${idx + 1}`}
                  onChange={(e) => onChange(idx, e.target.value)}
                  disabled={disabled}
                  className="rounded-md border-border/60 bg-background/50 min-h-[80px]"
                />
              ) : (
                <Input
                  value={item}
                  aria-label={`${title} item ${idx + 1}`}
                  onChange={(e) => onChange(idx, e.target.value)}
                  disabled={disabled}
                  className="rounded-md border-border/60 bg-background/50"
                />
              )}
            </div>
            {!disabled && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => onRemove(idx)}
                aria-label={`Remove ${title} item ${idx + 1}`}
                className="shrink-0 rounded-md border-border/60 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground hover:border-destructive mt-1 h-10 w-10"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
      </div>
      
      {!disabled && (
        <Button
          type="button"
          variant="outline"
          onClick={onAdd}
          className="mt-4 rounded-md font-medium border-border/60 border-dashed w-full text-xs"
        >
          + Add Item
        </Button>
      )}
    </div>
  );
}
