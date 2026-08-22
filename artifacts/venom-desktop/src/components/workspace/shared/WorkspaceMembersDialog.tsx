import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  getGetSharedWorkspaceSettingsQueryKey,
  getListSharedWorkspaceMembersQueryKey,
  getListSharedWorkspacesQueryKey,
  useAddSharedWorkspaceMember,
  useGetSharedWorkspaceSettings,
  useListSharedWorkspaceMembers,
  useRemoveSharedWorkspaceMember,
  useUpdateSharedWorkspaceMemberRole,
  useUpdateSharedWorkspaceSettings,
  type SharedWorkspace,
  type SharedWorkspaceMember,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { asList } from "@/lib/as-list";
import { cn } from "@/lib/utils";
import {
  Check,
  Copy,
  Loader2,
  Lock,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";

/**
 * Member management for a shared workspace. Everyone can see who is in and
 * their roles; only admins get the add, remove, and role controls. Role
 * changes happen in place — nobody is removed, so access never lapses.
 * Removal is what makes revocation real: from the removed person's next
 * request the server answers 403 and their cached workspace content is
 * evicted.
 */
export default function WorkspaceMembersDialog({
  workspace,
  open,
  onOpenChange,
}: {
  workspace: SharedWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useUser();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [newMemberId, setNewMemberId] = useState("");
  const [newMemberRole, setNewMemberRole] = useState<"member" | "admin">(
    "member",
  );
  const [copied, setCopied] = useState(false);

  const isAdmin = workspace.role === "admin";
  const myUserId = user?.id ?? null;

  const membersQuery = useListSharedWorkspaceMembers(workspace.id, {
    query: {
      queryKey: getListSharedWorkspaceMembersQueryKey(workspace.id),
      enabled: open,
    },
  });
  const members = asList(membersQuery.data);

  const invalidateMembership = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListSharedWorkspaceMembersQueryKey(workspace.id),
      }),
      // Member counts ride the workspace list.
      queryClient.invalidateQueries({
        queryKey: getListSharedWorkspacesQueryKey(),
      }),
    ]);
  };

  const addMember = useAddSharedWorkspaceMember();
  const removeMember = useRemoveSharedWorkspaceMember();
  const updateMemberRole = useUpdateSharedWorkspaceMemberRole();

  const handleRoleChange = (
    member: SharedWorkspaceMember,
    nextRole: "member" | "admin",
  ) => {
    if (nextRole === member.role || updateMemberRole.isPending) return;
    const changingSelf = member.userId === myUserId;

    updateMemberRole.mutate(
      {
        workspaceId: workspace.id,
        memberUserId: member.userId,
        data: { role: nextRole },
      },
      {
        onSuccess: async (updated) => {
          // The caller's own role also rides the workspace list.
          await invalidateMembership();
          toast({
            title:
              updated.role === "admin" ? "Promoted to admin" : "Now a member",
            description: changingSelf
              ? updated.role === "admin"
                ? "You can manage members and settings."
                : "You stepped down without leaving the workspace."
              : "No removal involved — their access never lapsed.",
          });
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number })?.status;
          toast({
            title: "Could not change the role",
            description:
              status === 409
                ? "A workspace needs at least one admin. Promote someone else first."
                : status === 404
                  ? "They are no longer a member."
                  : status === 403
                    ? "Only admins can change roles."
                    : "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // The export policy is a security setting: the server only serves and
  // accepts it for admins, so the query stays off for everyone else.
  const settingsQuery = useGetSharedWorkspaceSettings(workspace.id, {
    query: {
      queryKey: getGetSharedWorkspaceSettingsQueryKey(workspace.id),
      enabled: open && isAdmin,
    },
  });
  const updateSettings = useUpdateSharedWorkspaceSettings();
  const allowSensitiveExport = settingsQuery.data?.allowSensitiveExport;

  const handlePolicyChange = (nextAllow: boolean) => {
    if (updateSettings.isPending) return;
    updateSettings.mutate(
      { workspaceId: workspace.id, data: { allowSensitiveExport: nextAllow } },
      {
        onSuccess: async (settings) => {
          await queryClient.invalidateQueries({
            queryKey: getGetSharedWorkspaceSettingsQueryKey(workspace.id),
          });
          toast({
            title: settings.allowSensitiveExport
              ? "Sensitive exports allowed"
              : "Sensitive exports blocked",
            description: settings.allowSensitiveExport
              ? "Downloads may include items marked sensitive."
              : "Locked items stay inside this workspace; downloads state what was withheld.",
          });
        },
        onError: () => {
          toast({
            title: "Could not update the policy",
            description: "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleAdd = (event: React.FormEvent) => {
    event.preventDefault();
    const memberId = newMemberId.trim();
    if (!memberId || addMember.isPending) return;

    addMember.mutate(
      { workspaceId: workspace.id, data: { userId: memberId, role: newMemberRole } },
      {
        onSuccess: async () => {
          await invalidateMembership();
          setNewMemberId("");
          setNewMemberRole("member");
          toast({
            title: "Member added",
            description: "They can see this workspace from their next sync.",
          });
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number })?.status;
          toast({
            title: "Could not add member",
            description:
              status === 404
                ? "No Venom account matches that ID."
                : status === 409
                  ? "They are already a member, or the workspace is full."
                  : status === 502
                    ? "The account directory is unreachable right now."
                    : "Check the account ID and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleRemove = (member: SharedWorkspaceMember) => {
    if (removeMember.isPending) return;
    const removingSelf = member.userId === myUserId;

    removeMember.mutate(
      { workspaceId: workspace.id, memberUserId: member.userId },
      {
        onSuccess: async () => {
          if (removingSelf) {
            onOpenChange(false);
            await queryClient.invalidateQueries({
              queryKey: getListSharedWorkspacesQueryKey(),
            });
            toast({
              title: "You left the workspace",
              description: "Its shared knowledge is no longer available here.",
            });
            return;
          }
          await invalidateMembership();
          toast({
            title: "Member removed",
            description:
              "Their access ends now: the server refuses their next workspace request and their devices drop the cached copy.",
          });
        },
        onError: (error: unknown) => {
          const status = (error as { status?: number })?.status;
          toast({
            title: removingSelf ? "Could not leave" : "Could not remove member",
            description:
              status === 409
                ? "A workspace needs at least one admin. Promote someone first."
                : status === 404
                  ? "They are no longer a member."
                  : "Try again in a moment.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleCopyId = async () => {
    if (!myUserId) return;
    try {
      await navigator.clipboard.writeText(myUserId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Copy failed", description: myUserId });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
        <div className="relative p-6 sm:p-8">
          <DialogHeader className="mb-6">
            <DialogTitle className="text-2xl font-semibold tracking-tight">
              {workspace.name}
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground mt-2">
              {isAdmin
                ? "Members see everything filed in this workspace. Removing someone cuts their access from their next request."
                : "Members of this shared workspace and their roles."}
            </DialogDescription>
          </DialogHeader>

          <div
            className="max-h-[320px] space-y-1 overflow-y-auto pr-1"
            data-testid="list-workspace-members"
          >
            {membersQuery.isLoading ? (
              <>
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </>
            ) : membersQuery.isError ? (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                The member list could not be loaded.
              </p>
            ) : (
              members.map((member) => {
                const isSelf = member.userId === myUserId;
                return (
                  <div
                    key={member.userId}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-foreground/5"
                    data-testid={`row-member-${member.userId}`}
                  >
                    <div
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background"
                      aria-hidden="true"
                    >
                      {(member.name || member.userId).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">
                        {member.name || member.userId}
                        {isSelf && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            you
                          </span>
                        )}
                      </div>
                      {member.name && (
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {member.userId}
                        </div>
                      )}
                    </div>
                    {isAdmin ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) =>
                          handleRoleChange(
                            member,
                            value === "admin" ? "admin" : "member",
                          )
                        }
                        disabled={updateMemberRole.isPending}
                      >
                        <SelectTrigger
                          className={cn(
                            "h-7 w-[104px] shrink-0 rounded-full border-border/60 px-2.5 text-[10px] font-semibold focus-visible:ring-1 focus-visible:ring-foreground",
                            member.role === "admin"
                              ? "bg-foreground text-background"
                              : "bg-transparent text-muted-foreground",
                          )}
                          aria-label={`Change role for ${member.name || member.userId}`}
                          data-testid={`select-member-role-${member.userId}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                          <SelectItem
                            value="member"
                            className="text-xs font-medium"
                          >
                            Member
                          </SelectItem>
                          <SelectItem
                            value="admin"
                            className="text-xs font-medium"
                          >
                            Admin
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold",
                          member.role === "admin"
                            ? "bg-foreground text-background"
                            : "border border-border/60 text-muted-foreground",
                        )}
                      >
                        {member.role === "admin" && (
                          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                        )}
                        {member.role}
                      </span>
                    )}
                    {isAdmin && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
                        onClick={() => handleRemove(member)}
                        disabled={removeMember.isPending}
                        aria-label={
                          isSelf
                            ? "Leave workspace"
                            : `Remove ${member.name || member.userId}`
                        }
                        data-testid={`button-remove-member-${member.userId}`}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {isAdmin && (
            <form
              onSubmit={handleAdd}
              className="mt-5 space-y-3 border-t border-border/60 pt-5"
            >
              <label
                htmlFor="new-member-id"
                className="block text-[10px] font-medium text-muted-foreground"
              >
                Add a member by account ID
              </label>
              <div className="flex gap-2">
                <Input
                  id="new-member-id"
                  value={newMemberId}
                  onChange={(event) => setNewMemberId(event.target.value)}
                  placeholder="user_…"
                  className="flex-1 rounded-md border-border/60 bg-background/50 font-mono text-xs focus-visible:ring-1 focus-visible:ring-foreground"
                  data-testid="input-new-member-id"
                />
                <Select
                  value={newMemberRole}
                  onValueChange={(value) =>
                    setNewMemberRole(value === "admin" ? "admin" : "member")
                  }
                >
                  <SelectTrigger className="w-[110px] rounded-md border-border/60 bg-background/50 text-xs font-medium focus-visible:ring-1 focus-visible:ring-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-lg border-border/60 bg-background shadow-lift">
                    <SelectItem value="member" className="text-xs font-medium">
                      Member
                    </SelectItem>
                    <SelectItem value="admin" className="text-xs font-medium">
                      Admin
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  type="submit"
                  disabled={!newMemberId.trim() || addMember.isPending}
                  className="rounded-md font-medium"
                  data-testid="button-add-member"
                >
                  {addMember.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <UserPlus className="h-4 w-4" aria-hidden="true" />
                  )}
                  <span className="ml-2">Add</span>
                </Button>
              </div>
            </form>
          )}

          {isAdmin && (
            <div
              className="mt-5 border-t border-border/60 pt-5"
              data-testid="section-workspace-security"
            >
              <div className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
                <Lock className="h-3 w-3" aria-hidden="true" />
                Security
              </div>
              <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    Allow sensitive content in exports
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    When off, items marked sensitive never leave this workspace:
                    downloads exclude them and say how many were withheld.
                  </p>
                </div>
                {settingsQuery.isLoading ? (
                  <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                ) : settingsQuery.isError ? (
                  <span className="shrink-0 text-xs text-destructive">
                    Unavailable
                  </span>
                ) : (
                  <Switch
                    checked={allowSensitiveExport === true}
                    onCheckedChange={handlePolicyChange}
                    disabled={updateSettings.isPending}
                    aria-label="Allow sensitive content in exports"
                    data-testid="switch-allow-sensitive-export"
                  />
                )}
              </div>
            </div>
          )}

          {myUserId && (
            <button
              type="button"
              onClick={handleCopyId}
              className="mt-4 flex w-full items-center gap-2 rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="button-copy-account-id"
            >
              <span className="text-[10px] font-medium text-muted-foreground">
                Your account ID
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
                {myUserId}
              </span>
              {copied ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Copy
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
