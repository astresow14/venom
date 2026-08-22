import React, { useEffect, useMemo, useState } from "react";
import { useAuth } from "@clerk/react";
import { IS_UI_TEST } from "@/lib/ui-test";
import { UI_TEST_USER_ID } from "@/context/VenomWorkspaceContext";
import { motion, AnimatePresence } from "framer-motion";
import { formatDistanceToNow } from "date-fns";
import {
  AlertCircle,
  Building2,
  Check,
  FolderKanban,
  Github,
  Globe,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  UserMinus,
  Users,
  Waypoints,
  X,
} from "lucide-react";
import {
  acceptVenomOrgInvite,
  ApiError,
  connectVenomOrgGitHubSource,
  connectVenomOrgWebsiteSource,
  createVenomOrg,
  declineVenomOrgInvite,
  deleteVenomOrg,
  getVenomOrgMasterContribution,
  getVenomOrgMembers,
  getVenomOrgProjects,
  getVenomOrgSources,
  inviteVenomOrgMember,
  removeVenomOrgMember,
  removeVenomOrgSource,
  revokeVenomOrgInvite,
  shareVenomOrgProject,
  unshareVenomOrgProject,
  updateVenomOrgMasterContribution,
  type VenomMasterContribution,
  type VenomOrgInviteForMe,
  type VenomOrgMember,
  type VenomOrgPendingInvite,
  type VenomOrgRole,
  type VenomOrgSharedProject,
  type VenomOrgSource,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useVenomWorkspace } from "@/context/venom-workspace";

type OrgDetail = {
  orgId: string;
  members: VenomOrgMember[];
  pendingInvites: VenomOrgPendingInvite[];
  projects: VenomOrgSharedProject[];
  sources: VenomOrgSource[];
  masterContribution: VenomMasterContribution;
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown } | null | undefined;
    if (
      data &&
      typeof data === "object" &&
      typeof data.error === "string" &&
      data.error.trim().length > 0
    ) {
      return data.error;
    }
  }
  return fallback;
}

function timeAgo(timestamp: number | undefined | null) {
  if (!timestamp) return null;
  try {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  } catch {
    return null;
  }
}

const sectionMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
};

function SectionCard({
  title,
  subtitle,
  icon,
  action,
  children,
  testId,
  destructive,
}: {
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  destructive?: boolean;
}) {
  return (
    <motion.section
      {...sectionMotion}
      className={cn(
        "overflow-hidden rounded-2xl border surface shadow-soft",
        destructive ? "border-destructive/30" : "border-border/60",
      )}
      data-testid={testId}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border",
              destructive
                ? "border-destructive/30 text-destructive"
                : "border-border/60 text-foreground",
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {action}
      </header>
      <div className="p-5 md:p-6">{children}</div>
    </motion.section>
  );
}

function RolePill({ role }: { role: VenomOrgRole }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        role === "admin"
          ? "border-foreground/30 text-foreground"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {role === "admin" ? "Admin" : "Member"}
    </span>
  );
}

