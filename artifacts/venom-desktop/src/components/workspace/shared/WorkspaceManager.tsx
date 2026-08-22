import { useState } from "react";
import { Building2, Plus, Users } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSharedWorkspace, type SharedWorkspace } from "@/context/shared-workspace";
import CreateWorkspaceDialog from "@/components/workspace/shared/CreateWorkspaceDialog";
import WorkspaceMembersDialog from "@/components/workspace/shared/WorkspaceMembersDialog";

/**
 * Management-only surface for shared workspaces: create one, open a
 * workspace's members and settings. Deliberately NOT a scope switcher —
 * chatting needs no workspace choice (knowledge sorts itself, Task #281),
 * and reading a workspace's Brain happens through the Brain page's filter.
 */
export default function WorkspaceManager({ idPrefix }: { idPrefix: string }) {
  const { workspaces } = useSharedWorkspace();
  const [open, setOpen] = useState(false);
  const [membersWorkspace, setMembersWorkspace] =
    useState<SharedWorkspace | null>(null);

  return (
    <div className="shrink-0 px-3 pb-2">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            data-testid={`button-workspace-manager-${idPrefix}`}
            className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="Shared workspaces"
          >
            <Building2 className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="flex-1 truncate text-left">Workspaces</span>
            {workspaces.length > 0 && (
              <span className="text-xs tabular-nums text-sidebar-foreground/60">
                {workspaces.length}
              </span>
            )}
          </button>
        </DialogTrigger>
        <DialogContent
          data-testid="workspace-manager"
          className="sm:max-w-[480px] rounded-2xl border border-border/60 surface p-0 overflow-hidden shadow-lift"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-foreground/5 to-transparent pointer-events-none" />
          <div className="relative p-6 sm:p-8">
            <DialogHeader className="mb-5">
              <DialogTitle className="text-2xl font-semibold tracking-tight">
                Shared workspaces
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-2">
                Spaces your teams share. Venom files chat knowledge to the
                right workspace by topic — browse it under Brain, and manage
                members and settings here.
              </DialogDescription>
            </DialogHeader>

            {workspaces.length === 0 ? (
              <p
                className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-sm text-muted-foreground"
                data-testid="workspace-manager-empty"
              >
                No shared workspaces yet. Create one to share knowledge and
                SOPs with a team.
              </p>
            ) : (
              <ul className="space-y-1.5" data-testid="workspace-manager-list">
                {workspaces.map((workspace) => (
                  <li
                    key={workspace.id}
                    className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/40 px-3.5 py-2.5"
                    data-testid={`workspace-manager-row-${workspace.id}`}
                  >
                    <Building2
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{workspace.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {workspace.role === "admin" ? "Admin" : "Member"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMembersWorkspace(workspace)}
                      data-testid={`button-workspace-members-${workspace.id}`}
                      className="flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Members and settings of ${workspace.name}`}
                    >
                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Members</span>
                      <span className="tabular-nums">{workspace.memberCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5 flex justify-end">
              <CreateWorkspaceDialog>
                <button
                  type="button"
                  data-testid="button-new-shared-space"
                  className="flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  New workspace
                </button>
              </CreateWorkspaceDialog>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {membersWorkspace && (
        <WorkspaceMembersDialog
          workspace={membersWorkspace}
          open={membersWorkspace !== null}
          onOpenChange={(next) => {
            if (!next) setMembersWorkspace(null);
          }}
        />
      )}
    </div>
  );
}
