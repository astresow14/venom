import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Modal,
  Pressable,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { useColors } from "@/hooks/useColors";
import { useVenom, type Project } from "@/context/VenomContext";
import { Header } from "@/components/Header";

const ACCENTS = ["#FFFFFF", "#A3A3A3", "#737373", "#D4D4D4"];

export default function ProjectsScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, setActiveProject, addProject, deleteProject } = useVenom();

  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const chooseProject = (projectId: string) => {
    setActiveProject(projectId);
    router.back();
  };

  const createProject = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const projectId = addProject({
      name: trimmedName,
      description: description.trim() || "Project workspace",
      accent: ACCENTS[state.projects.length % ACCENTS.length],
      sourceCount: 0,
    });
    setActiveProject(projectId);
    setName("");
    setDescription("");
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
              WORKSPACES
            </Text>
            <Text style={[styles.title, { color: colors.foreground }]}>
              Choose where you work
            </Text>
          </View>
          <TouchableOpacity
            accessibilityLabel="Create project"
            onPress={() => setIsCreating(true)}
            style={[styles.createButton, { backgroundColor: colors.foreground }]}
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
                    {selected ? (
                      <Feather
                        name="check"
                        color={colors.background}
                        size={17}
                      />
                    ) : (
                      <TouchableOpacity
                        onPress={() => deleteProject(project.id)}
                        hitSlop={12}
                        testID={`delete-project-${project.id}`}
                      >
                        <Feather
                          name="trash-2"
                          size={15}
                          color={colors.destructive}
                          style={{ opacity: 0.7 }}
                        />
                      </TouchableOpacity>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
        </View>
      </ScrollView>

      <Modal transparent visible={isCreating} animationType="fade">
        <Pressable
          onPress={() => setIsCreating(false)}
          style={styles.modalBackdrop}
        >
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={[styles.modalCard, { backgroundColor: colors.card }]}
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
              <TouchableOpacity onPress={() => setIsCreating(false)}>
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
          </Pressable>
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
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 7,
  },
  title: { fontFamily: "Inter_600SemiBold", fontSize: 24, letterSpacing: -0.7 },
  createButton: {
    alignItems: "center",
    borderRadius: 18,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  list: { gap: 10 },
  projectCard: {
    alignItems: "center",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 84,
    padding: 16,
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
  metaText: { fontFamily: "Inter_500Medium", fontSize: 11 },
  modalBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.58)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  modalCard: { borderRadius: 20, padding: 20, width: "100%" },
  modalTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 20,
    marginBottom: 18,
  },
  input: {
    borderRadius: 12,
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
  saveButton: { borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11 },
  saveText: { fontFamily: "Inter_600SemiBold", fontSize: 14 },
});
