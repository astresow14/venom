import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/expo";
import {
  getListSharedWorkspacesQueryKey,
  useListSharedWorkspaces,
  type SharedWorkspace,
} from "@workspace/api-client-react";
import { IS_UI_TEST, UI_TEST_USER_ID } from "@/context/VenomContext";
import { registerWorkspaceAccessLostHandler } from "@/lib/workspaceAccess";

/**
 * The shared workspaces this account belongs to. Memberships only — there is
 * no "active workspace" anymore: chatting needs no scope decision (knowledge
 * files itself by topic), and the Brain screen carries its own per-screen
 * filter for reading a workspace's knowledge.
 *
 * Shared-workspace content is served exclusively by membership-checked APIs
 * and cached only in react-query, where the eviction below can remove it the
 * moment the server says access is gone.
 */
type SharedWorkspaceContextValue = {
  workspaces: SharedWorkspace[];
  isLoading: boolean;
  /** Set when a workspace-scoped read was refused because access ended. */
  accessLostNotice: string | null;
  dismissAccessLostNotice: () => void;
};

const SharedWorkspaceContext =
  createContext<SharedWorkspaceContextValue | null>(null);

export function SharedWorkspaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId: authUserId } = useAuth();
  // UI-test sessions have no Clerk user and no API token; the list query
  // stays disabled there and screens see an empty membership list.
  const userId = IS_UI_TEST ? UI_TEST_USER_ID : (authUserId ?? null);
  const queryClient = useQueryClient();
  const [accessLostNotice, setAccessLostNotice] = useState<string | null>(null);

  const listQuery = useListSharedWorkspaces({
    query: {
      // Key the cache by account so switching users cannot reuse another
      // account's workspace list.
      queryKey: [
        ...getListSharedWorkspacesQueryKey(),
        "account",
        userId ?? "signed-out",
      ],
      enabled: Boolean(userId) && !IS_UI_TEST,
      staleTime: 30_000,
    },
  });

  const workspaces = useMemo(
    () => (Array.isArray(listQuery.data) ? listQuery.data : []),
    [listQuery.data],
  );

  // Central revocation routine: any workspace-scoped request answered with
  // `workspace_access_denied` lands here. Evict every cached workspace read
  // and refresh the membership list — the personal store is untouched and
  // keeps working.
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
      setAccessLostNotice(
        "You no longer have access to that shared workspace.",
      );
    });
  }, [queryClient]);

  const dismissAccessLostNotice = useCallback(
    () => setAccessLostNotice(null),
    [],
  );

  const value = useMemo<SharedWorkspaceContextValue>(
    () => ({
      workspaces,
      isLoading: listQuery.isLoading,
      accessLostNotice,
      dismissAccessLostNotice,
    }),
    [
      workspaces,
      listQuery.isLoading,
      accessLostNotice,
      dismissAccessLostNotice,
    ],
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
