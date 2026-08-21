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

export default function ProjectsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, setActiveProject, addProject, deleteProject } = useVenom();

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [createButtonFocused, setCreateButtonFocused] = useState(false);
  const reduceMotion = useReducedMotion();
  const dialogAppear = useRef(new RNAnimated.Value(0)).current;
  const createButtonRef = useRef<FocusableHandle | null>(null);
  const dismissFocusRef = useRef<"create-button" | null>(null);
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

  // The dialog animates its own card because the modal container must not
  // animate on web: an animated modal keeps its focus trap alive while it
  // fades out and strands keyboard focus (see the card editor in
  // BoardWorkspace for the shared pattern).
  useEffect(() => {
    if (!isCreating) return;
    dialogAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(dialogAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [dialogAppear, isCreating, reduceMotion]);

  const openCreateDialog = () => {
    dismissFocusRef.current = null;
    setIsCreating(true);
  };

  // Cancel-style closes stay on this screen: hand focus back to the button
  // that opened the dialog.
  const cancelCreateDialog = () => {
    dismissFocusRef.current = "create-button";
    setIsCreating(false);
  };

  // Fires once the modal is actually gone (immediately on web) and its focus
  // trap has released, so an explicit focus target sticks.
  const handleDialogDismiss = () => {
    const target = dismissFocusRef.current;
    dismissFocusRef.current = null;
    if (target === "create-button") createButtonRef.current?.focus?.();
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
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  aria-selected={selected}
                  accessibilityLabel={`Switch to ${project.name}`}
                  onPress={() => chooseProject(project.id)}
                  style={[
                    styles.projectCard,
                    {
                      backgroundColor: selected
                        ? colors.foreground
                        : colors.card,
                      borderColor: selected ? colors.foreground : colors.border,
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
                        onPress={() => deleteProject(project.id)}
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${project.name}`}
                        style={styles.deleteButton}
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
  saveButton: {
    borderRadius: 14,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  saveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
