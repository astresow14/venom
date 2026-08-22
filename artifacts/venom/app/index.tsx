import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, PanResponder, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useFocusEffect, useRouter } from "expo-router";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getGetCommunityNotificationUnreadCountQueryKey, useGetCommunityNotificationUnreadCount } from "@workspace/api-client-react";
import { BoardWorkspace } from "@/components/board/BoardWorkspace";
import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { CommunityBriefing } from "@/components/community/CommunityBriefing";
import { CommunityNotifications } from "@/components/community/CommunityNotifications";
import { NotificationBadge } from "@/components/community/NotificationBadge";
import { KnowledgeWorkspace } from "@/components/knowledge/KnowledgeWorkspace";
import { WorkspaceErrorBoundary } from "@/components/WorkspaceErrorBoundary";
import { useTheme } from "@/context/ThemeContext";
import { useVenom } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { useUnsyncedIndicator } from "@/hooks/useUnsyncedIndicator";
import { claimFocusHandoff } from "@/lib/dialogFocusHandoff";

const WORKSPACE_TABS = ["Chat", "Feed", "Notifications", "Brain", "To-Do"] as const;

type WorkspaceTabHandle = {
  focus?: () => void;
  addEventListener?: (
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ) => void;
  removeEventListener?: (
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ) => void;
};

type WebKeyboardEvent = {
  key?: string;
  nativeEvent?: { key?: string };
  preventDefault?: () => void;
};

// --- Main Screen ---

