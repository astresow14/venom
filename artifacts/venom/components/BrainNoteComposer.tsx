import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ApiError,
  extractVenomKnowledge,
  improveVenomNote,
} from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { useVenom } from "@/context/VenomContext";
import {
  clearBrainNoteDraft,
  loadBrainNoteDraft,
  saveBrainNoteDraft,
} from "@/context/brainNoteDraftStore";
import {
  BrainNoteDraftPersistenceQueue,
  type BrainNoteDraft,
} from "@/context/brainNoteDraft";

const MAX_NOTE_LENGTH = 5000;

type NoteVersion = "original" | "suggestion";
type BusyAction = "improving" | "filing" | null;

type BrainNoteComposerProps = {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onRetargetProject: (projectId: string) => void;
};

function makeTemporaryId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function BrainNoteComposer({
  projectId,
  projectName,
  onClose,
  onRetargetProject,
}: BrainNoteComposerProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const { state, fileKnowledgeNote } = useVenom();
  const initiatingUserIdRef = useRef(userId ?? null);
  const activeUserIdRef = useRef(userId ?? null);
  const activeProjectIdRef = useRef(state.activeProjectId);
  const liveProjectIdsRef = useRef(
    new Set(state.projects.map((project) => project.id)),
  );
  const abortRef = useRef<AbortController | null>(null);
  const originalInputRef = useRef<TextInput>(null);
  const currentProjectIdRef = useRef(projectId);
  const latestDraftRef = useRef<BrainNoteDraft>({
    originalDraft: "",
    suggestedDraft: "",
    changeNotes: [],
    selectedVersion: "original",
  });
  const filedRef = useRef(false);
  const restorationCompleteRef = useRef(false);
  const touchedProjectIdsRef = useRef(new Set([projectId]));
  const draftPersistenceRef = useRef(new BrainNoteDraftPersistenceQueue());

  const [originalDraft, setOriginalDraft] = useState("");
  const [suggestedDraft, setSuggestedDraft] = useState("");
  const [changeNotes, setChangeNotes] = useState<string[]>([]);
  const [selectedVersion, setSelectedVersion] =
    useState<NoteVersion>("original");
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRestoringDraft, setIsRestoringDraft] = useState(true);

  activeUserIdRef.current = userId ?? null;
  activeProjectIdRef.current = state.activeProjectId;
  currentProjectIdRef.current = projectId;
  touchedProjectIdsRef.current.add(projectId);
  liveProjectIdsRef.current = new Set(
    state.projects.map((project) => project.id),
  );
  latestDraftRef.current = {
    originalDraft,
    suggestedDraft,
    changeNotes,
    selectedVersion,
  };

  const initiatingUserId = initiatingUserIdRef.current;
  const activeProject =
    state.projects.find((project) => project.id === state.activeProjectId) ??
    null;
  const projectChanged = state.activeProjectId !== projectId;
  const accountChanged = activeUserIdRef.current !== initiatingUserId;
  const projectUnavailable = !liveProjectIdsRef.current.has(projectId);
  const contextIsCurrent =
    Boolean(initiatingUserId) &&
    !accountChanged &&
    !projectChanged &&
    !projectUnavailable;
  const finalDraft =
    selectedVersion === "suggestion" ? suggestedDraft : originalDraft;
  const isBusy = busyAction !== null || isRestoringDraft;

  const captureContextIsCurrent = useCallback(
    () =>
      Boolean(initiatingUserId) &&
      activeUserIdRef.current === initiatingUserId &&
      activeProjectIdRef.current === projectId &&
      liveProjectIdsRef.current.has(projectId),
    [initiatingUserId, projectId],
  );

  useEffect(() => {
    let isMounted = true;
    const restoreDraft = async () => {
      if (!initiatingUserId) {
        if (isMounted) setIsRestoringDraft(false);
        return;
      }
      try {
        const savedDraft = await loadBrainNoteDraft(
          initiatingUserId,
          currentProjectIdRef.current,
        );
        if (!isMounted) return;
        if (savedDraft) {
          setOriginalDraft(savedDraft.originalDraft);
          setSuggestedDraft(savedDraft.suggestedDraft);
          setChangeNotes(savedDraft.changeNotes);
          setSelectedVersion(savedDraft.selectedVersion);
        }
      } catch {
        if (isMounted) {
          setError(
            "Venom could not restore a saved draft on this device. You can keep working in this composer.",
          );
        }
      } finally {
        if (isMounted) {
          restorationCompleteRef.current = true;
          setIsRestoringDraft(false);
        }
      }
    };
    void restoreDraft();

    return () => {
      isMounted = false;
      abortRef.current?.abort();
      abortRef.current = null;
      if (
        initiatingUserId &&
        restorationCompleteRef.current &&
        !filedRef.current
      ) {
        void draftPersistenceRef.current.enqueue(() =>
          saveBrainNoteDraft(
            initiatingUserId,
            currentProjectIdRef.current,
            latestDraftRef.current,
          ),
        );
      }
    };
  }, [initiatingUserId]);

  useEffect(() => {
    if (isRestoringDraft) return;
    const focusTimer = setTimeout(() => originalInputRef.current?.focus(), 120);
    return () => clearTimeout(focusTimer);
  }, [isRestoringDraft]);

  useEffect(() => {
    if (!initiatingUserId || isRestoringDraft || filedRef.current) return;
    const saveTimer = setTimeout(() => {
      if (filedRef.current) return;
      void draftPersistenceRef.current
        .enqueue(() =>
          saveBrainNoteDraft(
            initiatingUserId,
            projectId,
            latestDraftRef.current,
          ),
        )
        .catch(() => {
          setError(
            "Venom could not save this draft on this device. Keep the composer open while you finish.",
          );
        });
    }, 300);
    return () => clearTimeout(saveTimer);
  }, [
    changeNotes,
    initiatingUserId,
    isRestoringDraft,
    originalDraft,
    projectId,
    selectedVersion,
    suggestedDraft,
  ]);

  useEffect(() => {
    if (contextIsCurrent) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusyAction(null);
    if (accountChanged) {
      setError(
        "Your account changed while this note was open. The draft is still here, but it cannot be filed from this session.",
      );
    } else if (projectUnavailable) {
      setError(
        "This project is no longer available. Choose the current project to keep working with this draft.",
      );
    } else if (projectChanged) {
      setError(
        "The active project changed. Choose the current project before requesting or filing anything.",
      );
    }
  }, [accountChanged, contextIsCurrent, projectChanged, projectUnavailable]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const beginRequest = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  };

  const finishRequest = (controller: AbortController) => {
    if (abortRef.current === controller) {
      abortRef.current = null;
      setBusyAction(null);
    }
  };

  const recoveryError = (action: "improve" | "file", requestError: unknown) => {
    if (requestError instanceof ApiError) {
      if (requestError.status === 429) {
        const retryAfter = requestError.headers.get("retry-after");
        return retryAfter
          ? `Venom is handling a lot right now. Your draft is safe—retry in about ${retryAfter} seconds.`
          : "Venom is handling a lot right now. Your draft is safe—retry shortly.";
      }
      if (requestError.status === 401) {
        return "Your sign-in changed. Your draft is safe; close this composer and sign in again.";
      }
    }
    return action === "improve"
      ? "Venom could not improve the note. Your draft is unchanged—check your connection and retry."
      : "Venom could not file the note. Your draft is safe—check your connection and retry.";
  };

  const handleImprove = async () => {
    const note = originalDraft.trim();
    if (!note) {
      setError("Write a note before asking Venom to improve it.");
      originalInputRef.current?.focus();
      return;
    }
    if (!captureContextIsCurrent()) {
      setError(
        "The project or account changed. Resolve that before requesting a suggestion.",
      );
      return;
    }

    const controller = beginRequest();
    setBusyAction("improving");
    setError(null);
    try {
      const result = await improveVenomNote(
        { note },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!captureContextIsCurrent()) {
        setError(
          "The project or account changed before the suggestion returned. Your draft is unchanged.",
        );
        return;
      }
      setSuggestedDraft(result.suggestion);
      setChangeNotes(result.changeNotes);
      setSelectedVersion("original");
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(recoveryError("improve", requestError));
    } finally {
      finishRequest(controller);
    }
  };

  const handleFile = async () => {
    const note = finalDraft.trim();
    if (!note) {
      setError("Choose or write a meaningful note before filing it.");
      return;
    }
    if (!initiatingUserId || !captureContextIsCurrent()) {
      setError(
        "The project or account changed. Resolve that before filing this draft.",
      );
      return;
    }

    const controller = beginRequest();
    const sourceMessageId = makeTemporaryId("note-source");
    const sourceConversationId = makeTemporaryId("note-extraction");
    setBusyAction("filing");
    setError(null);

    try {
      // Deliberately not `file: true`: the note's conversation and message
      // ids are created locally only after extraction succeeds, so server
      // filing here would anchor evidence to this throwaway conversation id.
      // Local filing keeps the anchoring right; the ontology store absorbs
      // the result on the next workspace sync.
      const extraction = await extractVenomKnowledge(
        {
          conversation: {
            id: sourceConversationId,
            title: "Captured note",
            projectId,
          },
          messages: [
            {
              id: sourceMessageId,
              role: "user",
              content: note,
            },
          ],
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!captureContextIsCurrent()) {
        setError(
          "The project or account changed before extraction finished. Nothing was filed and your draft is still here.",
        );
        return;
      }
      if (!extraction.clusters.length) {
        setError(
          "Venom could not find a durable project concept in this note. Add a specific decision, plan, dependency, risk, or named idea, then retry.",
        );
        return;
      }

      const status = fileKnowledgeNote({
        userId: initiatingUserId,
        projectId,
        note,
        insights: extraction.clusters,
      });
      if (status === "account_changed") {
        setError(
          "Your account changed before filing completed. Nothing was saved; the draft remains available.",
        );
        return;
      }
      if (status === "project_unavailable") {
        setError(
          "This project is no longer available. Nothing was saved; choose the current project to continue.",
        );
        return;
      }
      if (status === "no_concepts") {
        setError(
          "Venom could not safely link this note to a Brain concept. The draft is unchanged—revise it and retry.",
        );
        return;
      }

      filedRef.current = true;
      await draftPersistenceRef.current.finish(async () => {
        await Promise.allSettled(
          [...touchedProjectIdsRef.current].map((draftProjectId) =>
            clearBrainNoteDraft(initiatingUserId, draftProjectId),
          ),
        );
      });
      onClose();
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setError(recoveryError("file", requestError));
    } finally {
      finishRequest(controller);
    }
  };

  const handleRetarget = () => {
    if (!activeProject || accountChanged) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setBusyAction(null);
    setError(null);
    onRetargetProject(activeProject.id);
  };

  const renderChoice = (
    version: NoteVersion,
    title: string,
    value: string,
    onChangeText: (value: string) => void,
    inputRef?: React.RefObject<TextInput | null>,
  ) => {
    const isSelected = selectedVersion === version;
    return (
      <View
        style={[
          styles.versionCard,
          {
            backgroundColor: colors.card,
            borderColor: isSelected ? colors.foreground : colors.border,
          },
        ]}
      >
        <TouchableOpacity
          style={styles.versionChoice}
          onPress={() => setSelectedVersion(version)}
          accessibilityRole="radio"
          accessibilityState={{ selected: isSelected }}
          accessibilityLabel={`Use ${title.toLowerCase()} when filing`}
          testID={`brain-note-use-${version}`}
        >
          <Feather
            name={isSelected ? "check-circle" : "circle"}
            size={18}
            color={isSelected ? colors.foreground : colors.mutedForeground}
          />
          <Text style={[styles.versionTitle, { color: colors.foreground }]}>
            {title}
          </Text>
          <Text
            style={[
              styles.versionStatus,
              {
                color: isSelected ? colors.foreground : colors.mutedForeground,
              },
            ]}
          >
            {isSelected ? "Selected" : "Choose"}
          </Text>
        </TouchableOpacity>
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={(nextValue) => {
            onChangeText(nextValue);
            if (error) setError(null);
          }}
          style={[
            styles.noteInput,
            { color: colors.foreground, borderColor: colors.border },
          ]}
          placeholder="Capture a decision, plan, dependency, risk, or idea…"
          placeholderTextColor={colors.mutedForeground}
          multiline
          textAlignVertical="top"
          maxLength={MAX_NOTE_LENGTH}
          editable={!isBusy}
          accessibilityLabel={`${title} note`}
          accessibilityHint="Multiline project note, up to 5000 characters"
          testID={`brain-note-${version}-input`}
        />
        <Text
          style={[styles.characterCount, { color: colors.mutedForeground }]}
          accessibilityLabel={`${value.length} of ${MAX_NOTE_LENGTH} characters`}
        >
          {value.length}/{MAX_NOTE_LENGTH}
        </Text>
      </View>
    );
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View
        style={[styles.backdrop, { backgroundColor: colors.symbioteBackdrop }]}
      >
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.background,
              borderColor: colors.border,
              paddingTop: Math.max(insets.top, Platform.OS === "web" ? 32 : 12),
            },
          ]}
          accessibilityViewIsModal
          accessibilityLabel={`Capture a note for ${projectName}`}
        >
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
                {projectName}
              </Text>
              <Text
                accessibilityRole="header"
                style={[styles.title, { color: colors.foreground }]}
              >
                Capture into Brain
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Cancel note capture"
              accessibilityHint="Closes without changing the Brain and keeps this draft on the device"
              testID="brain-note-close"
            >
              <Feather name="x" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          <KeyboardAwareScrollView
            style={styles.scroll}
            contentContainerStyle={[
              styles.content,
              { paddingBottom: Math.max(insets.bottom, 24) + 40 },
            ]}
            bottomOffset={96}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.intro, { color: colors.mutedForeground }]}>
              Keep the original, or ask Venom for an editable grammar and
              organization pass. Nothing is filed until you confirm. Unfiled
              drafts stay on this device for up to seven days.
            </Text>

            {isRestoringDraft ? (
              <View
                style={[
                  styles.restoreDraft,
                  { backgroundColor: colors.secondary },
                ]}
                accessibilityLiveRegion="polite"
              >
                <ActivityIndicator size="small" color={colors.foreground} />
                <Text
                  style={[
                    styles.restoreDraftText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Restoring saved draft…
                </Text>
              </View>
            ) : null}

            {renderChoice(
              "original",
              "Original",
              originalDraft,
              setOriginalDraft,
              originalInputRef,
            )}

            <TouchableOpacity
              style={[
                styles.secondaryButton,
                { borderColor: colors.border },
                (!originalDraft.trim() || isBusy || !contextIsCurrent) &&
                  styles.disabledControl,
              ]}
              onPress={handleImprove}
              disabled={!originalDraft.trim() || isBusy || !contextIsCurrent}
              accessibilityRole="button"
              accessibilityLabel="Ask Venom to improve grammar and organization"
              accessibilityState={{
                disabled: !originalDraft.trim() || isBusy || !contextIsCurrent,
                busy: busyAction === "improving",
              }}
              testID="brain-note-improve"
            >
              {busyAction === "improving" ? (
                <ActivityIndicator size="small" color={colors.foreground} />
              ) : (
                <Feather name="edit-3" size={16} color={colors.foreground} />
              )}
              <Text
                style={[
                  styles.secondaryButtonText,
                  { color: colors.foreground },
                ]}
              >
                {busyAction === "improving"
                  ? "Improving…"
                  : suggestedDraft
                    ? "Improve again"
                    : "Polish with Venom"}
              </Text>
            </TouchableOpacity>

            {suggestedDraft ? (
              <>
                <View style={styles.reviewHeader}>
                  <Text
                    style={[styles.reviewTitle, { color: colors.foreground }]}
                  >
                    Compare and choose
                  </Text>
                  <Text
                    style={[
                      styles.reviewHint,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    Both versions stay editable.
                  </Text>
                </View>
                {changeNotes.length ? (
                  <View
                    style={[
                      styles.changeSummary,
                      {
                        backgroundColor: colors.secondary,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.changeSummaryTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      What changed
                    </Text>
                    {changeNotes.map((changeNote, index) => (
                      <View
                        key={`${changeNote}-${index}`}
                        style={styles.changeRow}
                      >
                        <View
                          style={[
                            styles.changeDot,
                            { backgroundColor: colors.foreground },
                          ]}
                        />
                        <Text
                          style={[
                            styles.changeText,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {changeNote}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                {renderChoice(
                  "suggestion",
                  "Venom suggestion",
                  suggestedDraft,
                  setSuggestedDraft,
                )}
              </>
            ) : null}

            {error ? (
              <View
                style={[styles.errorCard, { borderColor: colors.destructive }]}
              >
                <Feather
                  name="alert-circle"
                  size={17}
                  color={colors.destructive}
                />
                <Text
                  accessibilityRole="alert"
                  style={[styles.errorText, { color: colors.foreground }]}
                >
                  {error}
                </Text>
              </View>
            ) : null}

            {!accountChanged && activeProject && !contextIsCurrent ? (
              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: colors.border }]}
                onPress={handleRetarget}
                accessibilityRole="button"
                accessibilityLabel={`Use current project ${activeProject.name}`}
                testID="brain-note-use-current-project"
              >
                <Feather
                  name="corner-down-right"
                  size={16}
                  color={colors.foreground}
                />
                <Text
                  style={[
                    styles.secondaryButtonText,
                    { color: colors.foreground },
                  ]}
                >
                  Use current project: {activeProject.name}
                </Text>
              </TouchableOpacity>
            ) : null}

            <View style={styles.actions}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Cancel note capture"
              >
                <Text
                  style={[
                    styles.cancelButtonText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  {
                    backgroundColor: colors.primary,
                  },
                  (!finalDraft.trim() || isBusy || !contextIsCurrent) &&
                    styles.disabledControl,
                ]}
                onPress={handleFile}
                disabled={!finalDraft.trim() || isBusy || !contextIsCurrent}
                accessibilityRole="button"
                accessibilityLabel={`File selected note into ${projectName} Brain`}
                accessibilityState={{
                  disabled: !finalDraft.trim() || isBusy || !contextIsCurrent,
                  busy: busyAction === "filing",
                }}
                testID="brain-note-file"
              >
                {busyAction === "filing" ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.primaryForeground}
                  />
                ) : (
                  <Feather
                    name="check"
                    size={17}
                    color={colors.primaryForeground}
                  />
                )}
                <Text
                  style={[
                    styles.primaryButtonText,
                    { color: colors.primaryForeground },
                  ]}
                >
                  {busyAction === "filing" ? "Filing…" : "File selected note"}
                </Text>
              </TouchableOpacity>
            </View>
          </KeyboardAwareScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    flex: 1,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    borderWidth: 1,
  },
  header: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerCopy: {
    flex: 1,
    paddingRight: 16,
  },
  eyebrow: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    letterSpacing: 0,
    marginBottom: 4,
  },
  title: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 22,
    letterSpacing: -0.5,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  intro: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 18,
  },
  restoreDraft: {
    minHeight: 46,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 13,
    marginBottom: 12,
  },
  restoreDraftText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  versionCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  versionChoice: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginBottom: 8,
  },
  versionTitle: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  versionStatus: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  noteInput: {
    minHeight: 138,
    maxHeight: 280,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    lineHeight: 22,
  },
  characterCount: {
    alignSelf: "flex-end",
    marginTop: 7,
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  secondaryButton: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
    marginTop: 14,
  },
  secondaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  disabledControl: {
    opacity: 0.46,
  },
  reviewHeader: {
    marginTop: 26,
    marginBottom: 10,
  },
  reviewTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    marginBottom: 3,
  },
  reviewHint: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  changeSummary: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
    marginBottom: 12,
  },
  changeSummaryTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    marginBottom: 8,
  },
  changeRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 4,
  },
  changeDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 7,
  },
  changeText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
  },
  errorCard: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 13,
    marginTop: 16,
  },
  errorText: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 22,
  },
  cancelButton: {
    minWidth: 80,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  cancelButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 18,
  },
  primaryButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
});
