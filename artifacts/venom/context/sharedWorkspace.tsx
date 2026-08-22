import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
  /** Null means the personal tier. */
  activeWorkspace: SharedWorkspace | null;
  selectWorkspace: (workspaceId: string | null) => void;
  /** Set when a workspace-scoped read was refused because access ended. */
  accessLostNotice: string | null;
  dismissAccessLostNotice: () => void;
};

const SharedWorkspaceContext =
  createContext<SharedWorkspaceContextValue | null>(null);

const storageKeyFor = (userId: string | null) =>
  `@venom_shared_space:${userId ?? "anon"}`;

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [accessLostNotice, setAccessLostNotice] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    let cancelled = false;
    setSelectedId(null);
    setHydratedFor(null);
    if (!userId) return;
    void AsyncStorage.getItem(storageKeyFor(userId)).then((stored) => {
      if (cancelled) return;
      setSelectedId(stored || null);
      setHydratedFor(userId);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

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
  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      setSelectedId(workspaceId);
      setAccessLostNotice(null);
      if (!userId) return;
      if (workspaceId) {
        void AsyncStorage.setItem(storageKeyFor(userId), workspaceId);
      } else {
        void AsyncStorage.removeItem(storageKeyFor(userId));
      }
    },
    [userId],
  );

  useEffect(() => {
    if (!listQuery.isSuccess || hydratedFor !== userId) return;
    if (selectedId && !workspaces.some((workspace) => workspace.id === selectedId)) {
      selectWorkspace(null);
    }
  }, [
    hydratedFor,
    listQuery.isSuccess,
    selectedId,
    selectWorkspace,
    userId,
    workspaces,
  ]);

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
      if (selectedIdRef.current) selectWorkspace(null);
      setAccessLostNotice(
        "You no longer have access to that shared workspace. Back in your personal space.",
      );
    });
  }, [queryClient, selectWorkspace]);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedId) ?? null,
    [selectedId, workspaces],
  );
  const dismissAccessLostNotice = useCallback(
    () => setAccessLostNotice(null),
    [],
  );

  const value = useMemo<SharedWorkspaceContextValue>(
    () => ({
      workspaces,
      isLoading: listQuery.isLoading,
      activeWorkspace,
      selectWorkspace,
      accessLostNotice,
      dismissAccessLostNotice,
    }),
    [
      workspaces,
      listQuery.isLoading,
      activeWorkspace,
      selectWorkspace,
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
