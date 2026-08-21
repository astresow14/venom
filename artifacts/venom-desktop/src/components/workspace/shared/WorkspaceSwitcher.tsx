import { useState } from "react";
import { ChevronDown, Plus, Users } from "lucide-react";
import { useSharedWorkspace } from "@/context/shared-workspace";
import CreateWorkspaceDialog from "@/components/workspace/shared/CreateWorkspaceDialog";
import WorkspaceMembersDialog from "@/components/workspace/shared/WorkspaceMembersDialog";

const PERSONAL_VALUE = "__personal__";

/**
 * Sidebar control for moving between the personal tier and shared
 * workspaces. Chat, Brain and SOPs all follow this selection.
 */
export default function WorkspaceSwitcher({ idPrefix }: { idPrefix: string }) {
  const { workspaces, activeWorkspace, selectWorkspace } = useSharedWorkspace();
  const [membersOpen, setMembersOpen] = useState(false);

  return (
    <div className="shrink-0 px-3 pb-2">
      <label htmlFor={`${idPrefix}-shared-space`} className="sr-only">
        Personal or shared workspace
      </label>
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <select
            id={`${idPrefix}-shared-space`}
            data-testid={`select-shared-space-${idPrefix}`}
            value={activeWorkspace?.id ?? PERSONAL_VALUE}
            onChange={(event) =>
              selectWorkspace(
                event.target.value === PERSONAL_VALUE
                  ? null
                  : event.target.value,
              )
            }
            className="h-10 w-full appearance-none rounded-lg border border-sidebar-border bg-transparent px-3 pr-9 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            title={activeWorkspace ? activeWorkspace.name : "Personal space"}
          >
            <option value={PERSONAL_VALUE}>Personal</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/70"
            aria-hidden="true"
          />
        </div>
        <CreateWorkspaceDialog>
          <button
            type="button"
            data-testid={`button-new-shared-space-${idPrefix}`}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label="New shared workspace"
            title="New shared workspace"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </CreateWorkspaceDialog>
      </div>

      {activeWorkspace && (
        <>
          <button
            type="button"
            onClick={() => setMembersOpen(true)}
            data-testid={`button-space-members-${idPrefix}`}
            className="mt-1 flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            aria-label={`Members of ${activeWorkspace.name}`}
          >
            <Users className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span className="flex-1 truncate text-left">Members</span>
            <span className="text-xs tabular-nums text-sidebar-foreground/60">
              {activeWorkspace.memberCount}
            </span>
          </button>
          <WorkspaceMembersDialog
            workspace={activeWorkspace}
            open={membersOpen}
            onOpenChange={setMembersOpen}
          />
        </>
      )}
    </div>
  );
}
