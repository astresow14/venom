import { useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import { useSharedWorkspace } from "@/context/shared-workspace";
import WorkspaceMembersDialog from "@/components/workspace/shared/WorkspaceMembersDialog";

const PERSONAL_VALUE = "__personal__";

/**
 * Chooses the space a new chat lives in. The server still independently
 * checks membership for every request; this only supplies the conversation
 * space that determines filing and its billing payer.
 */
export default function WorkspaceSwitcher({ idPrefix }: { idPrefix: string }) {
  const { workspaces, activeWorkspace, selectWorkspace } = useSharedWorkspace();
  const [membersOpen, setMembersOpen] = useState(false);

  return (
    <div className="shrink-0 px-3 pb-2">
      <label htmlFor={`${idPrefix}-shared-space`} className="sr-only">
        Chat space
      </label>
      <div className="relative">
        <select
          id={`${idPrefix}-shared-space`}
          data-testid={`select-shared-space-${idPrefix}`}
          value={activeWorkspace?.id ?? PERSONAL_VALUE}
          onChange={(event) =>
            selectWorkspace(
              event.target.value === PERSONAL_VALUE ? null : event.target.value,
            )
          }
          className="h-10 w-full appearance-none rounded-lg border border-sidebar-border bg-transparent px-3 pr-9 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          title={activeWorkspace ? activeWorkspace.name : "Personal space"}
        >
          <option value={PERSONAL_VALUE}>Personal space</option>
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