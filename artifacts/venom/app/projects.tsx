import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Modal,
  Platform,
  Pressable,
  Animated as RNAnimated,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useReducedMotion } from "react-native-reanimated";

import { useColors } from "@/hooks/useColors";
import { useVenom, type Project } from "@/context/VenomContext";
import { Header } from "@/components/Header";
import { requestFocusHandoff } from "@/lib/dialogFocusHandoff";

// The dialog card must both swallow backdrop taps (Pressable) and animate its
// own entrance (Animated) on the same element, because the modal container no
// longer animates on web.
const AnimatedPressable = RNAnimated.createAnimatedComponent(Pressable);

type FocusableHandle = {
  focus?: () => void;
};

// Where keyboard focus should land once a dialog has fully dismissed. The
// create dialog hands back to its opener; the delete dialog hands back to the
// delete control on cancel, or to a surviving project card after a deletion.
type DismissFocusTarget =
  | { kind: "create-button" }
  | { kind: "delete-button"; projectId: string }
  | { kind: "project-card"; projectId: string | null };

export default function ProjectsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    state,
    setActiveProject,
    addProject,
    deleteProject,
    pendingProjectRestore,
    restoreDeletedProject,
  } = useVenom();

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createButtonFocused, setCreateButtonFocused] = useState(false);
  // Deleting is destructive and propagates to every synced device, so the
  // delete control never acts on one tap: it stages the project here and the
  // dialog's own destructive action performs the actual deletion. The name is
  // snapshotted so the dialog stays coherent even if a sync merge rewrites
  // the project list while it is open.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const [focusedDeleteId, setFocusedDeleteId] = useState<string | null>(null);
  const [cancelDeleteFocused, setCancelDeleteFocused] = useState(false);
  const [confirmDeleteFocused, setConfirmDeleteFocused] = useState(false);
  const [undoFocused, setUndoFocused] = useState(false);
  const reduceMotion = useReducedMotion();
  const dialogAppear = useRef(new RNAnimated.Value(0)).current;
  const undoAppear = useRef(new RNAnimated.Value(0)).current;
  const createButtonRef = useRef<FocusableHandle | null>(null);
  const cancelDeleteRef = useRef<FocusableHandle | null>(null);
  const cardRefs = useRef<Map<string, FocusableHandle>>(new Map());
  const deleteButtonRefs = useRef<Map<string, FocusableHandle>>(new Map());
  const dismissFocusRef = useRef<DismissFocusTarget | null>(null);
  const projectAccents = [
    colors.foreground,
    colors.mutedForeground,
    colors.border,
    colors.secondaryForeground,
  ];

  const chooseProject = (projectId: string) => {
    setActiveProject(projectId);
    router.back();
  };

  // Only one dialog is ever open at a time, so they share one appearance
  // value. The dialog animates its own card because the modal container must
  // not animate on web: an animated modal keeps its focus trap alive while it
  // fades out and strands keyboard focus (see the card editor in
  // BoardWorkspace for the shared pattern).
  const dialogOpen = isCreating || pendingDelete !== null;
  useEffect(() => {
    if (!dialogOpen) return;
    dialogAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(dialogAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [dialogAppear, dialogOpen, reduceMotion]);

  // The undo bar animates in like the dialogs do, re-firing when a second
  // delete replaces the pending restore (new key) so the fresh name gets the
  // same entrance. It vanishes on its own when the restore window closes —
  // the context clears the pending entry and the bar unmounts with it.
  const undoRestoreKey = pendingProjectRestore?.key ?? null;
  useEffect(() => {
    if (!undoRestoreKey) return;
    undoAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(undoAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [undoAppear, undoRestoreKey, reduceMotion]);

  // The delete dialog holds no input to autoFocus, so focus is placed
  // explicitly on the safe action once the modal is mounted; without this,
  // keyboard focus would stay behind the open dialog.
  useEffect(() => {
    if (!pendingDelete) return;
    const frame = requestAnimationFrame(() => {
      cancelDeleteRef.current?.focus?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingDelete]);

  const registerFocusHandle =
    (registry: Map<string, FocusableHandle>, id: string) =>
    (node: FocusableHandle | null) => {
      if (node) registry.set(id, node);
      else registry.delete(id);
    };

  const openCreateDialog = () => {
    dismissFocusRef.current = null;
    setIsCreating(true);
  };

  // Cancel-style closes stay on this screen: hand focus back to the button
  // that opened the dialog.
  const cancelCreateDialog = () => {
    dismissFocusRef.current = { kind: "create-button" };
    setIsCreating(false);
  };

  const requestDeleteProject = (project: Project) => {
    dismissFocusRef.current = null;
    setPendingDelete({ id: project.id, name: project.name });
  };

  const cancelDeleteProject = () => {
    // The project is untouched, so its delete control still exists: hand
    // focus straight back to it.
    if (pendingDelete) {
      dismissFocusRef.current = {
        kind: "delete-button",
        projectId: pendingDelete.id,
      };
    }
    setPendingDelete(null);
  };

  const confirmDeleteProject = () => {
    if (!pendingDelete) return;
    // Confirming unmounts the card that opened this dialog, so the focus
    // destination must be computed from pre-deletion state: the next card in
    // the rendered order, else the previous one. When neither exists (the
    // last project was deleted) the target stays null and dismissal falls
    // back to whatever card the fallback workspace mounted.
    const ordered = [...state.projects].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const index = ordered.findIndex(
      (project) => project.id === pendingDelete.id,
    );
    const neighbor =
      index >= 0 ? (ordered[index + 1] ?? ordered[index - 1]) : undefined;
    dismissFocusRef.current = {
      kind: "project-card",
      projectId: neighbor?.id ?? null,
    };
    deleteProject(pendingDelete.id);
    setPendingDelete(null);
  };

  const undoProjectDelete = () => {
    // Restoring rebuilds the project under fresh ids and makes it active;
    // the bar unmounts with the pending restore, so keyboard focus is handed
    // to the always-present create control instead of vanishing with the
    // button (the same predictable-landing rule the dialogs follow).
    restoreDeletedProject();
    requestAnimationFrame(() => {
      createButtonRef.current?.focus?.();
    });
  };

  // Fires once the modal is actually gone (immediately on web) and its focus
  // trap has released, so an explicit focus target sticks.
  const handleDialogDismiss = () => {
    const target = dismissFocusRef.current;
    dismissFocusRef.current = null;
    if (!target) return;
    if (target.kind === "create-button") {
      createButtonRef.current?.focus?.();
      return;
    }
    if (target.kind === "delete-button") {
      deleteButtonRefs.current.get(target.projectId)?.focus?.();
      return;
    }
    const preferred = target.projectId
      ? cardRefs.current.get(target.projectId)
      : undefined;
    if (preferred?.focus) {
      preferred.focus();
      return;
    }
    // The chosen neighbor may not exist (deleting the last project replaces
    // it with a fresh fallback workspace, mounted by dismissal time): focus
    // the top card on screen now, or the create button on an empty list.
    const topCard = [...state.projects]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((project) => cardRefs.current.get(project.id))
      .find((handle) => handle?.focus);
    (topCard ?? createButtonRef.current)?.focus?.();
  };

  const createProject = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const projectId = addProject({
      name: trimmedName,
      description: description.trim() || "Project workspace",
      accent: projectAccents[state.projects.length % projectAccents.length],
      sourceCount: 0,
    });
    setActiveProject(projectId);
    setName("");
    setDescription("");
    dismissFocusRef.current = null;
    // Creating leaves this screen entirely, so no local control can take
    // focus. The workspace header claims this request for its project
    // switcher once the navigation lands.
    requestFocusHandoff("project-switcher");
    setIsCreating(false);
    router.back();
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Header
        title="Projects"
        showBack
        rightIcon="grid"
        rightAccessibilityLabel="Open app portfolio"
        onRightPress={() => router.push("/apps" as never)}
      />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 40 },
        ]}
      >
        <View style={styles.heading}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
              Your workspaces
            </Text>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Choose where you work
            </Text>
          </View>
          <TouchableOpacity
            ref={(node: FocusableHandle | null) => {
              createButtonRef.current = node;
            }}
            accessibilityRole="button"
            accessibilityLabel="Create project"
            onPress={openCreateDialog}
            onFocus={() => setCreateButtonFocused(true)}
            onBlur={() => setCreateButtonFocused(false)}
            style={[
              styles.createButton,
              { backgroundColor: colors.foreground },
              createButtonFocused && {
                borderWidth: 2,
                borderColor: colors.background,
              },
            ]}
            testID="create-project"
          >
            <Feather name="plus" color={colors.background} size={18} />
          </TouchableOpacity>
        </View>

        <View style={styles.list}>
          {[...state.projects]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((project: Project) => {
              const selected = project.id === state.activeProjectId;
              return (
                <TouchableOpacity
                  key={project.id}
                  ref={registerFocusHandle(cardRefs.current, project.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  accessibilityLabel={`Switch to ${project.name}`}
                  onPress={() => chooseProject(project.id)}
                  onFocus={() => setFocusedProjectId(project.id)}
                  onBlur={() =>
                    setFocusedProjectId((current) =>
                      current === project.id ? null : current,
                    )
                  }
                  style={[
                    styles.projectCard,
                    {
                      backgroundColor: selected
                        ? colors.foreground
                        : colors.card,
                      borderColor: selected ? colors.foreground : colors.border,
                    },
                    // Cards receive focus after a deletion, so the ring must
                    // be visible on both fills: background-colored on the
                    // foreground-filled selected card, stark on the rest.
                    focusedProjectId === project.id && {
                      borderWidth: 2,
                      borderColor: selected
                        ? colors.background
                        : colors.foreground,
                    },
                  ]}
                  testID={`select-project-${project.id}`}
                >
                  <View
                    style={[
                      styles.projectMark,
                      {
                        backgroundColor: selected
                          ? colors.background
                          : project.accent,
                      },
                    ]}
                  />
                  <View style={styles.projectCopy}>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.projectName,
                        {
                          color: selected
                            ? colors.background
                            : colors.foreground,
                        },
                      ]}
                    >
                      {project.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.projectDescription,
                        {
                          color: selected
                            ? colors.background
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {project.description}
                    </Text>
                  </View>
                  <View style={styles.projectMeta}>
                    <Text
                      style={[
                        styles.metaText,
                        {
                          color: selected
                            ? colors.background
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {state.sources.filter(
                        (s) => s.projectId === project.id,
                      ).length}{" "}
                      sources
                    </Text>
                    <View style={styles.metaActions}>
                      {selected ? (
                        <Feather
                          name="check"
                          color={colors.background}
                          size={17}
                        />
                      ) : null}
                      <TouchableOpacity
                        ref={registerFocusHandle(
                          deleteButtonRefs.current,
                          project.id,
                        )}
                        onPress={() => requestDeleteProject(project)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${project.name}`}
                        onFocus={() => setFocusedDeleteId(project.id)}
                        onBlur={() =>
                          setFocusedDeleteId((current) =>
                            current === project.id ? null : current,
                          )
                        }
                        style={[
                          styles.deleteButton,
                          focusedDeleteId === project.id && {
                            borderWidth: 2,
                            borderRadius: 22,
                            borderColor: selected
                              ? colors.background
                              : colors.destructive,
                          },
                        ]}
                        hitSlop={12}
                        testID={`delete-project-${project.id}`}
                      >
                        <Feather
                          name="trash-2"
                          size={15}
                          color={
                            selected ? colors.background : colors.destructive
                          }
                          style={{ opacity: 0.7 }}
                        />
                      </TouchableOpacity>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
        </View>
      </ScrollView>

      <Modal
        transparent
        visible={isCreating}
        // On web an animated dismissal keeps the dialog (and its focus trap)
        // mounted for the length of the fade, which pulls keyboard focus back
        // into the closing dialog. Close immediately there instead; the card
        // below animates its own entrance.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleDialogDismiss}
        onRequestClose={cancelCreateDialog}
      >
        <Pressable onPress={cancelCreateDialog} style={styles.modalBackdrop}>
          <AnimatedPressable
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.modalCard,
              { backgroundColor: colors.card },
              {
                opacity: dialogAppear,
                transform: [
                  {
                    translateY: dialogAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
            accessibilityViewIsModal
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              New project
            </Text>
            <TextInput
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="Project name"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  color: colors.foreground,
                  backgroundColor: colors.background,
                },
              ]}
              testID="new-project-name"
            />
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="What is this project about? (optional)"
              placeholderTextColor={colors.mutedForeground}
              style={[
                styles.input,
                styles.descriptionInput,
                {
                  borderColor: colors.border,
                  color: colors.foreground,
                  backgroundColor: colors.background,
                },
              ]}
              multiline
              testID="new-project-description"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={cancelCreateDialog}
              >
                <Text
                  style={[styles.cancel, { color: colors.mutedForeground }]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                disabled={!name.trim()}
                onPress={createProject}
                style={[
                  styles.saveButton,
                  {
                    backgroundColor: name.trim()
                      ? colors.foreground
                      : colors.secondary,
                  },
                ]}
                testID="save-project"
              >
                <Text
                  style={[styles.saveText, { color: colors.background }]}
                >
                  Create
                </Text>
              </TouchableOpacity>
            </View>
          </AnimatedPressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        visible={pendingDelete !== null}
        // Same web caveat as the create dialog: an animated dismissal keeps
        // the focus trap mounted and yanks focus back into the closing
        // dialog, so it closes immediately there.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleDialogDismiss}
        onRequestClose={cancelDeleteProject}
      >
        <Pressable onPress={cancelDeleteProject} style={styles.modalBackdrop}>
          <AnimatedPressable
            onPress={(event) => event.stopPropagation()}
            style={[
              styles.modalCard,
              { backgroundColor: colors.card },
              {
                opacity: dialogAppear,
                transform: [
                  {
                    translateY: dialogAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
            accessibilityViewIsModal
            role="alertdialog"
            accessibilityLabel={
              pendingDelete ? `Delete ${pendingDelete.name}?` : undefined
            }
            testID="delete-project-dialog"
          >
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Delete {pendingDelete?.name}?
            </Text>
            <Text
              style={[styles.confirmBody, { color: colors.mutedForeground }]}
            >
              Its chats, sources, board tasks, and archived evidence are
              removed from every synced device. You will have a few seconds
              to undo.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                ref={(node: FocusableHandle | null) => {
                  cancelDeleteRef.current = node;
                }}
                accessibilityRole="button"
                onPress={cancelDeleteProject}
                onFocus={() => setCancelDeleteFocused(true)}
                onBlur={() => setCancelDeleteFocused(false)}
                style={[
                  styles.dialogTextButton,
                  cancelDeleteFocused && { borderColor: colors.foreground },
                ]}
                testID="cancel-delete-project"
              >
                <Text
                  style={[styles.cancel, { color: colors.mutedForeground }]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={confirmDeleteProject}
                onFocus={() => setConfirmDeleteFocused(true)}
                onBlur={() => setConfirmDeleteFocused(false)}
                style={[
                  styles.destructiveButton,
                  { backgroundColor: colors.destructive },
                  // A primary-colored ring is invisible on a filled control;
                  // the background-colored inset ring stays visible on the
                  // destructive fill in both themes.
                  confirmDeleteFocused && { borderColor: colors.background },
                ]}
                testID="confirm-delete-project"
              >
                <Text
                  style={[
                    styles.destructiveText,
                    { color: colors.destructiveForeground },
                  ]}
                >
                  Delete project
                </Text>
              </TouchableOpacity>
            </View>
          </AnimatedPressable>
        </Pressable>
      </Modal>

      {pendingProjectRestore && (
        <RNAnimated.View
          style={[
            styles.undoBar,
            {
              backgroundColor: colors.foreground,
              bottom: insets.bottom + 16,
              opacity: undoAppear,
              transform: [
                {
                  translateY: undoAppear.interpolate({
                    inputRange: [0, 1],
                    outputRange: [12, 0],
                  }),
                },
              ],
            },
          ]}
          accessibilityLiveRegion="polite"
          testID="banner-undo-delete-project"
        >
          <Text
            style={[styles.undoText, { color: colors.background }]}
            numberOfLines={1}
          >
            “{pendingProjectRestore.projectName}” deleted
          </Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Undo deleting ${pendingProjectRestore.projectName}`}
            onPress={undoProjectDelete}
            onFocus={() => setUndoFocused(true)}
            onBlur={() => setUndoFocused(false)}
            style={[
              styles.undoButton,
              { borderColor: colors.background },
              // Inverting the pill is the focus ring here: a foreground ring
              // would be invisible on the foreground-filled bar.
              undoFocused && { backgroundColor: colors.background },
            ]}
            testID="button-undo-delete-project"
          >
            <Text
              style={[
                styles.undoButtonText,
                { color: undoFocused ? colors.foreground : colors.background },
              ]}
            >
              Undo
            </Text>
          </TouchableOpacity>
        </RNAnimated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 20 },
  heading: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  eyebrow: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    letterSpacing: 0,
    marginBottom: 7,
  },
  title: { fontFamily: "Inter_600SemiBold", fontSize: 24, letterSpacing: -0.7 },
  createButton: {
    alignItems: "center",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  list: { gap: 10 },
  projectCard: {
    alignItems: "center",
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 84,
    padding: 17,
  },
  projectMark: { borderRadius: 8, height: 16, marginRight: 13, width: 16 },
  projectCopy: { flex: 1 },
  projectName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    marginBottom: 4,
  },
  projectDescription: { fontFamily: "Inter_400Regular", fontSize: 13 },
  projectMeta: { alignItems: "flex-end", gap: 7, marginLeft: 12 },
  metaActions: { alignItems: "center", flexDirection: "row", gap: 2 },
  deleteButton: {
    width: 44,
    height: 44,
    marginRight: -12,
    marginBottom: -12,
    alignItems: "center",
    justifyContent: "center",
  },
  metaText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  modalCard: { borderRadius: 26, padding: 22, width: "100%", maxWidth: 440 },
  modalTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 20,
    marginBottom: 18,
  },
  input: {
    borderRadius: 14,
    borderWidth: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    marginBottom: 12,
    padding: 13,
  },
  descriptionInput: { minHeight: 84, textAlignVertical: "top" },
  modalActions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 8,
    gap: 22,
  },
  cancel: { fontFamily: "Inter_500Medium", fontSize: 14 },
  confirmBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 6,
  },
  // Dialog action buttons carry an always-on transparent border so gaining
  // a focus ring never shifts layout.
  dialogTextButton: {
    borderColor: "transparent",
    borderRadius: 12,
    borderWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 10,
  },
  destructiveButton: {
    borderColor: "transparent",
    borderRadius: 14,
    borderWidth: 2,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 18,
  },
  destructiveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  saveButton: {
    borderRadius: 14,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  saveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
  undoBar: {
    alignItems: "center",
    borderRadius: 18,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    left: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    position: "absolute",
    right: 20,
  },
  undoText: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 14 },
  undoButton: {
    borderRadius: 999,
    borderWidth: 1.5,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 16,
  },
  undoButtonText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