export default function CompanyPage() {
  // Same placeholder-identity convention as the workspace context: browser
  // tests have no Clerk session, so account-gated pages use the fixed id.
  const { userId: authenticatedUserId } = useAuth();
  const userId = IS_UI_TEST ? UI_TEST_USER_ID : authenticatedUserId;
  const { state, orgs, orgInvites, refreshOrgs } = useVenomWorkspace();
  const { toast } = useToast();

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailNonce, setDetailNonce] = useState(0);

  const [showCreate, setShowCreate] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<VenomOrgRole>("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [shareProjectId, setShareProjectId] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [gitHubRepo, setGitHubRepo] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [sourceBusy, setSourceBusy] = useState<null | "github" | "website">(
    null,
  );
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const activeOrg = useMemo(
    () => orgs.find((org) => org.id === selectedOrgId) ?? null,
    [orgs, selectedOrgId],
  );
  const isAdmin = activeOrg?.role === "admin";

  const refreshDetail = () => setDetailNonce((nonce) => nonce + 1);

  // Keep the selection pointing at a company we still belong to.
  useEffect(() => {
    if (orgs.length === 0) {
      if (selectedOrgId !== null) setSelectedOrgId(null);
      return;
    }
    if (!selectedOrgId || !orgs.some((org) => org.id === selectedOrgId)) {
      setSelectedOrgId(orgs[0].id);
    }
  }, [orgs, selectedOrgId]);

  // Reset per-company forms when switching companies.
  useEffect(() => {
    setInviteEmail("");
    setInviteRole("member");
    setShareProjectId("");
    setGitHubRepo("");
    setWebsiteUrl("");
  }, [selectedOrgId]);

  // Load the member / project / source detail for the selected company.
  useEffect(() => {
    if (!selectedOrgId || !userId) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailFailed(false);
    setDetail((current) =>
      current && current.orgId === selectedOrgId ? current : null,
    );
    void Promise.all([
      getVenomOrgMembers(selectedOrgId),
      getVenomOrgProjects(selectedOrgId),
      getVenomOrgSources(selectedOrgId),
      getVenomOrgMasterContribution(selectedOrgId),
    ])
      .then(([memberDirectory, projectList, sourceList, contribution]) => {
        if (cancelled) return;
        setDetail({
          orgId: selectedOrgId,
          members: memberDirectory.members,
          pendingInvites: memberDirectory.invites,
          projects: projectList.projects,
          sources: sourceList.sources,
          masterContribution: contribution,
        });
        setDetailLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetailLoading(false);
        if (
          error instanceof ApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          // Membership ended (or the company is gone) while we were looking.
          setSelectedOrgId(null);
          setDetail(null);
          refreshOrgs();
          return;
        }
        setDetailFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrgId, userId, detailNonce]);

  async function withBusy(
    key: string,
    fn: () => Promise<void>,
    failureTitle: string,
  ) {
    if (rowBusy) return;
    setRowBusy(key);
    try {
      await fn();
    } catch (error) {
      toast({
        title: failureTitle,
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setRowBusy(null);
    }
  }

  const handleAcceptInvite = (invite: VenomOrgInviteForMe) =>
    withBusy(
      `myinvite:${invite.id}`,
      async () => {
        const org = await acceptVenomOrgInvite(invite.id);
        refreshOrgs();
        setSelectedOrgId(org.id);
      },
      "Could not accept the invite",
    );

  const handleDeclineInvite = (invite: VenomOrgInviteForMe) =>
    withBusy(
      `myinvite:${invite.id}`,
      async () => {
        await declineVenomOrgInvite(invite.id);
        refreshOrgs();
      },
      "Could not decline the invite",
    );

  // Admin-only: whether this company contributes anonymous concept-level
  // signals to Venom's master ontology. Enforced server-side; this toggle
  // only flips the consent flag.
  const handleSetContribution = (enabled: boolean) =>
    withBusy(
      "network-contribution",
      async () => {
        if (!selectedOrgId) return;
        const updated = await updateVenomOrgMasterContribution(selectedOrgId, {
          enabled,
        });
        setDetail((current) =>
          current && current.orgId === selectedOrgId
            ? { ...current, masterContribution: updated }
            : current,
        );
        toast({
          title: enabled
            ? "Contributing to the Venom network"
            : "Contribution stopped",
          description: enabled
            ? "Anonymous concept patterns from this company now help improve Venom for everyone."
            : "This company's influence is removed from future network updates.",
        });
      },
      "Could not update the setting",
    );

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newOrgName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    try {
      const org = await createVenomOrg({ name });
      setNewOrgName("");
      setShowCreate(false);
      refreshOrgs();
      setSelectedOrgId(org.id);
    } catch (error) {
      toast({
        title: "Could not create the company",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setCreateBusy(false);
    }
  };

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email || !activeOrg || inviteBusy) return;
    setInviteBusy(true);
    try {
      const result = await inviteVenomOrgMember(activeOrg.id, {
        email,
        role: inviteRole,
      });
      setInviteEmail("");
      refreshDetail();
      refreshOrgs();
      toast({
        title:
          result.status === "added"
            ? `${email} joined ${activeOrg.name}`
            : `Invite sent to ${email}`,
        description:
          result.status === "added"
            ? "They already use Venom, so they were added right away."
            : "It will be waiting on their Company page when they sign in with that email.",
      });
    } catch (error) {
      toast({
        title: "Could not invite that email",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setInviteBusy(false);
    }
  };

  const handleRevokeInvite = (invite: VenomOrgPendingInvite) => {
    if (!activeOrg) return;
    void withBusy(
      `pending:${invite.id}`,
      async () => {
        await revokeVenomOrgInvite(activeOrg.id, invite.id);
        refreshDetail();
      },
      "Could not revoke the invite",
    );
  };

  const handleRemoveMember = (member: VenomOrgMember) => {
    if (!activeOrg || member.isSelf) return;
    const confirmed = window.confirm(
      `Remove ${member.name} from ${activeOrg.name}? They immediately lose the company Brain and its evidence.`,
    );
    if (!confirmed) return;
    void withBusy(
      `member:${member.userId}`,
      async () => {
        await removeVenomOrgMember(activeOrg.id, member.userId);
        refreshDetail();
        refreshOrgs();
      },
      "Could not remove that member",
    );
  };

  const handleLeave = () => {
    if (!activeOrg || !userId) return;
    const confirmed = window.confirm(
      `Leave ${activeOrg.name}? You immediately lose the company Brain, its projects, and its sources on all your devices.`,
    );
    if (!confirmed) return;
    void withBusy(
      "danger:leave",
      async () => {
        await removeVenomOrgMember(activeOrg.id, userId);
        setSelectedOrgId(null);
        setDetail(null);
        refreshOrgs();
      },
      "Could not leave the company",
    );
  };

  const handleDeleteOrg = () => {
    if (!activeOrg) return;
    const confirmed = window.confirm(
      `Delete ${activeOrg.name} for everyone? The shared Brain, its projects, and its sources are removed for every member. This cannot be undone.`,
    );
    if (!confirmed) return;
    void withBusy(
      "danger:delete",
      async () => {
        await deleteVenomOrg(activeOrg.id);
        setSelectedOrgId(null);
        setDetail(null);
        refreshOrgs();
      },
      "Could not delete the company",
    );
  };

  const shareCandidates = useMemo(() => {
    const sharedIds = new Set(
      (detail?.projects ?? []).map((record) => record.projectId),
    );
    return state.projects.filter(
      (project) =>
        !project.orgMirror && !project.orgId && !sharedIds.has(project.id),
    );
  }, [state.projects, detail?.projects]);

  const handleShare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!activeOrg || !shareProjectId || shareBusy) return;
    const project = state.projects.find((item) => item.id === shareProjectId);
    if (!project) return;
    setShareBusy(true);
    try {
      await shareVenomOrgProject(activeOrg.id, project.id, {
        name: project.name,
        description: project.description.trim()
          ? project.description
          : undefined,
        accent: project.accent ? project.accent : undefined,
      });
      setShareProjectId("");
      refreshDetail();
      refreshOrgs();
    } catch (error) {
      toast({
        title: "Could not share that project",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setShareBusy(false);
    }
  };

  const handleUnshare = (record: VenomOrgSharedProject) => {
    if (!activeOrg) return;
    const confirmed = window.confirm(
      `Stop sharing “${record.name}”? Teammates lose the project, and new chats in it stay personal. What it already taught the company Brain remains.`,
    );
    if (!confirmed) return;
    void withBusy(
      `project:${record.projectId}`,
      async () => {
        await unshareVenomOrgProject(activeOrg.id, record.projectId);
        refreshDetail();
        refreshOrgs();
      },
      "Could not stop sharing that project",
    );
  };

  const handleConnectGitHub = async (event: React.FormEvent) => {
    event.preventDefault();
    const repository = gitHubRepo.trim();
    if (!activeOrg || !repository || sourceBusy) return;
    setSourceBusy("github");
    try {
      await connectVenomOrgGitHubSource(activeOrg.id, { repository });
      setGitHubRepo("");
      refreshDetail();
    } catch (error) {
      toast({
        title: "Could not connect that repository",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setSourceBusy(null);
    }
  };

  const handleConnectWebsite = async (event: React.FormEvent) => {
    event.preventDefault();
    const url = websiteUrl.trim();
    if (!activeOrg || !url || sourceBusy) return;
    setSourceBusy("website");
    try {
      await connectVenomOrgWebsiteSource(activeOrg.id, { url });
      setWebsiteUrl("");
      refreshDetail();
    } catch (error) {
      toast({
        title: "Could not connect that website",
        description: errorMessage(error, "Please try again."),
        variant: "destructive",
      });
    } finally {
      setSourceBusy(null);
    }
  };

  const handleRemoveSource = (source: VenomOrgSource) => {
    if (!activeOrg) return;
    const confirmed = window.confirm(
      `Remove ${source.name}? Its knowledge is retired from the company Brain for everyone.`,
    );
    if (!confirmed) return;
    void withBusy(
      `source:${source.id}`,
      async () => {
        await removeVenomOrgSource(activeOrg.id, source.id);
        refreshDetail();
      },
      "Could not remove that source",
    );
  };

  const hasCompanies = orgs.length > 0;
  const showEmptyHero = !hasCompanies && orgInvites.length === 0;
  const detailReady = detail !== null && detail.orgId === selectedOrgId;

  const createForm = (
    <form
      onSubmit={handleCreate}
      className="flex w-full max-w-md flex-col gap-2 sm:flex-row"
    >
      <Input
        value={newOrgName}
        onChange={(event) => setNewOrgName(event.target.value)}
        placeholder="Company name"
        maxLength={80}
        aria-label="Company name"
        data-testid="company-create-name"
        className="h-11 flex-1 rounded-xl"
      />
      <Button
        type="submit"
        size="lg"
        className="h-11 rounded-xl"
        disabled={!newOrgName.trim() || createBusy}
        aria-busy={createBusy}
        data-testid="company-create-submit"
      >
        <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
        {createBusy ? "Creating…" : "Create company"}
      </Button>
    </form>
  );

  return (
    <main
      className="h-full flex-1 overflow-y-auto bg-background p-4 md:p-8"
      data-testid="company-page"
    >
      <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-6 pb-24">
        <header className="flex flex-col justify-between gap-4 border-b border-border/60 pb-6 pt-2 md:flex-row md:items-end">
          <div>
            <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
              <Building2 className="h-8 w-8" aria-hidden="true" />
              Company
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              A shared Brain your team trains together. Only chats in shared
              projects, company sources, and concepts someone promotes ever
              reach it — personal work stays personal.
            </p>
          </div>
          {hasCompanies && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refreshOrgs();
                refreshDetail();
              }}
              disabled={detailLoading}
              aria-busy={detailLoading}
              aria-label="Refresh company data"
              className="min-h-10 rounded-md"
              data-testid="company-refresh"
            >
              <RefreshCw
                className={cn("mr-2 h-4 w-4", detailLoading && "animate-spin")}
                aria-hidden="true"
              />
              Refresh
            </Button>
          )}
        </header>

        <AnimatePresence initial={false}>
          {orgInvites.length > 0 && (
            <motion.section
              {...sectionMotion}
              exit={{ opacity: 0, y: -8 }}
              className="overflow-hidden rounded-2xl border border-foreground/25 surface shadow-lift"
              aria-label="Invitations waiting for you"
              data-testid="company-invites"
            >
              <header className="flex items-center gap-3 border-b border-border/60 px-5 py-4 md:px-6">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-border/60"
                  aria-hidden="true"
                >
                  <Mail className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    You’re invited
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Accepting gives you the company Brain on every device you
                    use.
                  </p>
                </div>
              </header>
              <ul className="divide-y divide-border/60">
                {orgInvites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 md:px-6"
                    data-testid={`company-invite-${invite.id}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {invite.orgName}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Invited by {invite.invitedByName}
                        {timeAgo(invite.createdAt)
                          ? ` · ${timeAgo(invite.createdAt)}`
                          : ""}{" "}
                        · joining as{" "}
                        {invite.role === "admin" ? "an admin" : "a member"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => void handleAcceptInvite(invite)}
                        disabled={rowBusy !== null}
                        aria-busy={rowBusy === `myinvite:${invite.id}`}
                        className="rounded-md"
                        data-testid={`company-invite-accept-${invite.id}`}
                      >
                        <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleDeclineInvite(invite)}
                        disabled={rowBusy !== null}
                        aria-busy={rowBusy === `myinvite:${invite.id}`}
                        className="rounded-md"
                        data-testid={`company-invite-decline-${invite.id}`}
                      >
                        Decline
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </motion.section>
          )}
        </AnimatePresence>

        {showEmptyHero ? (
          <motion.section
            {...sectionMotion}
            className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-border/60 surface px-6 py-20 text-center shadow-soft"
            data-testid="company-empty"
          >
            <span
              className="mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-border/60"
              aria-hidden="true"
            >
              <Building2 className="h-8 w-8" />
            </span>
            <h2 className="text-2xl font-semibold text-foreground">
              Give your team a <span className="glow-text">shared Brain</span>
            </h2>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
              Create a company, invite teammates by email, and train one Brain
              together from shared projects and company knowledge sources.
              Personal chats and your own Brain stay yours.
            </p>
            <div className="mt-8 flex w-full justify-center">{createForm}</div>
          </motion.section>
        ) : (
          <>
            <nav
              aria-label="Your companies"
              className="flex flex-wrap items-center gap-2"
              data-testid="company-switcher"
            >
              {orgs.map((org) => {
                const selected = org.id === selectedOrgId;
                return (
                  <button
                    key={org.id}
                    type="button"
                    onClick={() => setSelectedOrgId(org.id)}
                    aria-pressed={selected}
                    className={cn(
                      "h-9 rounded-full border px-4 text-sm font-medium transition-colors",
                      selected
                        ? "border-foreground bg-foreground text-background"
                        : "border-border/60 bg-background text-muted-foreground hover:text-foreground",
                    )}
                    data-testid={`company-org-${org.id}`}
                  >
                    {org.name}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setShowCreate((current) => !current)}
                aria-expanded={showCreate}
                className="flex h-9 items-center gap-1.5 rounded-full border border-dashed border-border/60 px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                data-testid="company-create-toggle"
              >
                {showCreate ? (
                  <X className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
                New company
              </button>
            </nav>

            <AnimatePresence initial={false}>
              {(showCreate || !hasCompanies) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  <div className="rounded-2xl border border-border/60 surface p-5 shadow-soft md:p-6">
                    <p className="mb-3 text-sm text-muted-foreground">
                      Name the company workspace. You start as its admin.
                    </p>
                    {createForm}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {activeOrg && (
              <div className="flex flex-col gap-6" key={activeOrg.id}>
                {detailFailed ? (
                  <motion.div
                    {...sectionMotion}
                    className="rounded-2xl border border-border/60 surface p-10 text-center shadow-soft"
                    role="alert"
                  >
                    <AlertCircle
                      className="mx-auto mb-3 h-8 w-8 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <p className="mb-4 text-sm text-muted-foreground">
                      {activeOrg.name} can’t be reached right now.
                    </p>
                    <Button
                      variant="outline"
                      onClick={refreshDetail}
                      data-testid="company-detail-retry"
                    >
                      Retry
                    </Button>
                  </motion.div>
                ) : !detailReady ? (
                  <div
                    className="flex flex-col gap-6"
                    aria-label={`Loading ${activeOrg.name}`}
                    data-testid="company-detail-loading"
                  >
                    <Skeleton className="h-48 w-full rounded-2xl" />
                    <Skeleton className="h-40 w-full rounded-2xl" />
                    <Skeleton className="h-40 w-full rounded-2xl" />
                  </div>
                ) : (
                  <>
                    <SectionCard
                      title="People"
                      subtitle={`${detail.members.length} ${detail.members.length === 1 ? "person" : "people"} share this Brain`}
                      icon={<Users className="h-4 w-4" />}
                      testId="company-members"
                    >
                      <ul className="flex flex-col divide-y divide-border/60">
                        {detail.members.map((member) => (
                          <li
                            key={member.userId}
                            className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                            data-testid={`company-member-${member.userId}`}
                          >
                            <div className="min-w-0">
                              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                                <span className="truncate">{member.name}</span>
                                {member.isSelf && (
                                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                    You
                                  </span>
                                )}
                              </p>
                              {member.email && (
                                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {member.email}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <RolePill role={member.role} />
                              {isAdmin && !member.isSelf && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleRemoveMember(member)}
                                  disabled={rowBusy !== null}
                                  aria-busy={
                                    rowBusy === `member:${member.userId}`
                                  }
                                  aria-label={`Remove ${member.name}`}
                                  className="rounded-md text-muted-foreground hover:text-destructive"
                                  data-testid={`company-member-remove-${member.userId}`}
                                >
                                  <UserMinus
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>

                      {detail.pendingInvites.length > 0 && (
                        <div className="mt-5 rounded-xl border border-dashed border-border/60 p-4">
                          <p className="mb-2 text-xs font-medium text-muted-foreground">
                            Waiting on
                          </p>
                          <ul className="flex flex-col gap-2">
                            {detail.pendingInvites.map((invite) => (
                              <li
                                key={invite.id}
                                className="flex flex-wrap items-center justify-between gap-2"
                                data-testid={`company-pending-${invite.id}`}
                              >
                                <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                                  <Mail
                                    className="h-3.5 w-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span className="truncate">
                                    {invite.email}
                                  </span>
                                  <RolePill role={invite.role} />
                                </div>
                                {isAdmin && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleRevokeInvite(invite)}
                                    disabled={rowBusy !== null}
                                    aria-busy={
                                      rowBusy === `pending:${invite.id}`
                                    }
                                    className="rounded-md text-muted-foreground hover:text-foreground"
                                    data-testid={`company-pending-revoke-${invite.id}`}
                                  >
                                    Revoke
                                  </Button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {isAdmin && (
                        <form
                          onSubmit={handleInvite}
                          className="mt-5 flex flex-col gap-2 sm:flex-row"
                        >
                          <Input
                            type="email"
                            value={inviteEmail}
                            onChange={(event) =>
                              setInviteEmail(event.target.value)
                            }
                            placeholder="teammate@company.com"
                            aria-label="Teammate email"
                            data-testid="company-invite-email"
                            className="h-11 flex-1 rounded-xl"
                          />
                          <select
                            value={inviteRole}
                            onChange={(event) =>
                              setInviteRole(
                                event.target.value === "admin"
                                  ? "admin"
                                  : "member",
                              )
                            }
                            aria-label="Role for the new member"
                            data-testid="company-invite-role"
                            className="h-11 appearance-none rounded-xl border border-border/60 bg-background px-4 text-sm outline-none focus-visible:border-foreground/40"
                          >
                            <option value="member">Member</option>
                            <option value="admin">Admin</option>
                          </select>
                          <Button
                            type="submit"
                            size="lg"
                            className="h-11 rounded-xl"
                            disabled={!inviteEmail.trim() || inviteBusy}
                            aria-busy={inviteBusy}
                            data-testid="company-invite-submit"
                          >
                            {inviteBusy ? "Inviting…" : "Invite"}
                          </Button>
                        </form>
                      )}
                    </SectionCard>

                    <SectionCard
                      title="Shared projects"
                      subtitle="Chats inside these projects teach the company Brain, with citations."
                      icon={<FolderKanban className="h-4 w-4" />}
                      testId="company-projects"
                    >
                      {detail.projects.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Nothing is shared yet.{" "}
                          {isAdmin
                            ? "Pick one of your projects below to open it to the team."
                            : "An admin can share a project to get the team Brain growing."}
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                          {detail.projects.map((record) => {
                            const mine = record.sharedByUserId === userId;
                            const canUnshare = isAdmin || mine;
                            return (
                              <li
                                key={record.projectId}
                                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                                data-testid={`company-project-${record.projectId}`}
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {record.name}
                                  </p>
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    Shared by {mine ? "you" : record.sharedByName}
                                    {timeAgo(record.sharedAt)
                                      ? ` · ${timeAgo(record.sharedAt)}`
                                      : ""}
                                  </p>
                                </div>
                                {canUnshare && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleUnshare(record)}
                                    disabled={rowBusy !== null}
                                    aria-busy={
                                      rowBusy === `project:${record.projectId}`
                                    }
                                    className="rounded-md"
                                    data-testid={`company-unshare-${record.projectId}`}
                                  >
                                    <X
                                      className="mr-1.5 h-3.5 w-3.5"
                                      aria-hidden="true"
                                    />
                                    Unshare
                                  </Button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {isAdmin && (
                        <form
                          onSubmit={handleShare}
                          className="mt-5 flex flex-col gap-2 sm:flex-row"
                        >
                          <select
                            value={shareProjectId}
                            onChange={(event) =>
                              setShareProjectId(event.target.value)
                            }
                            aria-label="Project to share"
                            data-testid="company-share-select"
                            className="h-11 flex-1 appearance-none rounded-xl border border-border/60 bg-background px-4 text-sm outline-none focus-visible:border-foreground/40"
                            disabled={shareCandidates.length === 0}
                          >
                            <option value="">
                              {shareCandidates.length === 0
                                ? "No unshared projects left"
                                : "Choose a project to share…"}
                            </option>
                            {shareCandidates.map((project) => (
                              <option key={project.id} value={project.id}>
                                {project.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="submit"
                            size="lg"
                            className="h-11 rounded-xl"
                            disabled={!shareProjectId || shareBusy}
                            aria-busy={shareBusy}
                            data-testid="company-share-submit"
                          >
                            <Share2
                              className="mr-2 h-4 w-4"
                              aria-hidden="true"
                            />
                            {shareBusy ? "Sharing…" : "Share"}
                          </Button>
                        </form>
                      )}
                    </SectionCard>

                    <SectionCard
                      title="Knowledge sources"
                      subtitle="Company-connected sources feed the shared Brain for everyone."
                      icon={<Globe className="h-4 w-4" />}
                      testId="company-sources"
                    >
                      {detail.sources.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No company sources yet.
                          {isAdmin
                            ? " Connect a repository or website below."
                            : " An admin can connect repositories and websites here."}
                        </p>
                      ) : (
                        <ul className="flex flex-col divide-y divide-border/60">
                          {detail.sources.map((source) => (
                            <li
                              key={source.id}
                              className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
                              data-testid={`company-source-${source.id}`}
                            >
                              <div className="flex min-w-0 items-start gap-3">
                                <span
                                  className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 text-foreground"
                                  aria-hidden="true"
                                >
                                  {source.provider === "github" ? (
                                    <Github className="h-4 w-4" />
                                  ) : (
                                    <Globe className="h-4 w-4" />
                                  )}
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-foreground">
                                    {source.name}
                                  </p>
                                  {source.summary && (
                                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                      {source.summary}
                                    </p>
                                  )}
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Connected by {source.connectedByName}
                                    {timeAgo(source.syncedAt)
                                      ? ` · ${timeAgo(source.syncedAt)}`
                                      : ""}
                                  </p>
                                </div>
                              </div>
                              {isAdmin && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleRemoveSource(source)}
                                  disabled={rowBusy !== null}
                                  aria-busy={rowBusy === `source:${source.id}`}
                                  aria-label={`Remove ${source.name}`}
                                  className="rounded-md text-muted-foreground hover:text-destructive"
                                  data-testid={`company-source-remove-${source.id}`}
                                >
                                  <Trash2
                                    className="h-4 w-4"
                                    aria-hidden="true"
                                  />
                                </Button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}

                      {isAdmin && (
                        <div className="mt-5 flex flex-col gap-3">
                          <form
                            onSubmit={handleConnectGitHub}
                            className="flex flex-col gap-2 sm:flex-row"
                          >
                            <Input
                              value={gitHubRepo}
                              onChange={(event) =>
                                setGitHubRepo(event.target.value)
                              }
                              placeholder="owner/repository"
                              aria-label="GitHub repository"
                              data-testid="company-github-repo"
                              className="h-11 flex-1 rounded-xl"
                            />
                            <Button
                              type="submit"
                              variant="outline"
                              size="lg"
                              className="h-11 rounded-xl"
                              disabled={!gitHubRepo.trim() || sourceBusy !== null}
                              aria-busy={sourceBusy === "github"}
                              data-testid="company-github-connect"
                            >
                              <Github
                                className="mr-2 h-4 w-4"
                                aria-hidden="true"
                              />
                              {sourceBusy === "github"
                                ? "Absorbing…"
                                : "Connect repo"}
                            </Button>
                          </form>
                          <form
                            onSubmit={handleConnectWebsite}
                            className="flex flex-col gap-2 sm:flex-row"
                          >
                            <Input
                              type="url"
                              value={websiteUrl}
                              onChange={(event) =>
                                setWebsiteUrl(event.target.value)
                              }
                              placeholder="https://docs.yourcompany.com"
                              aria-label="Website address"
                              data-testid="company-website-url"
                              className="h-11 flex-1 rounded-xl"
                            />
                            <Button
                              type="submit"
                              variant="outline"
                              size="lg"
                              className="h-11 rounded-xl"
                              disabled={!websiteUrl.trim() || sourceBusy !== null}
                              aria-busy={sourceBusy === "website"}
                              data-testid="company-website-connect"
                            >
                              <Globe
                                className="mr-2 h-4 w-4"
                                aria-hidden="true"
                              />
                              {sourceBusy === "website"
                                ? "Absorbing…"
                                : "Connect site"}
                            </Button>
                          </form>
                          <p className="text-xs text-muted-foreground">
                            Connecting can take a minute while Venom absorbs the
                            source into the shared Brain.
                          </p>
                        </div>
                      )}
                    </SectionCard>

                    <SectionCard
                      title="Venom network"
                      subtitle="Anonymous contribution to Venom's shared knowledge network"
                      icon={<Waypoints className="h-4 w-4" />}
                      testId="company-network-contribution"
                      action={
                        isAdmin ? (
                          <button
                            type="button"
                            role="switch"
                            aria-checked={detail.masterContribution.enabled}
                            aria-label="Contribute anonymous concept patterns to the Venom network"
                            data-testid="company-network-toggle"
                            disabled={rowBusy !== null}
                            aria-busy={rowBusy === "network-contribution"}
                            onClick={() =>
                              handleSetContribution(
                                !detail.masterContribution.enabled,
                              )
                            }
                            className={cn(
                              "rounded-full border px-4 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                              detail.masterContribution.enabled
                                ? "border-foreground bg-foreground text-background"
                                : "border-border/60 text-muted-foreground hover:border-foreground/50 hover:text-foreground",
                            )}
                          >
                            {detail.masterContribution.enabled
                              ? "Contributing"
                              : "Off"}
                          </button>
                        ) : (
                          <span
                            className="rounded-full border border-border/60 px-4 py-1.5 text-xs font-medium text-muted-foreground"
                            data-testid="company-network-state"
                          >
                            {detail.masterContribution.enabled
                              ? "Contributing"
                              : "Off"}
                          </span>
                        )
                      }
                    >
                      <div className="space-y-3">
                        <p className="text-sm leading-relaxed text-muted-foreground">
                          When on, {activeOrg.name} shares anonymous
                          concept-level patterns — concept names, categories,
                          and which concepts connect — to make Venom's
                          suggestions and extraction smarter for everyone.
                        </p>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          Never shared: chats, notes, sources, evidence, or
                          member names. Rare concepts stay hidden until they
                          are common across many accounts, and turning this
                          off removes the company's influence from future
                          network updates.
                        </p>
                        {!isAdmin && (
                          <p
                            className="text-xs text-muted-foreground"
                            data-testid="company-network-readonly"
                          >
                            Only admins can change this.
                          </p>
                        )}
                      </div>
                    </SectionCard>

                    <SectionCard
                      title="Danger zone"
                      icon={<AlertCircle className="h-4 w-4" />}
                      testId="company-danger"
                      destructive
                    >
                      <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-foreground">
                              Leave {activeOrg.name}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              You lose the company Brain immediately, on every
                              device.
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleLeave}
                            disabled={rowBusy !== null}
                            aria-busy={rowBusy === "danger:leave"}
                            className="rounded-md text-destructive hover:text-destructive"
                            data-testid="company-leave"
                          >
                            <LogOut
                              className="mr-1.5 h-4 w-4"
                              aria-hidden="true"
                            />
                            Leave
                          </Button>
                        </div>
                        {isAdmin && (
                          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                Delete {activeOrg.name}
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                Removes the shared Brain, projects, and sources
                                for every member. Permanent.
                              </p>
                            </div>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={handleDeleteOrg}
                              disabled={rowBusy !== null}
                              aria-busy={rowBusy === "danger:delete"}
                              className="rounded-md"
                              data-testid="company-delete"
                            >
                              <Trash2
                                className="mr-1.5 h-4 w-4"
                                aria-hidden="true"
                              />
                              Delete company
                            </Button>
                          </div>
                        )}
                      </div>
                    </SectionCard>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
