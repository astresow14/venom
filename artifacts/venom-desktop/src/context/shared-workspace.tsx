import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  getListSharedWorkspacesQueryKey,
  useListSharedWorkspaces,
  type SharedWorkspace,
} from "@workspace/api-client-react";
import { IS_UI_TEST, UI_TEST_USER_ID } from "@/context/venom-workspace";
import { asList } from "@/lib/as-list";
import { registerWorkspaceAccessLostHandler } from "@/lib/workspace-access";
import { useToast } from "@/hooks/use-toast";

/**
 * The shared workspaces this account belongs to. Memberships only — there is
 * no "active workspace" anymore: chatting needs no scope decision (knowledge
 * files itself by topic, see Task #281), and the Brain page carries its own
 * per-page filter for reading a workspace's knowledge.
 *
 * Shared-workspace content is served exclusively by membership-checked APIs,
 * and everything cached from them lives in react-query where `evict()` below
 * can remove it the moment the server says access is gone.
 */
type SharedWorkspaceContextValue = {
  workspaces: SharedWorkspace[];
  isLoading: boolean;
  /** Null means the personal tier. */
  activeWorkspace: SharedWorkspace | null;
  selectWorkspace: (workspaceId: string | null) => void;
};

const SharedWorkspaceContext =
  createContext<SharedWorkspaceContextValue | null>(null);

const storageKeyFor = (userId: string | null) =>
  `venom_shared_space:${userId ?? "anon"}`;

function readStoredSelection(userId: string | null): string | null {
  try {
    return window.localStorage.getItem(storageKeyFor(userId));
  } catch {
    return null;
  }
}

function writeStoredSelection(userId: string | null, workspaceId: string | null) {
  try {
    if (workspaceId) {
      window.localStorage.setItem(storageKeyFor(userId), workspaceId);
    } else {
      window.localStorage.removeItem(storageKeyFor(userId));
    }
  } catch {
    // Storage is optional; in-memory selection still works.
  }
}

export function SharedWorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  // Browser tests run without a Clerk session; reuse the placeholder account
  // so the shell renders (the workspace list request is stubbed there).
  const userId = user?.id ?? (IS_UI_TEST ? UI_TEST_USER_ID : null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    readStoredSelection(userId),
  );
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const listQuery = useListSharedWorkspaces({
    query: {
      // Key the cache by account so switching users cannot reuse another
      // account's workspace list.
      queryKey: [
        ...getListSharedWorkspacesQueryKey(),
        "account",
        userId ?? "signed-out",
      ],
      enabled: Boolean(userId),
      staleTime: 30_000,
    },
  });

  const workspaces = useMemo(() => asList(listQuery.data), [listQuery.data]);
  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      setSelectedId(workspaceId);
      writeStoredSelection(userId, workspaceId);
    },
    [userId],
  );

  useEffect(() => {
    if (!listQuery.isSuccess) return;
    if (selectedId && !workspaces.some((workspace) => workspace.id === selectedId)) {
      selectWorkspace(null);
    }
  }, [listQuery.isSuccess, selectedId, selectWorkspace, workspaces]);

  // Central revocation routine: any workspace-scoped request answered with
  // `workspace_access_denied` lands here (via the QueryClient error hooks or
  // the manual chat fetch). Evict every cached workspace read and refresh the
  // membership list — the personal store is untouched and keeps working.
  useEffect(() => {
    return registerWorkspaceAccessLostHandler(() => {
      queryClient.removeQueries({
        predicate: (query) => {
          const first = query.queryKey[0];
          return (
            typeof first === "string" &&
            first.startsWith("/api/venom/workspaces/")
          );
        },
      });
      void queryClient.invalidateQueries({
        queryKey: getListSharedWorkspacesQueryKey(),
      });
      if (selectedIdRef.current) selectWorkspace(null);
      toast({
        title: "Shared workspace unavailable",
        description: "You no longer have access to that workspace. Back in your personal space.",
      });
    });
  }, [queryClient, selectWorkspace, toast]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedId) ?? null,
    [selectedId, workspaces],
  );
  const value = useMemo<SharedWorkspaceContextValue>(
    () => ({
      workspaces,
      isLoading: listQuery.isLoading,
      activeWorkspace,
      selectWorkspace,
    }),
    [workspaces, listQuery.isLoading, activeWorkspace, selectWorkspace],
  );

  return (
    <SharedWorkspaceContext.Provider value={value}>
      {children}
    </SharedWorkspaceContext.Provider>
  );
}

export function useSharedWorkspace(): SharedWorkspaceContextValue {
  const context = useContext(SharedWorkspaceContext);
  if (!context) {
    throw new Error(
      "useSharedWorkspace must be used within a SharedWorkspaceProvider",
    );
  }
  return context;
}

export type { SharedWorkspace };