export default function WorkspaceScreen() {
  const router = useRouter();
  const { userId: workspaceUserId } = useAuth();
  const colors = useColors();
  const { theme, toggleTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const {
    state,
    isReady,
    syncStatus,
    hasPendingLegacyImport,
    importDeviceWorkspace,
    startFreshWorkspace,
    setActiveConversation,
    setActiveProject,
  } = useVenom();
  // The header cloud icon used to mirror the raw sync status, which dropped
  // the cloud during every ordinary save's 'syncing' pass and during each
  // backoff retry. It now only falls to cloud-off once a failed save has sat
  // unresolved past the shared grace delay (useUnsyncedIndicator, same as the
  // chat and board notices), or when there is genuinely no cloud behind the
  // workspace (signed out, still loading, or a pending device import).
  const cloudLagged = useUnsyncedIndicator(syncStatus);
  const cloudDisconnected =
    cloudLagged ||
    syncStatus === "offline" ||
    syncStatus === "pending" ||
    syncStatus === "loading";

  const [activeIndex, setActiveIndex] = useState(0);
  const [focusedTabIndex, setFocusedTabIndex] = useState<number | null>(null);
  const tabRefs = useRef<Array<WorkspaceTabHandle | null>>([]);
  const projectSwitcherRef = useRef<{ focus?: () => void } | null>(null);
  const [projectSwitcherFocused, setProjectSwitcherFocused] = useState(false);
  const { data: notificationCount } =
    useGetCommunityNotificationUnreadCount({
      query: {
        queryKey: [
          ...getGetCommunityNotificationUnreadCountQueryKey(),
          "account",
          workspaceUserId ?? "ui-test",
        ],
        refetchInterval: 15000,
      },
    });
  const unreadNotificationCount = notificationCount?.count ?? 0;
  const activeProject =
    state.projects.find((p) => p.id === state.activeProjectId) ||
    state.projects[0];
  // One unified to-do board: every project's board is a chip away, whether
  // the project is personal or shared with a company. Scope stopped being a
  // navigation choice when the workspace switcher left the app — knowledge
  // sorts itself at filing time and the Brain screen carries the filter.
  const todoScopeProjects = state.projects;
  const [todoProjectOverrideId, setTodoProjectOverrideId] = useState<
    string | null
  >(null);
  const todoProject =
    todoScopeProjects.find((project) => project.id === todoProjectOverrideId) ??
    todoScopeProjects.find((project) => project.id === state.activeProjectId) ??
    todoScopeProjects[0] ??
    null;
  const showTodoScopeBar =
    todoScopeProjects.length > 1 || todoProject?.id !== activeProject?.id;

  // Creating a project closes its dialog by popping straight back to this
  // screen, so that dialog cannot hand keyboard focus anywhere itself — its
  // whole screen unmounts (see projects.tsx). It records the intent instead,
  // and this claims it once the workspace is back on screen, landing focus on
  // the switcher that now names the project the user just created.
  useFocusEffect(
    useCallback(() => {
      if (!claimFocusHandoff("project-switcher")) return;
      const frame = requestAnimationFrame(() => {
        projectSwitcherRef.current?.focus?.();
      });
      return () => cancelAnimationFrame(frame);
    }, []),
  );

  const handleTabPress = useCallback((index: number) => {
    setActiveIndex(index);
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
  }, []);

  const focusTab = useCallback((index: number) => {
    tabRefs.current[index]?.focus?.();
  }, []);

  const handleTabKeyDown = useCallback(
    (event: WebKeyboardEvent, index: number) => {
      const key = event.nativeEvent?.key ?? event.key;
      let nextIndex: number | null = null;

      if (key === "ArrowRight") {
        nextIndex = (index + 1) % WORKSPACE_TABS.length;
      } else if (key === "ArrowLeft") {
        nextIndex =
          (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length;
      } else if (key === "Home") {
        nextIndex = 0;
      } else if (key === "End") {
        nextIndex = WORKSPACE_TABS.length - 1;
      } else if (key === "Enter" || key === " ") {
        event.preventDefault?.();
        handleTabPress(index);
        return;
      } else {
        return;
      }

      event.preventDefault?.();
      focusTab(nextIndex);
    },
    [focusTab, handleTabPress],
  );

  useEffect(() => {
    if (Platform.OS !== "web" || !isReady || hasPendingLegacyImport) {
      return;
    }

    const listeners = tabRefs.current.map((element, index) => {
      const listener = (event: WebKeyboardEvent) =>
        handleTabKeyDown(event, index);
      element?.addEventListener?.("keydown", listener);
      return { element, listener };
    });

    return () => {
      listeners.forEach(({ element, listener }) => {
        element?.removeEventListener?.("keydown", listener);
      });
    };
  }, [handleTabKeyDown, hasPendingLegacyImport, isReady]);

  const workspaceSwipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          activeIndex !== 3 &&
          activeIndex !== 4 &&
          Math.abs(gestureState.dx) > 18 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5,
        onPanResponderRelease: (_, gestureState) => {
          if (
            gestureState.dx < -70 &&
            activeIndex < WORKSPACE_TABS.length - 1
          ) {
            handleTabPress(activeIndex + 1);
          } else if (gestureState.dx > 70 && activeIndex > 0) {
            handleTabPress(activeIndex - 1);
          }
        },
      }),
    [activeIndex, handleTabPress],
  );

  const handleOpenConversation = (conversationId: string) => {
    const conversation = state.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) return;

    setActiveProject(conversation.projectId);
    setActiveConversation(conversation.id);
    handleTabPress(0);
  };

  if (!isReady) {
    return (
      <View
        style={[
          styles.restoreContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <ActivityIndicator size="small" color={colors.primary} />
        <Text
          style={[styles.restoreText, { color: colors.mutedForeground }]}
        >
          Restoring workspace
        </Text>
      </View>
    );
  }

  if (hasPendingLegacyImport) {
    return (
      <View
        style={[
          styles.migrationContainer,
          { backgroundColor: colors.background },
        ]}
      >
        <View
          style={[
            styles.migrationCard,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <View
            style={[
              styles.migrationIcon,
              { backgroundColor: colors.secondary },
            ]}
          >
            <Feather name="hard-drive" size={22} color={colors.primary} />
          </View>
          <Text
            style={[styles.migrationTitle, { color: colors.foreground }]}
          >
            Workspace found on this device
          </Text>
          <Text
            style={[
              styles.migrationDescription,
              { color: colors.mutedForeground },
            ]}
          >
            Choose whether to securely attach the existing local workspace to
            this account. Nothing is uploaded until you confirm.
          </Text>
          <TouchableOpacity
            testID="import-device-workspace"
            style={[
              styles.migrationPrimary,
              { backgroundColor: colors.primary },
            ]}
            activeOpacity={0.78}
            onPress={importDeviceWorkspace}
          >
            <Text
              style={[
                styles.migrationPrimaryText,
                { color: colors.primaryForeground },
              ]}
            >
              Keep and sync
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="start-fresh-workspace"
            style={[
              styles.migrationSecondary,
              { borderColor: colors.border },
            ]}
            activeOpacity={0.7}
            onPress={startFreshWorkspace}
          >
            <Text
              style={[
                styles.migrationSecondaryText,
                { color: colors.mutedForeground },
              ]}
            >
              Start fresh instead
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Custom Header Nav */}
      <View
        style={[
          styles.topNav,
          {
            paddingTop: Math.max(insets.top, Platform.OS === "web" ? 67 : 16),
            backgroundColor: colors.background,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.navTabsScroll}
          contentContainerStyle={styles.navTabs}
          accessibilityRole="tablist"
        >
          {WORKSPACE_TABS.map((title, i) => {
            const isActive = activeIndex === i;
            const isFocused = focusedTabIndex === i;
            return (
              <TouchableOpacity
                key={title}
                ref={(element) => {
                  tabRefs.current[i] =
                    element as unknown as WorkspaceTabHandle | null;
                }}
                onPress={() => handleTabPress(i)}
                onFocus={() => setFocusedTabIndex(i)}
                onBlur={() =>
                  setFocusedTabIndex((currentIndex) =>
                    currentIndex === i ? null : currentIndex,
                  )
                }
                style={[
                  styles.navTab,
                  isFocused && [
                    styles.navTabFocused,
                    { outlineColor: colors.foreground },
                  ],
                ]}
                hitSlop={10}
                testID={`workspace-tab-${title.toLowerCase().replace("-", "")}`}
                accessibilityRole="tab"
                accessibilityLabel={
                  title === "Notifications" && unreadNotificationCount > 0
                    ? `Open Notifications workspace, ${unreadNotificationCount} unread`
                    : `Open ${title} workspace`
                }
                accessibilityState={{ selected: isActive }}
                aria-selected={isActive}
                {...(Platform.OS === "web"
                  ? {
                      tabIndex:
                        focusedTabIndex === null
                          ? isActive
                            ? 0
                            : -1
                          : isFocused
                            ? 0
                            : -1,
                    }
                  : {})}
              >
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text
                    style={[
                      styles.navTabText,
                      {
                        color: isActive
                          ? colors.foreground
                          : colors.mutedForeground,
                        fontFamily: isActive
                          ? "Inter_600SemiBold"
                          : "Inter_500Medium",
                      },
                    ]}
                  >
                    {title}
                  </Text>
                  {title === "Notifications" && (
                    <NotificationBadge count={unreadNotificationCount} />
                  )}
                </View>
                {isActive && (
                  <View
                    style={[
                      styles.navTabActiveLine,
                      { backgroundColor: colors.primary },
                    ]}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <View style={styles.navActions}>
          <TouchableOpacity
            onPress={() => router.push("/sops" as never)}
            style={styles.navIconButton}
            testID="open-sops"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open procedures library"
          >
            <Feather name="file-text" size={17} color={colors.foreground} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={toggleTheme}
            style={styles.themeButton}
            accessibilityRole="switch"
            accessibilityLabel={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
            accessibilityState={{ checked: theme === "dark" }}
            testID="theme-toggle"
            hitSlop={8}
          >
            <Feather
              name={theme === "light" ? "moon" : "sun"}
              size={17}
              color={colors.foreground}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => router.push("/settings")}
            style={styles.navIconButton}
            testID="open-settings"
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              syncStatus === "synced"
                ? "Open settings. Workspace synced."
                : `Open settings. Workspace sync status: ${syncStatus.replace("_", " ")}.`
            }
          >
            <Feather
              name={cloudDisconnected ? "cloud-off" : "cloud"}
              size={17}
              color={
                syncStatus === "synced"
                  ? colors.primary
                  : colors.mutedForeground
              }
            />
          </TouchableOpacity>
          <TouchableOpacity
            ref={(node: { focus?: () => void } | null) => {
              projectSwitcherRef.current = node;
            }}
            style={[
              styles.navProject,
              {
                borderColor: projectSwitcherFocused
                  ? colors.primary
                  : "transparent",
              },
            ]}
            activeOpacity={0.7}
            onPress={() => router.push("/projects")}
            onFocus={() => setProjectSwitcherFocused(true)}
            onBlur={() => setProjectSwitcherFocused(false)}
            testID="open-projects"
            accessibilityRole="button"
            accessibilityLabel={`Open projects. Current project: ${activeProject?.name || "Workspace"}.`}
          >
            <Text
              style={[styles.navProjectText, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {activeProject?.name || "Workspace"}
            </Text>
            <Feather
              name="chevron-down"
              size={14}
              color={colors.mutedForeground}
            />
          </TouchableOpacity>
        </View>
      </View>

      <View
        style={styles.workspacePager}
        {...workspaceSwipeResponder.panHandlers}
      >
        {/* Every page below stays mounted from startup, so each one gets its
            own error boundary: a render/effect throw in one surface degrades
            that surface alone instead of unwinding to the root boundary and
            blanking the whole app (tab bar included). */}
        <View
          testID="workspace-chat"
          style={[
            styles.workspacePage,
            activeIndex !== 0 && styles.workspacePageHidden,
          ]}
        >
          <WorkspaceErrorBoundary surface="chat" title="Chat">
            <ChatWorkspace
              isActive={activeIndex === 0}
              activeProject={activeProject}
            />
          </WorkspaceErrorBoundary>
        </View>
        <View
          testID="workspace-feed"
          style={[
            styles.workspacePage,
            activeIndex !== 1 && styles.workspacePageHidden,
          ]}
        >
          <WorkspaceErrorBoundary surface="feed" title="Feed">
            <CommunityBriefing isActive={activeIndex === 1} />
          </WorkspaceErrorBoundary>
        </View>
        <View
          testID="workspace-notifications"
          style={[
            styles.workspacePage,
            activeIndex !== 2 && styles.workspacePageHidden,
          ]}
        >
          <WorkspaceErrorBoundary surface="notifications" title="Notifications">
            <CommunityNotifications isActive={activeIndex === 2} />
          </WorkspaceErrorBoundary>
        </View>
        <View
          testID="workspace-brain"
          style={[
            styles.workspacePage,
            activeIndex !== 3 && styles.workspacePageHidden,
          ]}
        >
          <WorkspaceErrorBoundary surface="brain" title="Brain">
            <KnowledgeWorkspace
              isActive={activeIndex === 3}
              onOpenConversation={handleOpenConversation}
            />
          </WorkspaceErrorBoundary>
        </View>
        <View
          testID="workspace-todo"
          style={[
            styles.workspacePage,
            activeIndex !== 4 && styles.workspacePageHidden,
          ]}
        >
          <WorkspaceErrorBoundary surface="todo" title="To-Do">
            {showTodoScopeBar && (
              <View
                style={[
                  styles.todoScopeBar,
                  { borderBottomColor: colors.border },
                ]}
                testID="todo-scope-bar"
              >
                <Text
                  style={[
                    styles.todoScopeLabel,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  Projects
                </Text>
                {todoScopeProjects.length > 1 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.todoScopeChips}
                  >
                    {todoScopeProjects.map((project) => {
                      const selected = project.id === todoProject?.id;
                      return (
                        <TouchableOpacity
                          key={project.id}
                          onPress={() => setTodoProjectOverrideId(project.id)}
                          style={[
                            styles.todoScopeChip,
                            {
                              borderColor: selected
                                ? colors.foreground
                                : colors.border,
                              backgroundColor: selected
                                ? colors.foreground
                                : "transparent",
                            },
                          ]}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`Show to-dos from ${project.name}`}
                          testID={`todo-scope-project-${project.id}`}
                        >
                          <Text
                            style={[
                              styles.todoScopeChipText,
                              {
                                color: selected
                                  ? colors.background
                                  : colors.foreground,
                              },
                            ]}
                            numberOfLines={1}
                          >
                            {project.name}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
            )}
            {todoProject ? (
              <BoardWorkspace activeProject={todoProject} />
            ) : (
              <View style={styles.todoScopeEmpty} testID="todo-scope-empty">
                <Feather
                  name="clipboard"
                  size={18}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.todoScopeEmptyText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  No projects yet. Create one from the project switcher to
                  start a list.
                </Text>
              </View>
            )}
          </WorkspaceErrorBoundary>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  restoreContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  restoreText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  todoScopeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  todoScopeLabel: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textTransform: "uppercase",
    letterSpacing: 1,
    maxWidth: 120,
  },
  todoScopeChips: {
    flexDirection: "row",
    gap: 8,
    paddingRight: 16,
  },
  todoScopeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    maxWidth: 160,
  },
  todoScopeChipText: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
  },
  todoScopeEmpty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 32,
  },
  todoScopeEmptyText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
    lineHeight: 19,
  },
  migrationContainer: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  migrationCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
  },
  migrationIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 22,
  },
  migrationTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    letterSpacing: -0.5,
  },
  migrationDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
    marginBottom: 24,
  },
  migrationPrimary: {
    minHeight: 50,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
  },
  migrationPrimaryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  migrationSecondary: {
    minHeight: 50,
    borderWidth: 1,
    borderRadius: 25,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 12,
  },
  migrationSecondaryText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  topNav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 0,
    borderBottomWidth: 1,
    zIndex: 10,
  },
  navTabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingRight: 8,
  },
  navTabsScroll: {
    flexShrink: 1,
  },
  navTab: {
    paddingVertical: 12,
    position: "relative",
    borderRadius: 6,
  },
  navTabFocused: {
    backgroundColor: "rgba(128, 128, 128, 0.2)",
    outlineStyle: "solid",
    outlineWidth: 2,
    outlineOffset: 2,
  },
  navTabText: {
    fontSize: 15,
  },
  navTabActiveLine: {
    position: "absolute",
    bottom: -1,
    left: 0,
    right: 0,
    height: 2,
    borderRadius: 1,
  },
  navProject: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    marginLeft: 4,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  navActions: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    marginLeft: 8,
  },
  themeButton: {
    width: 30,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navIconButton: {
    width: 30,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  navProjectText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
  },
  workspacePager: {
    flex: 1,
    width: "100%",
  },
  workspacePage: {
    flex: 1,
    width: "100%",
  },
  workspacePageHidden: {
    display: "none",
  },
});
