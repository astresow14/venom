import React, { useMemo, useRef, useState } from "react";
import { Modal, Platform, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useVenom } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

/**
 * Session housekeeping for the chat screen: the Sessions / New session pill
 * row and the past-sessions sheet. Owns the sheet's open state and the list
 * of reopenable sessions; the row hides itself when there is nothing to act
 * on. The RN Modal renders as an overlay, so hosting it here keeps the
 * focus-return wiring (sheet → Sessions pill) inside one component.
 */
export function SessionControls({
  colors,
  activeProject,
  onScreenProjectId,
  hasMessages,
  isStreaming,
}: {
  colors: ReturnType<typeof useColors>;
  activeProject: any;
  /** Project the screen is filing new sessions under. */
  onScreenProjectId: string | null;
  /** Whether the current session already holds messages. */
  hasMessages: boolean;
  isStreaming: boolean;
}) {
  const {
    state,
    setActiveConversation,
    setActiveProject,
    createNewConversation,
    fileConversationToProject,
  } = useVenom();

  const [isSessionSheetOpen, setIsSessionSheetOpen] = useState(false);
  const sessionsButtonRef = useRef<React.ComponentRef<
    typeof TouchableOpacity
  > | null>(null);

  // Every past session of the on-screen project, newest first. This list is
  // the guaranteed way back into a thread after starting a fresh one — it
  // depends only on workspace state, never on knowledge extraction having
  // produced Brain evidence for the exchange.
  const projectSessions = useMemo(
    () =>
      state.conversations
        .filter(
          (conversation) =>
            conversation.projectId === onScreenProjectId &&
            conversation.messages.length > 0,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations, onScreenProjectId],
  );
  const reopenableSessions = projectSessions.filter(
    (conversation) => conversation.id !== state.activeConversationId,
  );

  // Sessions stranded with no project (the old desktop behaviour, or a
  // restored/merged cloud snapshot) match no project's list above, so once
  // any project exists they would be reachable nowhere. This bucket is their
  // way back into view. It only exists while a project is on screen — with
  // no projects the list above already shows project-less sessions — and
  // only lists sessions that hold messages, since an empty stranded session
  // has no words to recover. Reopening one never adopts it into the open
  // project; filing (below) is the one explicit action that does.
  const unfiledSessions = useMemo(
    () =>
      onScreenProjectId === null
        ? []
        : state.conversations
            .filter(
              (conversation) =>
                conversation.projectId === null &&
                conversation.messages.length > 0,
            )
            .sort((a, b) => b.updatedAt - a.updatedAt),
    [state.conversations, onScreenProjectId],
  );

  // Closes the thread on screen by opening a clean session under the same
  // project. The previous session is never deleted: it stays in the workspace
  // and reopens from the sessions sheet below, so an unrelated question stops
  // dragging the earlier thread along as context.
  const handleStartNewSession = () => {
    if (isStreaming) return;
    const newId = createNewConversation(onScreenProjectId);
    setActiveConversation(newId);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleOpenSession = (
    conversationId: string,
    projectId: string | null,
  ) => {
    setIsSessionSheetOpen(false);
    if (conversationId === state.activeConversationId) return;
    // House rules from WorkspaceScreen.handleOpenConversation: line up the
    // project before the conversation so the workspace stays coherent.
    if (projectId !== state.activeProjectId) {
      setActiveProject(projectId);
    }
    setActiveConversation(conversationId);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // Reopening a project-less session shows its words again but never files
  // it: the project on screen stays selected, and the session stays out of
  // every project until it is filed explicitly.
  const handleOpenUnfiledSession = (conversationId: string) => {
    setIsSessionSheetOpen(false);
    if (conversationId === state.activeConversationId) return;
    setActiveConversation(conversationId);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // Filing gives the stranded session a home in the on-screen project. The
  // context write aligns the active project and conversation with the new
  // home, so closing the sheet lands on the filed thread.
  const handleFileUnfiledSession = (conversationId: string) => {
    if (onScreenProjectId === null) return;
    fileConversationToProject(conversationId, onScreenProjectId);
    setIsSessionSheetOpen(false);
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSessionSheetDismiss = () => {
    // Web: the closing modal's focus trap has released; hand focus back to
    // the control that opened the sheet so keyboard users are not stranded.
    sessionsButtonRef.current?.focus?.();
  };

  return (
    <>
      {/* Once the session holds messages it can be closed for a fresh one;
          an empty session is already fresh, so that action stays out of the
          way. The sessions pill appears whenever another session exists to
          come back to — including on an empty fresh session, which is
          exactly when the way back matters. Both disable mid-stream: the
          reply must land in the thread that asked for it before the screen
          moves elsewhere. Unfiled sessions count toward the pill too: a way
          back matters most when the stranded thread is the only one there
          is. */}
      {(hasMessages ||
        reopenableSessions.length > 0 ||
        unfiledSessions.length > 0) && (
        <View style={styles.newSessionRow}>
          {(reopenableSessions.length > 0 || unfiledSessions.length > 0) && (
            <TouchableOpacity
              ref={sessionsButtonRef}
              onPress={() => setIsSessionSheetOpen(true)}
              disabled={isStreaming}
              style={[
                styles.newSessionButton,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: isStreaming ? 0.5 : 1,
                },
              ]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: isStreaming }}
              accessibilityLabel={`Open past sessions in ${
                activeProject?.name ?? "this workspace"
              }`}
              testID="open-session-history"
            >
              <Feather name="clock" size={13} color={colors.foreground} />
              <Text
                style={[
                  styles.newSessionButtonText,
                  { color: colors.foreground },
                ]}
              >
                Sessions
              </Text>
            </TouchableOpacity>
          )}
          {hasMessages && (
            <TouchableOpacity
              onPress={handleStartNewSession}
              disabled={isStreaming}
              style={[
                styles.newSessionButton,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  opacity: isStreaming ? 0.5 : 1,
                },
              ]}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityState={{ disabled: isStreaming }}
              accessibilityLabel={`Start a new session in ${
                activeProject?.name ?? "this workspace"
              }. The current session stays available under Sessions.`}
              testID="start-new-session"
            >
              <Feather name="plus" size={13} color={colors.foreground} />
              <Text
                style={[
                  styles.newSessionButtonText,
                  { color: colors.foreground },
                ]}
              >
                New session
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      <Modal
        visible={isSessionSheetOpen}
        transparent
        // Same web dismissal rule as the board's card editor: an animated
        // close keeps the modal's focus trap mounted for the fade and
        // strands keyboard focus. Close immediately there instead.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleSessionSheetDismiss}
        onRequestClose={() => setIsSessionSheetOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View
            style={[
              styles.sessionSheet,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel="Project sessions"
            testID="session-history-sheet"
          >
            <View style={styles.sessionSheetHeader}>
              <View style={styles.sessionSheetHeading}>
                <Text
                  style={[
                    styles.sessionSheetTitle,
                    { color: colors.foreground },
                  ]}
                >
                  Sessions
                </Text>
                <Text
                  style={[
                    styles.sessionSheetSubtitle,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {activeProject?.name ?? "This workspace"}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.settingsIconButton}
                onPress={() => setIsSessionSheetOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close sessions"
                testID="close-session-history"
              >
                <Feather name="x" size={18} color={colors.foreground} />
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.sessionSheetList}
              keyboardShouldPersistTaps="handled"
            >
              {projectSessions.length === 0 ? (
                <Text
                  style={[
                    styles.sessionSheetEmpty,
                    { color: colors.mutedForeground },
                  ]}
                >
                  No sessions with messages yet.
                </Text>
              ) : (
                projectSessions.map((conversation) => {
                  const isCurrent =
                    conversation.id === state.activeConversationId;
                  return (
                    <TouchableOpacity
                      key={conversation.id}
                      style={[
                        styles.sessionRow,
                        { borderColor: colors.border },
                      ]}
                      onPress={() =>
                        handleOpenSession(
                          conversation.id,
                          conversation.projectId,
                        )
                      }
                      accessibilityRole="button"
                      accessibilityLabel={
                        isCurrent
                          ? `${conversation.title}, current session`
                          : `Open session ${conversation.title}`
                      }
                      testID={`session-history-item-${conversation.id}`}
                    >
                      <View style={styles.sessionRowText}>
                        <Text
                          style={[
                            styles.sessionRowTitle,
                            { color: colors.foreground },
                          ]}
                          numberOfLines={1}
                        >
                          {conversation.title}
                        </Text>
                        <Text
                          style={[
                            styles.sessionRowMeta,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {conversation.messages.length}{" "}
                          {conversation.messages.length === 1
                            ? "message"
                            : "messages"}
                        </Text>
                      </View>
                      {isCurrent && (
                        <Text
                          style={[
                            styles.sessionRowBadge,
                            {
                              color: colors.mutedForeground,
                              borderColor: colors.border,
                            },
                          ]}
                        >
                          Current
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })
              )}

              {unfiledSessions.length > 0 && (
                <View
                  style={styles.sessionSheetSection}
                  testID="session-unfiled-section"
                >
                  <Text
                    style={[
                      styles.sessionSheetSectionTitle,
                      { color: colors.foreground },
                    ]}
                  >
                    Unfiled
                  </Text>
                  <Text
                    style={[
                      styles.sessionSheetSectionHint,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Sessions saved without a project. Open one to read it, or
                    file it into {activeProject?.name ?? "this project"}.
                  </Text>
                  {unfiledSessions.map((conversation) => {
                    const isCurrent =
                      conversation.id === state.activeConversationId;
                    return (
                      <View
                        key={conversation.id}
                        style={[
                          styles.sessionRow,
                          { borderColor: colors.border },
                        ]}
                      >
                        <TouchableOpacity
                          style={styles.sessionRowText}
                          onPress={() =>
                            handleOpenUnfiledSession(conversation.id)
                          }
                          accessibilityRole="button"
                          accessibilityLabel={
                            isCurrent
                              ? `${conversation.title}, current session, not filed in any project`
                              : `Open unfiled session ${conversation.title}`
                          }
                          testID={`session-unfiled-item-${conversation.id}`}
                        >
                          <Text
                            style={[
                              styles.sessionRowTitle,
                              { color: colors.foreground },
                            ]}
                            numberOfLines={1}
                          >
                            {conversation.title}
                          </Text>
                          <Text
                            style={[
                              styles.sessionRowMeta,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            {conversation.messages.length}{" "}
                            {conversation.messages.length === 1
                              ? "message"
                              : "messages"}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[
                            styles.sessionFileButton,
                            { borderColor: colors.border },
                          ]}
                          onPress={() =>
                            handleFileUnfiledSession(conversation.id)
                          }
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`File session ${conversation.title} into ${
                            activeProject?.name ?? "this project"
                          }`}
                          testID={`file-unfiled-session-${conversation.id}`}
                        >
                          <Feather
                            name="folder-plus"
                            size={13}
                            color={colors.foreground}
                          />
                          <Text
                            style={[
                              styles.sessionFileButtonText,
                              { color: colors.foreground },
                            ]}
                          >
                            File
                          </Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}
