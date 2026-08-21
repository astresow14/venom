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
 * Which tier the app is looking at: the personal workspace (null) or one of
 * the shared workspaces the account belongs to.
 *
 * The selection is device-local state persisted only to AsyncStorage — it
 * must never enter the synced workspace snapshot. Shared-workspace content is
 * served exclusively by membership-checked APIs and cached only in
 * react-query, where `evict()` below can remove it the moment the server says
 * access is gone.
 */
type SharedWorkspaceContextValue = {
  workspaces: SharedWorkspace[];
  isLoading: boolean;
  /** Null means the personal tier. */
  activeWorkspace: SharedWorkspace | null;
  selectWorkspace: (workspaceId: string | null) => void;
  /** Set when access was revoked while a workspace was selected. */
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
  // stays disabled there and the app remains in the personal tier.
  const userId = IS_UI_TEST ? UI_TEST_USER_ID : (authUserId ?? null);
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const [accessLostNotice, setAccessLostNotice] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Restore the device-local selection for this account.
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

  // The server's member list is the truth: if the stored selection is not in
  // a freshly loaded list (removed while this device was away, or workspace
  // deleted), quietly fall back to the personal tier.
  useEffect(() => {
    if (!listQuery.isSuccess || hydratedFor !== userId) return;
    if (selectedId && !workspaces.some((w) => w.id === selectedId)) {
      selectWorkspace(null);
    }
  }, [
    listQuery.isSuccess,
    workspaces,
    selectedId,
    selectWorkspace,
    hydratedFor,
    userId,
  ]);

  // Central revocation routine: any workspace-scoped request answered with
  // `workspace_access_denied` lands here. Evict every cached workspace read
  // and return to the personal tier — the personal store is untouched.
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
      if (selectedIdRef.current) {
        setSelectedId(null);
        setAccessLostNotice(
          "You no longer have access to that shared workspace. Back in your personal space.",
        );
        if (userId) {
          void AsyncStorage.removeItem(storageKeyFor(userId));
        }
      }
    });
  }, [queryClient, userId]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedId) ?? null,
    [workspaces, selectedId],
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
