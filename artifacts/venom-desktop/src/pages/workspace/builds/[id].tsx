import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useRoute } from "wouter";
import {
 useGetVenomBuildRun,
 useCancelVenomBuildRun,
 useRetryVenomBuildRun,
 useReviseVenomBuildRun,
 useApproveVenomBuildRun,
 useRejectVenomBuildRun,
 exportVenomBuildRun,
 getGetVenomBuildRunQueryKey,
 useGetProvisioningCapability,
 useListProvisioningRuns,
 useGetProvisioningRun,
 useProvisionBuildRun,
 useCancelProvisioningRun,
 useRetryProvisioningRun,
 usePublishProvisioningCandidate,
 useRollbackProvisioningRelease,
 useGetVenomApp,
 getListProvisioningRunsQueryKey,
 getGetProvisioningRunQueryKey,
 getGetVenomAppQueryKey,
 getListVenomAppsQueryKey,
} from "@workspace/api-client-react";
import {
 PackageSearch,
 ArrowLeft,
 XCircle,
 CheckCircle2,
 RefreshCw,
 AlertTriangle,
 FileCode2,
 Download,
 Activity,
 MessageSquareText,
 Ban,
 ThumbsUp,
 ThumbsDown,
 Server,
 Rocket,
 Globe,
 GitCommit,
 History,
 Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
 Dialog,
 DialogContent,
 DialogDescription,
 DialogFooter,
 DialogHeader,
 DialogTitle,
 DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { resolveAppDetailState } from "@/lib/appPortfolio";
import {
 resolveBuildRunDetailState,
 resolveProvisioningRunsState,
 resolveProvisioningRunDetailState,
} from "@/lib/buildRuns";
import { useQueryClient } from "@tanstack/react-query";

export default function BuildsDetailPage() {
 const [, params] = useRoute("/workspace/builds/:id");
 const buildId = params?.id;
 const { toast } = useToast();
 const queryClient = useQueryClient();

 const [cancelReason, setCancelReason] = useState("");
 const [rejectReason, setRejectReason] = useState("");
 const [reviseInstruction, setReviseInstruction] = useState("");

 const [isCancelOpen, setIsCancelOpen] = useState(false);
 const [isRejectOpen, setIsRejectOpen] = useState(false);
 const [isReviseOpen, setIsReviseOpen] = useState(false);
 const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
 const [comparisonRevisionId, setComparisonRevisionId] = useState<string | null>(null);

 // Provisioning state
 const [isProvisionOpen, setIsProvisionOpen] = useState(false);
 const [provisionConfirmName, setProvisionConfirmName] = useState("");
 const provisionIdempotencyRef = useRef<string>("");

 const [isPublishOpen, setIsPublishOpen] = useState(false);
 const [publishConfirmName, setPublishConfirmName] = useState("");
 const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
 const publishIdempotencyRef = useRef<string>("");

 const [isRollbackOpen, setIsRollbackOpen] = useState(false);
 const [rollbackConfirmName, setRollbackConfirmName] = useState("");
 const rollbackIdempotencyRef = useRef<string>("");

 const [cancelProvReason, setCancelProvReason] = useState("");
 const [isCancelProvOpen, setIsCancelProvOpen] = useState(false);

 const runQuery = useGetVenomBuildRun(buildId!, {
 query: {
 enabled: !!buildId,
 queryKey: getGetVenomBuildRunQueryKey(buildId!),
 refetchInterval: (query) => {
 if (query.state.data?.status === "queued" || query.state.data?.status === "preparing") {
 return 2000;
 }
 return false;
 },
 },
 });
 // The generated client resolves failed requests (401/5xx) to the JSON
 // error body as data, so the run is validated before anything reads it —
 // the same contract as the SOP detail and App detail pages.
 const runState = useMemo(
 () =>
 resolveBuildRunDetailState({
 data: runQuery.data,
 isLoading: runQuery.isLoading,
 isError: runQuery.isError,
 }),
 [runQuery.data, runQuery.isLoading, runQuery.isError],
 );
 const run = runState.status === "ready" ? runState.run : null;

 const cancelRun = useCancelVenomBuildRun();
 const retryRun = useRetryVenomBuildRun();
 const reviseRun = useReviseVenomBuildRun();
 const approveRun = useApproveVenomBuildRun();
 const rejectRun = useRejectVenomBuildRun();

 const refreshData = () => {
 queryClient.invalidateQueries({ queryKey: getGetVenomBuildRunQueryKey(buildId!) });
 };

 // Provisioning Hooks
 const { data: capability } = useGetProvisioningCapability();

 const provRunsQuery = useListProvisioningRuns({ buildRunId: buildId! }, {
 query: {
 enabled: !!buildId,
 queryKey: getListProvisioningRunsQueryKey({ buildRunId: buildId! }),
 }
 });
 const provRunsState = useMemo(
 () =>
 resolveProvisioningRunsState({
 data: provRunsQuery.data,
 isLoading: provRunsQuery.isLoading,
 isError: provRunsQuery.isError,
 }),
 [provRunsQuery.data, provRunsQuery.isLoading, provRunsQuery.isError],
 );

 const latestProvRunId =
 provRunsState.status === "ready" ? provRunsState.runs[0]?.id : undefined;

 const provRunQuery = useGetProvisioningRun(latestProvRunId!, {
 query: {
 enabled: !!latestProvRunId,
 queryKey: getGetProvisioningRunQueryKey(latestProvRunId!),
 refetchInterval: (query) => {
 // The callback sees the raw payload before the resolver runs, so a
 // non-string status (an error body) must stop the poll, not sustain it.
 const status = query.state.data?.status;
 if (typeof status === "string" && !["candidate_ready", "published", "cancelled", "failed", "blocked"].includes(status)) {
 return 2000;
 }
 return false;
 },
 }
 });
 const provRunState = useMemo(
 () =>
 resolveProvisioningRunDetailState({
 data: provRunQuery.data,
 isLoading: provRunQuery.isLoading,
 isError: provRunQuery.isError,
 enabled: !!latestProvRunId,
 }),
 [provRunQuery.data, provRunQuery.isLoading, provRunQuery.isError, latestProvRunId],
 );
 const provRun = provRunState.status === "ready" ? provRunState.run : null;

 const appDetailQuery = useGetVenomApp(provRun?.appId ?? '', {
 query: {
 enabled: !!provRun?.appId,
 queryKey: getGetVenomAppQueryKey(provRun?.appId ?? ''),
 }
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

 // A provisioning read that failed or came back unreadable must not render
 // as "never provisioned": pretending the section is pristine invites a
 // duplicate provision. The section shows an inline alert instead.
 const provisioningBroken =
 provRunsState.status === "error" ||
 provRunState.status === "error" ||
 (!!provRun?.appId && appDetailState.status === "error");
 const provisioningFetching =
 provRunsQuery.isFetching || provRunQuery.isFetching || appDetailQuery.isFetching;
 const retryProvisioning = () => {
 void provRunsQuery.refetch();
 if (latestProvRunId) {
 void provRunQuery.refetch();
 }
 if (provRun?.appId) {
 void appDetailQuery.refetch();
 }
 };

 const provisionRun = useProvisionBuildRun();
 const cancelProvRun = useCancelProvisioningRun();
 const retryProvRun = useRetryProvisioningRun();
 const publishProvRelease = usePublishProvisioningCandidate();
 const rollbackProvRelease = useRollbackProvisioningRelease();

 const refreshProvData = () => {
 queryClient.invalidateQueries({ queryKey: getListProvisioningRunsQueryKey({ buildRunId: buildId! }) });
 if (latestProvRunId) {
 queryClient.invalidateQueries({ queryKey: getGetProvisioningRunQueryKey(latestProvRunId) });
 }
 // Also invalidate app queries since a successful provision creates/links an app
 queryClient.invalidateQueries({ queryKey: getListVenomAppsQueryKey() });
 if (provRun?.appId) {
 queryClient.invalidateQueries({ queryKey: getGetVenomAppQueryKey(provRun.appId) });
 }
 };

 const handleCancel = async () => {
 if (!cancelReason.trim()) return;
 try {
 await cancelRun.mutateAsync({ buildRunId: buildId!, data: { reason: cancelReason } });
 setIsCancelOpen(false);
 refreshData();
 toast({ title: "Build cancelled" });
 } catch (err: any) {
 toast({ title: "Error", description: err.message, variant: "destructive" });
 }
 };

 const handleReject = async () => {
 if (!rejectReason.trim()) return;
 try {
 await rejectRun.mutateAsync({ buildRunId: buildId!, data: { reason: rejectReason } });
 setIsRejectOpen(false);
 refreshData();
 toast({ title: "Build rejected" });
 } catch (err: any) {
 toast({ title: "Error", description: err.message, variant: "destructive" });
 }
 };

 const handleRevise = async () => {
 if (!reviseInstruction.trim()) return;
 try {
 await reviseRun.mutateAsync({ buildRunId: buildId!, data: { instruction: reviseInstruction } });
 setReviseInstruction("");
 setIsReviseOpen(false);
 refreshData();
 toast({ title: "Revision requested", description: "The build package is being updated." });
 } catch (err: any) {
 toast({ title: "Error", description: err.message, variant: "destructive" });
 }
 };

 const handleApprove = async () => {
 if (!run?.revisions || run.revisions.length === 0) return;
 const latestRev = run.revisions[0];

 try {
 await approveRun.mutateAsync({ buildRunId: buildId!, data: { revisionId: latestRev.id } });
 refreshData();
 toast({ title: "Build approved", description: "Ready for provisioning." });
 } catch (err: any) {
 toast({ title: "Error", description: err.message, variant: "destructive" });
 }
 };

 const handleRetry = async () => {
 try {
 await retryRun.mutateAsync({ buildRunId: buildId! });
 refreshData();
 toast({ title: "Retry started" });
 } catch (err: any) {
 toast({ title: "Error", description: err.message, variant: "destructive" });
 }
 };

 const handleExport = async (format: "json" | "markdown") => {
 try {
 const data = await exportVenomBuildRun(buildId!, format);
 const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
 const mimeType = format === 'json' ? 'application/json' : 'text/markdown';
 const blob = new Blob([content], { type: mimeType });
 const url = window.URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `build-${buildId}.${format}`;
 document.body.appendChild(a);
 a.click();
 window.URL.revokeObjectURL(url);
 document.body.removeChild(a);
 } catch (err: any) {
 toast({ title: "Export failed", description: err.message, variant: "destructive" });
 }
 };

 const activeRevision = run?.revisions && run.revisions.length > 0
 ? (selectedRevisionId ? run.revisions.find(r => r.id === selectedRevisionId) : run.revisions[0]) || run.revisions[0]
 : null;

 const approvedRevision = run?.approvedRevisionId && run.revisions
 ? run.revisions.find(r => r.id === run.approvedRevisionId) || null
 : null;

 const handleProvision = async () => {
 if (provisionConfirmName !== run?.targetName || !run?.approvedRevisionId || run.status !== "ready_for_provisioning") return;
 try {
 await provisionRun.mutateAsync({
 buildRunId: buildId!,
 data: {
 approvedRevisionId: run.approvedRevisionId,
 idempotencyKey: provisionIdempotencyRef.current,
 targetName: provisionConfirmName,
 requestedIntegrations: approvedRevision?.package.integrationNeeds || [],
 deploymentIntent: "create_candidate"
 }
 });
 setIsProvisionOpen(false);
 setProvisionConfirmName("");
 provisionIdempotencyRef.current = "";
 refreshProvData();
 toast({ title: "Provisioning initiated" });
 } catch (err: any) {
 toast({ title: "Provisioning failed", description: err.message, variant: "destructive" });
 }
 };

 const handlePublish = async () => {
 const releaseToPublish = appDetail?.provisioningReleases?.find(r => r.id === selectedReleaseId) || provRun?.releases?.find(r => r.id === selectedReleaseId);
 if (!releaseToPublish) return;

 const releaseTargetName = releaseToPublish.targetName;
 if (!releaseTargetName || publishConfirmName !== releaseTargetName) return;

 const idempotencyKey = releaseToPublish.publishIdempotencyKey || publishIdempotencyRef.current;

 try {
 const response = await publishProvRelease.mutateAsync({
 provisioningRunId: releaseToPublish.provisioningRunId,
 data: {
 candidateReleaseId: selectedReleaseId!,
 idempotencyKey,
 confirmTargetName: publishConfirmName
 }
 });

 refreshProvData();
 if (response.status === "published") {
 setIsPublishOpen(false);
 setPublishConfirmName("");
 publishIdempotencyRef.current = "";
 toast({ title: "Publishing successful" });
 } else {
 toast({ title: "Publishing incomplete", description: response.failureMessage || "Failed to publish", variant: "destructive" });
 }
 } catch (err: any) {
 toast({ title: "Publishing failed", description: err.message, variant: "destructive" });
 }
 };

 const handleRollback = async () => {
 const releaseToRollback = appDetail?.provisioningReleases?.find(r => r.id === selectedReleaseId) || provRun?.releases?.find(r => r.id === selectedReleaseId);
 if (!releaseToRollback) return;
 const releaseTargetName = releaseToRollback.targetName;
 if (!releaseTargetName || rollbackConfirmName !== releaseTargetName) return;

 const idempotencyKey = releaseToRollback.rollbackIdempotencyKey || rollbackIdempotencyRef.current;

 try {
 const response = await rollbackProvRelease.mutateAsync({
 releaseId: selectedReleaseId!,
 data: {
 idempotencyKey,
 confirmTargetName: rollbackConfirmName
 }
 });

 refreshProvData();
 if (response.id === selectedReleaseId && response.status === "published") {
 setIsRollbackOpen(false);
 setRollbackConfirmName("");
 rollbackIdempotencyRef.current = "";
 toast({ title: "Rollback successful" });
 } else {
 toast({ title: "Rollback incomplete", description: "Failed to rollback to selected release", variant: "destructive" });
 }
 } catch (err: any) {
 toast({ title: "Rollback failed", description: err.message, variant: "destructive" });
 }
 };

 const handleCancelProv = async () => {
 if (!cancelProvReason.trim() || !latestProvRunId) return;
 try {
 const response = await cancelProvRun.mutateAsync({
 provisioningRunId: latestProvRunId,
 data: { reason: cancelProvReason }
 });
 setIsCancelProvOpen(false);
 setCancelProvReason("");
 refreshProvData();
 toast({
 title:
 response.status === "cancelled"
 ? "Provisioning cancelled"
 : "Cancellation requested",
 description:
 response.status === "cancelled"
 ? undefined
 : "Venom will keep checking until the active provider step stops.",
 });
 } catch (err: any) {
 toast({ title: "Cancellation failed", description: err.message, variant: "destructive" });
 }
 };

 const handleRetryProv = async () => {
 if (!latestProvRunId) return;
 try {
 await retryProvRun.mutateAsync({ provisioningRunId: latestProvRunId });
 refreshProvData();
 toast({ title: "Retrying provisioning" });
 } catch (err: any) {
 toast({ title: "Retry failed", description: err.message, variant: "destructive" });
 }
 };

 if (runState.status === "loading") {
 return (
 <div className="p-8 max-w-5xl mx-auto w-full space-y-8">
 <Skeleton className="h-12 w-64 rounded-xl bg-muted/20 surface" />
 <Skeleton className="h-64 rounded-xl bg-muted/20 surface" />
 </div>
 );
 }

 if (runState.status === "error" || !run) {
 return (
 <div
 className="flex flex-col items-center justify-center h-full p-8 text-center"
 role="alert"
 data-testid="status-build-run-error"
 >
 <AlertTriangle className="h-12 w-12 text-destructive mb-4" />
 <h2 className="text-xl font-semibold tracking-tight">Build run unavailable</h2>
 <p className="text-muted-foreground text-sm mt-2 mb-6 max-w-md">
 {runState.status === "error" && runState.reason === "malformed-response"
 ? "This run came back in an unexpected shape. It may have been removed, it may belong to another account, or the build service may be answering incorrectly."
 : "We could not load this build run. Try again in a moment."}
 </p>
 <div className="flex items-center gap-3">
 <Button
 variant="outline"
 onClick={() => {
 void runQuery.refetch();
 }}
 disabled={runQuery.isFetching}
 className="rounded-md font-medium border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors"
 data-testid="button-retry-build-run"
 >
 {runQuery.isFetching ? "Retrying" : "Try again"}
 </Button>
 <Link
 href="/workspace/apps"
 className="inline-flex items-center justify-center whitespace-nowrap text-sm h-10 px-4 py-2 border border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md font-medium"
 >
 Back to workspace
 </Link>
 </div>
 </div>
 );
 }

 const isPreparing = run.status === "queued" || run.status === "preparing";
 const needsReview = run.status === "review_required";
 // Present when this run's generation included above-threshold lessons from
 // the template's anonymous builder network (event recorded server-side).
 const networkGuidanceApplied = run.events.some(
  (event) => event.eventType === "network_guidance",
 );
 const isTerminal = ["approved", "cancelled", "failed", "ready_for_provisioning"].includes(run.status);

 const comparisonRevision = comparisonRevisionId
 ? run.revisions.find((revision) => revision.id === comparisonRevisionId) ?? null
 : null;
 const comparisonSections = activeRevision && comparisonRevision
 ? [
 ["Functional scope", activeRevision.package.functionalScope, comparisonRevision.package.functionalScope],
 ["Brand direction", activeRevision.package.brandDirection, comparisonRevision.package.brandDirection],
 ["Content requirements", activeRevision.package.contentRequirements, comparisonRevision.package.contentRequirements],
 ["Service flow", activeRevision.package.serviceFlowRequirements, comparisonRevision.package.serviceFlowRequirements],
 ["Data needs", activeRevision.package.dataNeeds, comparisonRevision.package.dataNeeds],
 ["Integration needs", activeRevision.package.integrationNeeds, comparisonRevision.package.integrationNeeds],
 ["Acceptance checks", activeRevision.package.acceptanceChecks, comparisonRevision.package.acceptanceChecks],
 ["Launch constraints", activeRevision.package.launchConstraints, comparisonRevision.package.launchConstraints],
 ].map(([title, currentItems, comparedItems]) => {
 const current = currentItems as string[];
 const compared = comparedItems as string[];
 return {
 title: title as string,
 added: current.filter((item) => !compared.includes(item)),
 removed: compared.filter((item) => !current.includes(item)),
 };
 }).filter((section) => section.added.length > 0 || section.removed.length > 0)
 : [];

 return (
 <div className="flex h-full flex-col bg-background relative overflow-hidden">
 <div className="absolute top-0 left-0 -ml-32 -mt-32 w-[500px] h-[500px] bg-foreground/[0.02] rounded-full blur-3xl pointer-events-none animate-breathe" />

 <header className="shrink-0 border-b border-border/60 px-6 py-6 relative z-10 bg-background/80 backdrop-blur-xl">
 <div className="max-w-6xl mx-auto">
 <Link href="/workspace/apps" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground mb-4 group transition-colors">
 <ArrowLeft className="mr-2 h-3 w-3 group-hover:-translate-x-1 transition-transform" /> Back
 </Link>

 <div className="flex flex-col md:flex-row gap-4 md:items-end md:justify-between">
 <div>
 <div className="flex items-center gap-3">
 <h1 className="text-3xl font-semibold tracking-tight text-foreground truncate max-w-[500px]" title={run.targetName}>
 {run.targetName}
 </h1>
 <StatusBadge status={run.status} progress={run.progress} />
 </div>
 <p className="text-xs text-muted-foreground mt-2">
 Target: {run.targetType.replace(/_/g, ' ')}{run.appId ? <> • App: <span className="font-mono">{run.appId.substring(0,8)}</span></> : null}
 </p>
 </div>

 <div className="flex flex-wrap items-center gap-2">
 {isPreparing && (
 <Dialog open={isCancelOpen} onOpenChange={setIsCancelOpen}>
 <DialogTrigger asChild>
 <Button variant="outline" className="rounded-md border-border/60 font-medium text-xs h-9 shadow-soft hover:bg-accent hover:text-accent-foreground transition-colors">
 <Ban className="h-3 w-3 mr-2" /> Cancel
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Cancel build run</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 Why are you cancelling this request?
 </DialogDescription>
 </DialogHeader>
 <Textarea
 value={cancelReason}
 onChange={e => setCancelReason(e.target.value)}
 placeholder="Reason for cancellation..."
 className="rounded-md text-sm border-border/60 mt-4 focus-visible:ring-ring"
 />
 <DialogFooter className="mt-8">
 <Button onClick={handleCancel} disabled={!cancelReason.trim() || cancelRun.isPending} className="rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 font-medium shadow-soft">
 Confirm cancellation
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 )}

 {(run.status === "failed" || run.status === "cancelled") && (
 <Button onClick={handleRetry} disabled={retryRun.isPending} variant="outline" className="rounded-md border-border/60 font-medium text-xs h-9 shadow-soft hover:bg-accent hover:text-accent-foreground transition-colors">
 <RefreshCw className={cn("h-3 w-3 mr-2", retryRun.isPending && "animate-spin")} /> Retry
 </Button>
 )}

 {(activeRevision || isTerminal) && (
 <>
 <Button onClick={() => handleExport("json")} variant="outline" className="rounded-md border-border/60 font-medium text-xs h-9 shadow-soft hover:bg-accent hover:text-accent-foreground transition-colors">
 <FileCode2 className="h-3 w-3 mr-2" /> JSON
 </Button>
 <Button onClick={() => handleExport("markdown")} variant="outline" className="rounded-md border-border/60 font-medium text-xs h-9 shadow-soft hover:bg-accent hover:text-accent-foreground transition-colors">
 <Download className="h-3 w-3 mr-2" /> Markdown
 </Button>
 </>
 )}
 </div>
 </div>
 </div>
 </header>

 <div className="flex-1 overflow-y-auto p-6 relative z-10">
 <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8 pb-24">

 <div className="lg:col-span-2 space-y-8">
 {/* Action Required Banner */}
 {needsReview && activeRevision && activeRevision.id === run.revisions[0].id && (
 <div className="border border-foreground/30 bg-foreground/[0.02] p-6 rounded-xl shadow-soft animate-in fade-in slide-in-from-bottom-4">
 <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2 mb-2">
 <AlertTriangle className="h-5 w-5 text-foreground animate-pulse" />
 Review required
 </h2>
 <p className="text-sm mb-6 max-w-lg leading-relaxed text-muted-foreground">
 Review the compiled build package below. You must approve it before it can be provisioned, request revisions, or reject it entirely.
 </p>
 {networkGuidanceApplied && (
 <p className="text-xs mb-6 -mt-4 max-w-lg leading-relaxed text-muted-foreground flex items-center gap-1.5" data-testid="text-network-guidance-note">
 <Sparkles className="h-3.5 w-3.5 shrink-0" />
 Network guidance applied: this draft used anonymous lessons from other builders of this template. Details are in the activity log.
 </p>
 )}
 <div className="flex flex-wrap gap-3">
 <Dialog>
 <DialogTrigger asChild>
 <Button
 disabled={approveRun.isPending}
 className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium shadow-soft transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
 >
 <ThumbsUp className="h-4 w-4 mr-2" /> Approve package
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Final approval</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 You are approving Revision {activeRevision.revisionNumber}.
 This action is final and will mark the build package as ready for provisioning.
 </DialogDescription>
 </DialogHeader>
 <DialogFooter className="mt-8">
 <Button onClick={handleApprove} disabled={approveRun.isPending} className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium shadow-soft">
 Confirm approval
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 <Dialog open={isReviseOpen} onOpenChange={setIsReviseOpen}>
 <DialogTrigger asChild>
 <Button variant="outline" className="rounded-md border-border/60 font-medium shadow-soft hover:bg-accent hover:text-accent-foreground">
 <MessageSquareText className="h-4 w-4 mr-2" /> Request revision
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[500px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Request package revision</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 What should be changed in the build package before approval?
 </DialogDescription>
 </DialogHeader>
 <Textarea
 value={reviseInstruction}
 onChange={e => setReviseInstruction(e.target.value)}
 placeholder="e.g. Add stripe integration to the functional scope, ensure brand colors are used..."
 className="rounded-md text-sm border-border/60 min-h-[150px] mt-4 focus-visible:ring-ring"
 />
 <DialogFooter className="mt-8">
 <Button onClick={handleRevise} disabled={!reviseInstruction.trim() || reviseRun.isPending} className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium shadow-soft">
 Submit revision
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>

 <Dialog open={isRejectOpen} onOpenChange={setIsRejectOpen}>
 <DialogTrigger asChild>
 <Button variant="outline" className="rounded-md border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground font-medium shadow-soft">
 <ThumbsDown className="h-4 w-4 mr-2" /> Reject
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight text-destructive">Reject build run</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 Why is this package being rejected?
 </DialogDescription>
 </DialogHeader>
 <Textarea
 value={rejectReason}
 onChange={e => setRejectReason(e.target.value)}
 className="rounded-md text-sm border-border/60 mt-4 focus-visible:ring-ring"
 />
 <DialogFooter className="mt-8">
 <Button onClick={handleReject} disabled={!rejectReason.trim() || rejectRun.isPending} className="rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 font-medium shadow-soft">
 Confirm rejection
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 </div>
 </div>
 )}

 {/* Error Banner */}
 {run.status === "failed" && (
 <div className="border border-destructive/30 bg-destructive/5 p-6 rounded-xl text-destructive shadow-soft">
 <h2 className="font-semibold tracking-tight flex items-center gap-2 mb-2">
 <XCircle className="h-5 w-5" /> Build failed
 </h2>
 <div className="text-sm">
 <div className="font-medium mb-1">Code: <span className="font-mono">{run.failureCode || "UNKNOWN"}</span></div>
 {run.failureMessage}
 </div>
 </div>
 )}

 {/* Cancelled Banner */}
 {(run.status === "cancelled") && (
 <div className="border border-border/60 bg-muted/20 p-6 rounded-xl shadow-soft">
 <h2 className="font-semibold tracking-tight flex items-center gap-2 mb-2">
 <Ban className="h-5 w-5" /> Run cancelled
 </h2>
 <div className="text-sm text-muted-foreground">
 {run.cancelledReason || "No reason provided."}
 </div>
 </div>
 )}

 {/* Provisioning Section */}
 {(run.status === "ready_for_provisioning" || provRun || provisioningBroken) && (
 <div className="border border-foreground/30 surface rounded-xl shadow-soft p-6 animate-in fade-in slide-in-from-bottom-4">
 <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2 mb-6">
 <Server className="h-5 w-5 text-foreground" />
 Provisioning
 </h2>

 {/* Broken provisioning reads must say so, not pose as pristine state */}
 {provisioningBroken && (
 <div
 role="alert"
 data-testid="status-provisioning-error"
 className="border border-destructive/30 bg-destructive/5 text-destructive rounded-lg p-4 mb-6 text-sm"
 >
 <div className="font-semibold mb-1 flex items-center gap-2">
 <AlertTriangle className="h-4 w-4" />
 Provisioning status unavailable
 </div>
 <p className="mb-3 leading-relaxed">
 The provisioning records for this run could not be read, so this
 section may be incomplete. This is not evidence that provisioning
 never started.
 </p>
 <Button
 variant="outline"
 size="sm"
 onClick={retryProvisioning}
 disabled={provisioningFetching}
 className="rounded-md border-destructive/30 text-destructive hover:bg-destructive hover:text-destructive-foreground font-medium text-xs h-8"
 data-testid="button-retry-provisioning"
 >
 {provisioningFetching ? "Retrying" : "Try again"}
 </Button>
 </div>
 )}

 {/* Capability Status */}
 {(!provRun || provRun.status === 'blocked' || provRun.status === 'failed') && capability && (
 <div className={cn("p-4 mb-6 border rounded-lg text-sm flex gap-3",
 capability.health === 'healthy' ? "bg-foreground/5 border-foreground/20 text-foreground" :
 capability.health === 'degraded' ? "bg-accent border-accent-foreground/20 text-accent-foreground" :
 "bg-destructive/10 border-destructive/30 text-destructive"
 )}>
 <Activity className="h-4 w-4 shrink-0 mt-0.5" />
 <div>
 <div className="font-semibold mb-1 text-xs">
 Capability status: {capability.health}
 </div>
 <div className="mb-2 leading-relaxed">{capability.summary}</div>
 {capability.recoveryGuidance && capability.health !== 'healthy' && (
 <div className="opacity-80">Action required: {capability.recoveryGuidance}</div>
 )}
 </div>
 </div>
 )}

 {provisioningBroken && !provRun ? null : !provRun ? (
 // Initial Provisioning State
 <div>
 <p className="text-sm text-muted-foreground mb-6 leading-relaxed max-w-lg">
 The approved package is ready to be provisioned. This will transfer the package and source to a secure Replit environment and prepare a candidate release.
 </p>
 <Dialog open={isProvisionOpen} onOpenChange={(open) => {
 setIsProvisionOpen(open);
 if (open && !provisionIdempotencyRef.current) {
 provisionIdempotencyRef.current = crypto.randomUUID();
 }
 }}>
 <DialogTrigger asChild>
 <Button
 disabled={!capability || (capability.health !== 'healthy' && capability.health !== 'degraded') || !capability.supportedTargetTypes.includes(run.targetType as any) || !approvedRevision || run.status !== "ready_for_provisioning"}
 className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium shadow-soft transition-transform hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
 >
 <Rocket className="h-4 w-4 mr-2" /> Provision target
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[500px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Provision candidate</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 Creates or links an isolated Replit project and builds a candidate. Nothing is published yet.
 </DialogDescription>
 </DialogHeader>

 <div className="space-y-4 my-4 text-sm">
 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Target name</div>
 <div className="col-span-2 font-semibold">{run.targetName}</div>
 </div>
 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Approved revision</div>
 <div className="col-span-2">{approvedRevision?.revisionNumber} <span className="font-mono text-muted-foreground text-[10px]">({approvedRevision?.id.substring(0,8)})</span></div>
 </div>

 {approvedRevision?.package.sourceReferences?.[0] && (
 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Source context</div>
 <div className="col-span-2">
 <div className="font-semibold">{approvedRevision.package.sourceReferences[0].appName} <span className="text-muted-foreground text-xs font-normal">v{approvedRevision.package.sourceReferences[0].versionNumber}</span></div>
 <div className="font-mono text-[10px] text-muted-foreground truncate mt-1" title={approvedRevision.package.sourceReferences[0].checksumSha256}>
 {approvedRevision.package.sourceReferences[0].checksumSha256}
 </div>
 </div>
 </div>
 )}

 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Expected external changes</div>
 <div className="col-span-2 text-xs">
 <ul className="list-disc pl-4 space-y-1 text-muted-foreground">
 <li>Create new project on target capability</li>
 <li>Sync source repository files to target</li>
 <li>Run package build process</li>
 <li>Launch private preview URL</li>
 <li className="text-foreground">Will not alter live production traffic</li>
 </ul>
 </div>
 </div>

 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Integrations</div>
 <div className="col-span-2">
 {approvedRevision?.package.integrationNeeds.length ? (
 <ul className="list-disc pl-4 space-y-1">
 {approvedRevision.package.integrationNeeds.map((i, idx) => <li key={idx}>{i}</li>)}
 </ul>
 ) : "None"}
 </div>
 </div>

 <div className="grid grid-cols-3 gap-2 py-2 border-b border-border/60">
 <div className="text-xs text-muted-foreground mb-2">Permissions</div>
 <div className="col-span-2 space-y-3">
 {approvedRevision?.package.permissionRequests.length ? (
 approvedRevision.package.permissionRequests.map((p, idx) => (
 <div key={idx}>
 <div className="font-semibold text-sm flex items-center gap-2">
 {p.capability}
 {p.required ? (
 <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-foreground text-background">Required</span>
 ) : (
 <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">Optional</span>
 )}
 </div>
 <div className="text-[10px] text-muted-foreground mt-0.5">{p.reason}</div>
 </div>
 ))
 ) : "None"}
 </div>
 </div>

 <div className="pt-2">
 <label htmlFor="confirm-provision-target" className="block text-xs font-medium mb-2">
 Type <span className="select-all rounded-xs bg-foreground/10 px-1 py-0.5">{run.targetName}</span> to confirm
 </label>
 <Input
 id="confirm-provision-target"
 value={provisionConfirmName}
 onChange={(e) => setProvisionConfirmName(e.target.value)}
 className="rounded-md border-border/60 text-sm mt-4 focus-visible:ring-ring"
 placeholder="Exact target name..."
 autoComplete="off"
 />
 </div>
 </div>

 <DialogFooter className="mt-8">
 <Button
 onClick={handleProvision}
 disabled={provisionConfirmName !== run.targetName || provisionRun.isPending}
 className="rounded-md bg-foreground text-background hover:bg-foreground/90 font-medium w-full"
 >
 Confirm provisioning
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 </div>
 ) : (
 // Active / Historic Provisioning Run State
 <div className="space-y-6">
 <div className="flex flex-wrap items-center justify-between gap-4">
 <div>
 <div className="text-xs text-muted-foreground mb-1">
 Current stage
 </div>
 <div className="text-lg font-semibold tracking-tight" aria-live="polite">
 {sentenceCase(provRun.stage || provRun.status)}
 </div>
 </div>

 <div className="flex gap-2">
 {["queued", "creating_project", "handing_off", "building", "testing"].includes(provRun.status) && (
 <Dialog open={isCancelProvOpen} onOpenChange={setIsCancelProvOpen}>
 <DialogTrigger asChild>
 <Button variant="outline" className="rounded-md border-border/60 font-medium text-xs h-8 shadow-soft">
 <Ban className="h-3 w-3 mr-2" /> Cancel
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-[420px] shadow-lift">
 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Cancel provisioning</DialogTitle>
 </DialogHeader>
 <Textarea
 value={cancelProvReason}
 onChange={e => setCancelProvReason(e.target.value)}
 placeholder="Reason for cancellation..."
 className="rounded-md text-sm border-border/60 mt-4 focus-visible:ring-ring"
 />
 <DialogFooter className="mt-8">
 <Button onClick={handleCancelProv} disabled={!cancelProvReason.trim() || cancelProvRun.isPending} className="rounded-md bg-destructive text-destructive-foreground font-medium">
 Confirm cancellation
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 )}

 {(provRun.status === 'failed' || provRun.status === 'blocked' || provRun.status === 'cancelled') && (
 <Button onClick={handleRetryProv} disabled={retryProvRun.isPending} variant="outline" className="rounded-md border-border/60 font-medium text-xs h-8 shadow-soft">
 <RefreshCw className={cn("h-3 w-3 mr-2", retryProvRun.isPending && "animate-spin")} /> Retry
 </Button>
 )}
 </div>
 </div>

 <div className="space-y-2">
 <div className="flex justify-between text-xs text-muted-foreground" aria-hidden="true">
 <span>Progress</span>
 <span>{provRun.progress}%</span>
 </div>
 <Progress value={provRun.progress} className="h-1 rounded-full bg-foreground/10" aria-label="Provisioning progress" />
 </div>

 {/* Run Error/Blocked Reason */}
 {provRun.failureMessage && (
 <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive">
 <strong>Error:</strong> {provRun.failureMessage}
 </div>
 )}
 {provRun.blockedReason && (
 <div className="bg-accent border border-accent-foreground/20 rounded-lg p-4 text-sm text-accent-foreground">
 <strong>Blocked:</strong> {provRun.blockedReason}
 </div>
 )}

 {/* Releases Section */}
 {appDetail?.provisioningReleases && appDetail.provisioningReleases.length > 0 && (
 <div className="pt-4 border-t border-border/60">
 <h3 className="text-xs font-semibold text-muted-foreground mb-4">Releases</h3>
 <div className="space-y-3">
 {appDetail.provisioningReleases.map((release) => (
 <div key={release.id} className="border border-border/60 bg-muted/10 rounded-lg shadow-soft p-4 flex flex-col md:flex-row gap-4 justify-between md:items-center">
 <div>
 <div className="flex items-center gap-2 mb-1">
 <span className="font-mono text-sm font-medium">{release.providerCandidateId || release.id.substring(0,8)}</span>
 <span className={cn("text-[10px] px-2 py-0.5 border rounded-full font-medium",
 release.status === 'published' ? "border-foreground bg-foreground text-background" :
 release.status === 'candidate' ? "border-foreground/30 text-foreground" :
 "border-muted-foreground/30 text-muted-foreground"
 )}>
 {sentenceCase(release.status)}
 </span>
 </div>
 {release.launchUrl && (
 <a href={release.launchUrl} target="_blank" rel="noreferrer" className="text-xs font-medium underline underline-offset-4 opacity-80 hover:opacity-100 flex items-center gap-1 mt-2">
 <Globe className="h-3 w-3" /> Visit {release.status === 'candidate' ? 'candidate preview' : 'live app'}
 </a>
 )}
 </div>

 <div className="flex items-center gap-2">
 {release.status === 'candidate' && capability?.publishSupported && (
 <Dialog open={isPublishOpen && selectedReleaseId === release.id} onOpenChange={(open) => {
 setIsPublishOpen(open);
 if(open) {
 setSelectedReleaseId(release.id);
 if (!publishIdempotencyRef.current) publishIdempotencyRef.current = crypto.randomUUID();
 } else {
 setSelectedReleaseId(null);
 }
 }}>
 <DialogTrigger asChild>
 <Button className="rounded-md font-medium text-xs h-8 shadow-soft">
 <Rocket className="h-3 w-3 mr-2" /> Publish
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-lg shadow-lift">
 <div className="p-6">

 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Publish release</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 This will change the live launch to candidate {release.providerCandidateId || release.id.substring(0,8)}. Existing healthy deployment is preserved on failure.
 </DialogDescription>
 </DialogHeader>
 <div className="pt-2">
 <label htmlFor={`publish-confirm-${release.id}`} className="block text-xs font-medium mb-2">
 Type <span className="select-all rounded-xs bg-foreground/10 px-1 py-0.5">{release.targetName}</span> to confirm
 </label>
 <Input
 id={`publish-confirm-${release.id}`}
 value={publishConfirmName}
 onChange={(e) => setPublishConfirmName(e.target.value)}
 className="rounded-md border-border/60 text-sm mt-4 focus-visible:ring-ring"
 placeholder="Exact target name..."
 autoComplete="off"
 />
 </div>
 <DialogFooter className="mt-8">
 <Button
 onClick={handlePublish}
 disabled={!release.targetName || publishConfirmName !== release.targetName || publishProvRelease.isPending}
 className="rounded-md bg-foreground text-background font-medium w-full mt-4"
 >
 Confirm publish
 </Button>
 </DialogFooter>

 </div>
 </DialogContent>
 </Dialog>
 )}

 {release.status === 'superseded' && release.rollbackSupported && capability?.rollbackSupported && (
 <Dialog open={isRollbackOpen && selectedReleaseId === release.id} onOpenChange={(open) => {
 setIsRollbackOpen(open);
 if(open) {
 setSelectedReleaseId(release.id);
 if (!rollbackIdempotencyRef.current) rollbackIdempotencyRef.current = crypto.randomUUID();
 } else {
 setSelectedReleaseId(null);
 }
 }}>
 <DialogTrigger asChild>
 <Button variant="outline" className="rounded-md border-border/60 font-medium text-xs h-8 shadow-soft">
 <History className="h-3 w-3 mr-2" /> Rollback
 </Button>
 </DialogTrigger>
 <DialogContent className="rounded-2xl border-border/60 surface p-0 sm:max-w-lg shadow-lift">
 <div className="p-6">

 <DialogHeader>
 <DialogTitle className="text-xl font-semibold tracking-tight">Rollback release</DialogTitle>
 <DialogDescription className="text-sm mt-2">
 This will change the live deployment to restore superseded release {release.providerCandidateId || release.id.substring(0,8)}.
 </DialogDescription>
 </DialogHeader>
 <div className="pt-2">
 <label htmlFor={`rollback-confirm-${release.id}`} className="block text-xs font-medium mb-2">
 Type <span className="select-all rounded-xs bg-foreground/10 px-1 py-0.5">{release.targetName}</span> to confirm
 </label>
 <Input
 id={`rollback-confirm-${release.id}`}
 value={rollbackConfirmName}
 onChange={(e) => setRollbackConfirmName(e.target.value)}
 className="rounded-md border-border/60 text-sm mt-4 focus-visible:ring-ring"
 placeholder="Exact target name..."
 autoComplete="off"
 />
 </div>
 <DialogFooter className="mt-8">
 <Button
 onClick={handleRollback}
 disabled={!release.targetName || rollbackConfirmName !== release.targetName || rollbackProvRelease.isPending}
 className="rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 font-medium w-full mt-4"
 >
 Confirm rollback
 </Button>
 </DialogFooter>

 </div>
 </DialogContent>
 </Dialog>
 )}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Live Event Stream */}
 {provRun.events && provRun.events.length > 0 && (
 <div className="pt-4 border-t border-border/60">
 <h3 className="text-xs font-semibold text-muted-foreground mb-4">Provisioning log</h3>
 <div className="max-h-[200px] overflow-y-auto space-y-3 font-mono text-xs p-4 bg-foreground/[0.02] border border-border/60 rounded-lg">
 {provRun.events.map(ev => (
 <div key={ev.id} className="flex gap-3">
 <span className="text-muted-foreground shrink-0">{new Date(ev.createdAt).toLocaleTimeString()}</span>
 <span className={cn(
 "font-semibold shrink-0 text-[9px] mt-0.5 w-[100px]",
 ev.eventType === 'failed' || ev.eventType === 'blocked' ? "text-destructive" :
 ev.eventType === 'published' || ev.eventType === 'candidate_ready' ? "text-foreground" :
 "text-muted-foreground"
 )}>{ev.eventType}</span>
 <span className="opacity-80">{ev.message}</span>
 </div>
 ))}
 </div>
 </div>
 )}
 </div>
 )}
 </div>
 )}

 {/* Current Revision Inspection */}
 <section className="space-y-4">
 <h2 className="text-base font-semibold tracking-tight border-b border-border/60 pb-2 flex items-center justify-between">
 <div className="flex items-center gap-2">
 <PackageSearch className="h-5 w-5" /> Package inspection
 </div>
 <div className="flex items-center gap-2">
 {run.revisions && run.revisions.length > 1 && (
 <select
 value={activeRevision?.id || ""}
 onChange={(event) => {
 const nextRevisionId = event.target.value;
 setSelectedRevisionId(nextRevisionId);
 if (comparisonRevisionId === nextRevisionId) {
 setComparisonRevisionId(null);
 }
 }}
 className="bg-transparent border border-border/60 text-xs p-1 rounded-md focus-visible:ring-ring"
 aria-label="Select revision to inspect"
 >
 {run.revisions.map(rev => (
 <option key={rev.id} value={rev.id}>
 Rev {rev.revisionNumber}
 </option>
 ))}
 </select>
 )}
 {run.revisions && run.revisions.length > 1 && activeRevision && (
 <select
 value={comparisonRevisionId || ""}
 onChange={(event) => setComparisonRevisionId(event.target.value || null)}
 className="bg-transparent border border-border/60 text-xs p-1 rounded-md focus-visible:ring-ring"
 aria-label={`Compare revision ${activeRevision.revisionNumber} with another revision`}
 >
 <option value="">Compare with…</option>
 {run.revisions
 .filter((revision) => revision.id !== activeRevision.id)
 .map((revision) => (
 <option key={revision.id} value={revision.id}>
 Rev {revision.revisionNumber}
 </option>
 ))}
 </select>
 )}
 {activeRevision && (
 <span className="text-[10px] bg-foreground text-background px-2 py-1 rounded-full font-medium" aria-live="polite">
 Rev {activeRevision.revisionNumber}
 </span>
 )}
 </div>
 </h2>
 {activeRevision && comparisonRevision && (
 <div className="border border-foreground/20 surface rounded-xl shadow-soft p-5" aria-live="polite">
 <h3 className="text-xs font-semibold mb-4">
 Revision {activeRevision.revisionNumber} compared with revision {comparisonRevision.revisionNumber}
 </h3>
 <div className="grid gap-4 md:grid-cols-2 mb-5">
 <div>
 <div className="text-xs text-muted-foreground mb-2">
 Revision {activeRevision.revisionNumber} summary
 </div>
 <p className="text-sm">{activeRevision.package.productBrief.summary}</p>
 </div>
 <div>
 <div className="text-xs text-muted-foreground mb-2">
 Revision {comparisonRevision.revisionNumber} summary
 </div>
 <p className="text-sm">{comparisonRevision.package.productBrief.summary}</p>
 </div>
 </div>
 {comparisonSections.length === 0 ? (
 <p className="text-xs text-muted-foreground">
 No list-item changes were detected between these revisions.
 </p>
 ) : (
 <div className="space-y-4">
 {comparisonSections.map((section) => (
 <div key={section.title}>
 <h4 className="text-xs font-semibold mb-2">{section.title}</h4>
 {section.added.map((item) => (
 <div key={`added-${item}`} className="text-xs font-mono py-1">
 <span className="font-semibold" aria-label="Added">+ </span>{item}
 </div>
 ))}
 {section.removed.map((item) => (
 <div key={`removed-${item}`} className="text-xs font-mono py-1 text-muted-foreground line-through">
 <span className="font-semibold" aria-label="Removed">− </span>{item}
 </div>
 ))}
 </div>
 ))}
 </div>
 )}
 </div>
 )}

 {!activeRevision ? (
 <div className="border border-dashed border-border/60 rounded-xl p-12 flex flex-col items-center justify-center text-center bg-foreground/[0.01]">
 <PackageSearch className="h-8 w-8 text-muted-foreground mb-4 opacity-50" />
 <div className="font-medium text-sm mb-1">Compiling package</div>
 <div className="text-xs text-muted-foreground max-w-sm">
 Venom is evaluating constraints and building the review package.
 </div>
 </div>
 ) : (
 <div className="grid gap-6">
 {/* Summary */}
 <div className="border border-border/60 surface rounded-xl shadow-soft p-5">
 <h3 className="text-xs font-medium text-muted-foreground mb-3">Product brief</h3>
 <div className="font-medium text-sm leading-relaxed mb-4">{activeRevision.package.productBrief.summary}</div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 <div>
 <h4 className="text-xs text-muted-foreground mb-2 border-b border-border/60 pb-1">Audience</h4>
 <ul className="space-y-1">
 {activeRevision.package.productBrief.audience.map((a, i) => (
 <li key={i} className="text-xs flex gap-2"><span className="text-muted-foreground shrink-0">•</span><span>{a}</span></li>
 ))}
 </ul>
 </div>
 <div>
 <h4 className="text-xs text-muted-foreground mb-2 border-b border-border/60 pb-1">Outcomes</h4>
 <ul className="space-y-1">
 {activeRevision.package.productBrief.outcomes.map((o, i) => (
 <li key={i} className="text-xs flex gap-2"><span className="text-muted-foreground shrink-0">•</span><span>{o}</span></li>
 ))}
 </ul>
 </div>
 </div>
 </div>

 {/* Arrays */}
 {[
 { title: "Functional scope", items: activeRevision.package.functionalScope },
 { title: "Brand direction", items: activeRevision.package.brandDirection },
 { title: "Content requirements", items: activeRevision.package.contentRequirements },
 { title: "Service flow", items: activeRevision.package.serviceFlowRequirements },
 { title: "Data needs", items: activeRevision.package.dataNeeds },
 { title: "Integration needs", items: activeRevision.package.integrationNeeds },
 { title: "Acceptance checks", items: activeRevision.package.acceptanceChecks },
 { title: "Launch constraints", items: activeRevision.package.launchConstraints },
 ].map(section => (
 section.items && section.items.length > 0 && (
 <div key={section.title} className="border border-border/60 surface rounded-xl shadow-soft p-5">
 <h3 className="text-xs font-medium text-muted-foreground mb-3">{section.title}</h3>
 <ul className="space-y-2">
 {section.items.map((item, i) => (
 <li key={i} className="text-sm flex gap-3">
 <span className="text-muted-foreground shrink-0 mt-0.5">•</span>
 <span className="leading-snug">{item}</span>
 </li>
 ))}
 </ul>
 </div>
 )
 ))}

 {/* Sources */}
 {activeRevision.package.sourceReferences && activeRevision.package.sourceReferences.length > 0 && (
 <div className="border border-border/60 surface rounded-xl shadow-soft p-5">
 <h3 className="text-xs font-medium text-muted-foreground mb-3">Source references</h3>
 <div className="space-y-3">
 {activeRevision.package.sourceReferences.map((ref, i) => (
 <div key={i} className="p-3 bg-foreground/[0.02] border border-border/60 rounded-lg">
 <div className="text-sm font-medium mb-1">{ref.appName}</div>
 <div className="font-mono text-xs text-muted-foreground">
 v{ref.versionNumber} &bull; {ref.checksumSha256.substring(0,8)}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* SOPs */}
 {activeRevision.package.sopReferences && activeRevision.package.sopReferences.length > 0 && (
 <div className="border border-border/60 surface rounded-xl shadow-soft p-5">
 <h3 className="text-xs font-medium text-muted-foreground mb-3">SOP references</h3>
 <div className="space-y-3">
 {activeRevision.package.sopReferences.map((ref, i) => (
 <div key={i} className="p-3 bg-foreground/[0.02] border border-border/60 rounded-lg">
 <div className="text-sm font-medium mb-1">{ref.title}</div>
 <div className="font-mono text-xs text-muted-foreground">
 Rev {ref.revisionNumber} &bull; {ref.checksumSha256.substring(0,8)}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Permissions */}
 {activeRevision.package.permissionRequests && activeRevision.package.permissionRequests.length > 0 && (
 <div className="border border-border/60 surface rounded-xl shadow-soft p-5">
 <h3 className="text-xs font-medium text-muted-foreground mb-3">Permission requests</h3>
 <div className="space-y-3">
 {activeRevision.package.permissionRequests.map((perm, i) => (
 <div key={i} className="p-3 bg-foreground/[0.02] border border-border/60 rounded-lg">
 <div className="flex items-center justify-between mb-1">
 <span className="text-sm font-semibold">{perm.capability}</span>
 <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", perm.required ? "bg-foreground text-background" : "bg-muted text-muted-foreground")}>
 {perm.required ? "Required" : "Optional"}
 </span>
 </div>
 <div className="text-xs text-muted-foreground">{perm.reason}</div>
 </div>
 ))}
 </div>
 </div>
 )}
 </div>
 )}
 </section>
 </div>

 <div className="space-y-6">
 {/* Original Request snapshot */}
 <div className="border border-border/60 surface rounded-xl shadow-soft flex flex-col h-[300px]">
 <div className="p-4 border-b border-border/60 bg-muted/20 shrink-0 flex items-center justify-between gap-2">
 <h3 className="text-xs font-semibold text-muted-foreground">Request snapshot</h3>
 {run.runKind === "app_iteration" && (
 <span
 className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-foreground text-background whitespace-nowrap"
 data-testid="badge-improvement-iteration"
 >
 Improvement iteration
 </span>
 )}
 </div>
 <div className="p-4 overflow-y-auto flex-1 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
 {run.request.requirements}

 {run.request.constraints && (
 <>
 {"\n\n"}
 <span className="font-semibold text-foreground">Constraints:</span>
 {"\n"}{run.request.constraints}
 </>
 )}

 {run.request.changesSummary && (
 <>
 {"\n\n"}
 <span className="font-semibold text-foreground">New since baseline:</span>
 {"\n"}{run.request.changesSummary}
 </>
 )}
 </div>
 </div>

 {/* Activity log */}
 <div className="border border-border/60 surface rounded-xl shadow-soft">
 <div className="p-4 border-b border-border/60 bg-muted/20">
 <h3 className="text-xs font-semibold text-muted-foreground">Activity log</h3>
 </div>
 <div className="max-h-[400px] overflow-y-auto p-4 space-y-4">
 {run.events.map((event) => (
 <div key={event.id} className="flex gap-3">
 <div className="w-1.5 h-1.5 rounded-full bg-foreground shrink-0 mt-1.5 opacity-30" />
 <div>
 <div className="text-xs font-medium leading-tight">{event.message}</div>
 <div className="text-[10px] font-mono text-muted-foreground mt-1 flex gap-2">
 <span>{new Date(event.createdAt).toLocaleTimeString()}</span>
 <span>•</span>
 <span>{event.eventType}</span>
 </div>
 </div>
 </div>
 ))}
 {run.events.length === 0 && (
 <div className="text-xs text-muted-foreground text-center p-4">Waiting for events…</div>
 )}
 </div>
 </div>
 </div>

 </div>
 </div>
 </div>
 );
}

function sentenceCase(value: string) {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function StatusBadge({ status, progress }: { status: string; progress: number }) {
  const isFailed = status === "failed";
  const isCancelled = status === "cancelled";
  const isApproved = status === "approved" || status === "ready_for_provisioning";
  const needsReview = status === "review_required";
  
  return (
    <div role="status" aria-live="polite" className={cn(
      "px-3 py-1 text-xs font-medium rounded-full flex items-center gap-2",
      isFailed ? "bg-destructive text-destructive-foreground" :
      isApproved ? "bg-foreground text-background" :
      needsReview ? "border border-foreground text-foreground animate-pulse" :
      isCancelled ? "bg-muted text-muted-foreground border border-border" :
      "bg-foreground/5 text-foreground border border-foreground/20"
    )}>
      {!isFailed && !isApproved && !needsReview && !isCancelled && (
        <Activity className="h-3 w-3 animate-pulse" />
      )}
      <span>{sentenceCase(status)}</span>
      {!isFailed && !isApproved && !isCancelled && progress > 0 && progress < 100 && (
        <span className="text-[10px]">{progress}%</span>
      )}
    </div>
  );
}
