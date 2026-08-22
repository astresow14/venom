import { useMemo, useState } from "react";
import { useUser } from "@clerk/react";
import { motion } from "framer-motion";
import { BookMarked, Loader2, ShieldCheck } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetVenomIdentityQueryKey,
  getListVenomCanonAdminsQueryKey,
  getListVenomCanonTeachingsQueryKey,
  grantVenomCanonAdmin,
  revokeVenomCanonAdmin,
  updateVenomCanonTeaching,
  useGetVenomIdentity,
  useListVenomCanonAdmins,
  useListVenomCanonTeachings,
  type VenomCanonTeaching,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { IS_UI_TEST } from "@/lib/ui-test";
import { UI_TEST_USER_ID } from "@/context/VenomWorkspaceContext";

const sectionMotion = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
};

function formatDate(iso: string) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The canon: Venom's curated global teaching tier, visible only to super
 * admins. Everything here is stewardship UI — the server re-verifies the
 * role on every request and refuses outsiders opaquely, so this page is a
 * doorway, never the lock.
 */
export default function CanonPage() {
  const { user } = useUser();
  const userId = user?.id ?? (IS_UI_TEST ? UI_TEST_USER_ID : null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: identity, isLoading: identityLoading } = useGetVenomIdentity({
    query: {
      queryKey: getGetVenomIdentityQueryKey(),
      enabled: Boolean(userId),
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const isAdmin = identity?.superAdmin === true;

  const teachingsQuery = useListVenomCanonTeachings({
    query: {
      queryKey: getListVenomCanonTeachingsQueryKey(),
      enabled: isAdmin,
      retry: 1,
    },
  });
  const adminsQuery = useListVenomCanonAdmins({
    query: {
      queryKey: getListVenomCanonAdminsQueryKey(),
      enabled: isAdmin,
      retry: 1,
    },
  });

  const [editing, setEditing] = useState<VenomCanonTeaching | null>(null);
  const [editDomain, setEditDomain] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editPrinciples, setEditPrinciples] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [revokeBusyId, setRevokeBusyId] = useState<string | null>(null);

  const teachings = teachingsQuery.data ?? [];
  const byDomain = useMemo(() => {
    const groups = new Map<string, VenomCanonTeaching[]>();
    for (const teaching of teachings) {
      const list = groups.get(teaching.domain) ?? [];
      list.push(teaching);
      groups.set(teaching.domain, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [teachings]);

  const refresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getListVenomCanonTeachingsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListVenomCanonAdminsQueryKey(),
    });
  };

  const openEdit = (teaching: VenomCanonTeaching) => {
    setEditing(teaching);
    setEditDomain(teaching.domain);
    setEditTitle(teaching.title);
    setEditPrinciples(teaching.principles.join("\n"));
  };

  const saveEdit = async () => {
    if (!editing || editBusy) return;
    const principles = editPrinciples
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!editDomain.trim() || !editTitle.trim() || principles.length === 0) {
      toast({
        title: "Incomplete",
        description:
          "A teaching needs a domain, a title, and at least one principle.",
        variant: "destructive",
      });
      return;
    }
    setEditBusy(true);
    try {
      await updateVenomCanonTeaching(editing.id, {
        domain: editDomain.trim(),
        title: editTitle.trim(),
        principles,
      });
      setEditing(null);
      refresh();
    } catch {
      toast({
        title: "Couldn't save",
        description: "The teaching wasn't changed. Try again.",
        variant: "destructive",
      });
    } finally {
      setEditBusy(false);
    }
  };

  const toggleStatus = async (teaching: VenomCanonTeaching) => {
    if (statusBusyId) return;
    setStatusBusyId(teaching.id);
    try {
      await updateVenomCanonTeaching(teaching.id, {
        status: teaching.status === "active" ? "retired" : "active",
      });
      refresh();
    } catch {
      toast({
        title: "Couldn't update",
        description: "The teaching's status wasn't changed. Try again.",
        variant: "destructive",
      });
    } finally {
      setStatusBusyId(null);
    }
  };

  const grant = async () => {
    const target = grantUserId.trim();
    if (!target || grantBusy) return;
    setGrantBusy(true);
    try {
      await grantVenomCanonAdmin({ userId: target });
      setGrantUserId("");
      refresh();
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      toast({
        title: "Couldn't grant",
        description:
          status === 400
            ? "No account with that id exists."
            : status === 409
              ? "That account is already a super admin."
              : "The role wasn't granted. Try again.",
        variant: "destructive",
      });
    } finally {
      setGrantBusy(false);
    }
  };

  const revoke = async (targetUserId: string) => {
    const confirmed = window.confirm(
      "Revoke super admin? They immediately lose the canon everywhere. Their past teachings stay.",
    );
    if (!confirmed) return;
    setRevokeBusyId(targetUserId);
    try {
      await revokeVenomCanonAdmin(targetUserId);
      refresh();
      void queryClient.invalidateQueries({
        queryKey: getGetVenomIdentityQueryKey(),
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      toast({
        title: "Couldn't revoke",
        description:
          status === 409
            ? "The canon must keep at least one steward."
            : status === 400
              ? "You can't revoke your own role."
              : "The role wasn't revoked. Try again.",
        variant: "destructive",
      });
    } finally {
      setRevokeBusyId(null);
    }
  };

  // Anyone without the role sees a dead end, never the canon itself. The
  // server refuses their requests anyway; the queries above never even run.
  if (!identityLoading && !isAdmin) {
    return (
      <div
        data-testid="canon-denied"
        className="flex h-full flex-col items-center justify-center bg-background p-8 text-center"
      >
        <p className="text-sm text-muted-foreground">There's nothing here.</p>
      </div>
    );
  }

  return (
    <div
      data-testid="canon-page"
      className="flex h-full flex-col overflow-hidden bg-background p-4 md:p-8"
    >
      <header className="mb-6 flex shrink-0 flex-col justify-between gap-4 border-b border-border pb-5 md:flex-row md:items-end">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Canon</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What Venom holds as taught truth, for everyone. Teach it in chat —
            "store these as core branding principles" — and steward it here.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 pb-10">
          {identityLoading || teachingsQuery.isLoading ? (
            <div className="flex flex-col gap-4" data-testid="canon-loading">
              <Skeleton className="h-32 w-full rounded-2xl" />
              <Skeleton className="h-32 w-full rounded-2xl" />
            </div>
          ) : teachingsQuery.isError ? (
            <motion.div
              {...sectionMotion}
              role="alert"
              className="rounded-2xl border border-border/60 surface p-10 text-center shadow-soft"
            >
              <p className="mb-4 text-sm text-muted-foreground">
                The canon couldn't be loaded.
              </p>
              <Button
                variant="outline"
                onClick={() => void teachingsQuery.refetch()}
                data-testid="canon-retry"
              >
                Retry
              </Button>
            </motion.div>
          ) : byDomain.length === 0 ? (
            <motion.div
              {...sectionMotion}
              className="flex flex-col items-center rounded-2xl border border-border/60 surface px-6 py-16 text-center shadow-soft"
              data-testid="canon-empty"
            >
              <span
                className="mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-border/60"
                aria-hidden="true"
              >
                <BookMarked className="h-6 w-6" />
              </span>
              <h2 className="text-xl font-semibold text-foreground">
                Nothing taught yet
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Tell Venom in chat — "store these as core branding principles"
                — review the card it shows you, and confirm. Teachings land
                here, organized by skill.
              </p>
            </motion.div>
          ) : (
            byDomain.map(([domain, entries]) => (
              <motion.section
                {...sectionMotion}
                key={domain}
                data-testid={`canon-domain-${domain}`}
              >
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  {domain}
                </h2>
                <div className="flex flex-col gap-3">
                  {entries.map((teaching) => (
                    <article
                      key={teaching.id}
                      data-testid={`canon-teaching-${teaching.id}`}
                      className={cn(
                        "rounded-2xl border border-border/60 surface p-5 shadow-soft",
                        teaching.status === "retired" && "opacity-60",
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <h3 className="text-base font-semibold text-foreground">
                          {teaching.title}
                        </h3>
                        <span
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-wide",
                            teaching.status === "active"
                              ? "border-foreground/50 text-foreground"
                              : "border-border/60 text-muted-foreground",
                          )}
                        >
                          {teaching.status}
                        </span>
                      </div>
                      <ul className="mt-3 grid gap-1.5">
                        {teaching.principles.map((principle, index) => (
                          <li
                            key={index}
                            className="flex gap-2 text-sm leading-relaxed"
                          >
                            <span
                              className="text-muted-foreground"
                              aria-hidden="true"
                            >
                              —
                            </span>
                            <span className="flex-1 text-foreground/90">
                              {principle}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs text-muted-foreground">
                        Taught by{" "}
                        {teaching.taughtByName ?? teaching.taughtByUserId}
                        {" · "}
                        {formatDate(teaching.taughtAt)}
                        {teaching.conversationTitle
                          ? ` · from "${teaching.conversationTitle}"`
                          : ""}
                      </p>
                      <div className="mt-4 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(teaching)}
                          data-testid={`canon-edit-${teaching.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void toggleStatus(teaching)}
                          disabled={statusBusyId === teaching.id}
                          aria-busy={statusBusyId === teaching.id}
                          data-testid={`canon-toggle-${teaching.id}`}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          {statusBusyId === teaching.id ? (
                            <Loader2
                              className="mr-1.5 h-3.5 w-3.5 animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          {teaching.status === "active" ? "Retire" : "Restore"}
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              </motion.section>
            ))
          )}

          <motion.section {...sectionMotion} data-testid="canon-stewards">
            <h2 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Stewards
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Super admins can teach, edit, and retire canon — and grant or
              revoke this role. Regular accounts never see any of it.
            </p>
            <div className="flex flex-col gap-2">
              {(adminsQuery.data ?? []).map((admin) => (
                <div
                  key={admin.userId}
                  data-testid={`canon-admin-${admin.userId}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/60 surface px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {admin.name ?? admin.userId}
                      {admin.userId === userId ? " (you)" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {admin.grantedByUserId === null
                        ? "Original steward"
                        : "Granted"}
                      {" · "}
                      {formatDate(admin.grantedAt)}
                    </p>
                  </div>
                  {admin.userId !== userId ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void revoke(admin.userId)}
                      disabled={revokeBusyId === admin.userId}
                      aria-busy={revokeBusyId === admin.userId}
                      data-testid={`canon-revoke-${admin.userId}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      {revokeBusyId === admin.userId ? (
                        <Loader2
                          className="mr-1.5 h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      ) : null}
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))}
              <form
                className="mt-1 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void grant();
                }}
              >
                <Input
                  value={grantUserId}
                  onChange={(event) => setGrantUserId(event.target.value)}
                  placeholder="Account id (user_…)"
                  autoComplete="off"
                  data-testid="canon-grant-input"
                  className="max-w-sm"
                />
                <Button
                  type="submit"
                  disabled={grantBusy || !grantUserId.trim()}
                  aria-busy={grantBusy}
                  data-testid="canon-grant-button"
                >
                  {grantBusy ? (
                    <Loader2
                      className="mr-1.5 h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  ) : null}
                  Grant
                </Button>
              </form>
            </div>
          </motion.section>
        </div>
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !editBusy) setEditing(null);
        }}
      >
        <DialogContent data-testid="canon-edit-modal">
          <DialogHeader>
            <DialogTitle>Edit teaching</DialogTitle>
            <DialogDescription>
              Changes apply to everyone's answers as soon as you save.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <label className="grid gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Skill domain
              <Input
                value={editDomain}
                onChange={(event) => setEditDomain(event.target.value)}
                data-testid="canon-edit-domain"
                className="text-sm normal-case tracking-normal"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Title
              <Input
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                data-testid="canon-edit-title"
                className="text-sm normal-case tracking-normal"
              />
            </label>
            <label className="grid gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Principles — one per line
              <Textarea
                value={editPrinciples}
                onChange={(event) => setEditPrinciples(event.target.value)}
                rows={6}
                data-testid="canon-edit-principles"
                className="text-sm normal-case tracking-normal"
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={editBusy}
              data-testid="canon-edit-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveEdit()}
              disabled={editBusy}
              aria-busy={editBusy}
              data-testid="canon-edit-save"
            >
              {editBusy ? (
                <Loader2
                  className="mr-1.5 h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
