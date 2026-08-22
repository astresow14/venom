import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard, Modal, Platform, Animated as RNAnimated, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { type BoardFocusTarget, type CardControlHandle, type CardControlHandles } from "@/components/board/boardTypes";
import { DraggableKanbanCard } from "@/components/board/DraggableKanbanCard";
import { KanbanField, KanbanFieldType, KanbanStage, Task, useVenom } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { useUnsyncedIndicator } from "@/hooks/useUnsyncedIndicator";
import { styles } from "./styles";

const FIELD_TYPE_LABELS: Record<KanbanFieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  single_select: "Single select",
  checkbox: "Checkbox",
};
export function BoardWorkspace({ activeProject }: { activeProject: any }) {
  const colors = useColors();
  const {
    syncStatus,
    addTask,
    updateTask,
    moveTask,
    deleteTask,
    addStage,
    updateStage,
    reorderStage,
    removeStage,
    addFieldDefinition,
    updateFieldDefinition,
    reorderFieldDefinition,
    removeFieldDefinition,
  } = useVenom();
  const stages: KanbanStage[] = activeProject?.boardStages ?? [];
  const fields: KanbanField[] = activeProject?.fieldDefinitions ?? [];
  const tasks: Task[] = activeProject?.tasks ?? [];
  const reduceMotion = useReducedMotion();
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [addingStageId, setAddingStageId] = useState<string | null>(null);
  const [editorTaskId, setEditorTaskId] = useState<string | null>(null);
  const [editorTitle, setEditorTitle] = useState("");
  const [editorStageId, setEditorStageId] = useState("");
  const [editorValues, setEditorValues] = useState<
    Record<string, string | boolean>
  >({});
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(
    null,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [newStageName, setNewStageName] = useState("");
  const [newStageIsDone, setNewStageIsDone] = useState(false);
  const [removingStageId, setRemovingStageId] = useState<string | null>(null);
  const [reassignStageId, setReassignStageId] = useState("");
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] =
    useState<KanbanFieldType>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [pendingDeleteFieldId, setPendingDeleteFieldId] = useState<
    string | null
  >(null);
  const [focusedMoveControl, setFocusedMoveControl] = useState<string | null>(
    null,
  );
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [focusedAddCardStageId, setFocusedAddCardStageId] = useState<
    string | null
  >(null);
  const editorAppear = useRef(new RNAnimated.Value(0)).current;
  const cardControlRefs = useRef<Map<string, CardControlHandles>>(new Map());
  const addCardControlRefs = useRef<Map<string, CardControlHandle>>(new Map());
  const stageNameInputRefs = useRef<Map<string, CardControlHandle>>(new Map());
  const fieldNameInputRefs = useRef<Map<string, CardControlHandle>>(new Map());
  const newStageNameInputRef = useRef<CardControlHandle | null>(null);
  const newFieldNameInputRef = useRef<CardControlHandle | null>(null);
  const pendingCardFocusRef = useRef<BoardFocusTarget | null>(null);
  const [boardError, setBoardError] = useState("");

  const tasksForStage = useCallback(
    (stageId: string) =>
      tasks
        .filter((task) => task.stageId === stageId)
        .sort(
          (left, right) =>
            left.position - right.position || left.id.localeCompare(right.id),
        ),
    [tasks],
  );

  const registerCardControl =
    (taskId: string, control: keyof CardControlHandles) =>
    (node: CardControlHandle | null) => {
      const handles = cardControlRefs.current.get(taskId) ?? {
        edit: null,
        next: null,
      };
      handles[control] = node;
      if (!handles.edit && !handles.next) {
        cardControlRefs.current.delete(taskId);
        return;
      }
      cardControlRefs.current.set(taskId, handles);
    };

  const registerAddCardControl =
    (stageId: string) => (node: CardControlHandle | null) => {
      if (node) {
        addCardControlRefs.current.set(stageId, node);
        return;
      }
      addCardControlRefs.current.delete(stageId);
    };

  const registerStageNameInput =
    (stageId: string) => (node: CardControlHandle | null) => {
      if (node) {
        stageNameInputRefs.current.set(stageId, node);
        return;
      }
      stageNameInputRefs.current.delete(stageId);
    };

  const registerFieldNameInput =
    (fieldId: string) => (node: CardControlHandle | null) => {
      if (node) {
        fieldNameInputRefs.current.set(fieldId, node);
        return;
      }
      fieldNameInputRefs.current.delete(fieldId);
    };

  // Confirming a stage or field removal unmounts the settings row that owns
  // the focused confirm button, so the browser drops keyboard focus to the
  // page body. Aim it at the control that takes the removed row's place
  // instead: the next row's rename input, or the section's "New stage/field
  // name" input when no row follows. Web only — on native there is no tab
  // order to lose, and focusing a TextInput would pop the soft keyboard.
  const focusAfterSettingsRemoval = (
    nextRowInput: CardControlHandle | null | undefined,
    addInput: CardControlHandle | null,
  ) => {
    if (Platform.OS !== "web") return;
    const target = nextRowInput ?? addInput;
    if (!target) return;
    // Wait a frame so the removal re-render has unmounted the confirm panel
    // before focus moves; focusing mid-commit can be undone by that unmount.
    requestAnimationFrame(() => target.focus?.());
  };

  // Keyboard users must keep their place after the editor closes. The card can
  // change stage on save, so the browser cannot restore focus by itself: the
  // element it remembers is unmounted with the old column.
  const focusCardControls = (taskId: string) => {
    const handles = cardControlRefs.current.get(taskId);
    if (!handles) return;
    const task = tasks.find((item) => item.id === taskId);
    const stageIndex = task
      ? stages.findIndex((stage) => stage.id === task.stageId)
      : -1;
    const canMoveNext = stageIndex >= 0 && stageIndex < stages.length - 1;
    const target = (canMoveNext ? handles.next : null) ?? handles.edit;
    target?.focus?.();
  };

  const handleEditorDismiss = () => {
    const target = pendingCardFocusRef.current;
    pendingCardFocusRef.current = null;
    if (!target) return;
    if (target.kind === "card") {
      focusCardControls(target.taskId);
      return;
    }
    addCardControlRefs.current.get(target.stageId)?.focus?.();
  };

  const openEditor = (task: Task) => {
    pendingCardFocusRef.current = null;
    setEditorTaskId(task.id);
    setEditorTitle(task.title);
    setEditorStageId(task.stageId);
    setPendingDeleteTaskId(null);
    setBoardError("");
    setEditorValues(
      Object.fromEntries(
        fields.map((field) => [
          field.id,
          field.type === "checkbox"
            ? task.values[field.id] === true
            : String(task.values[field.id] ?? ""),
        ]),
      ),
    );
  };

  const closeEditor = () => {
    setEditorTaskId(null);
    setPendingDeleteTaskId(null);
    setBoardError("");
  };

  const handleAddTask = (stageId: string) => {
    const trimmed = newTaskTitle.trim();
    if (!trimmed) {
      setBoardError("Enter a task title.");
      return;
    }
    if (tasks.length >= 2000) {
      setBoardError("This project has reached the 2,000-card limit.");
      return;
    }
    addTask(activeProject.id, trimmed, stageId);
    setNewTaskTitle("");
    setAddingStageId(null);
    setBoardError("");
    if (Platform.OS !== "web") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const saveTask = () => {
    if (!editorTaskId || !editorTitle.trim()) {
      setBoardError("Task title is required.");
      return;
    }
    const values: Record<string, string | number | boolean> = {};
    for (const field of fields) {
      const value = editorValues[field.id];
      if (field.type === "checkbox") {
        if (typeof value === "boolean") values[field.id] = value;
      } else if (typeof value === "string" && value.trim()) {
        if (field.type === "number") {
          const numberValue = Number(value);
          if (
            !Number.isFinite(numberValue) ||
            numberValue < -1_000_000_000 ||
            numberValue > 1_000_000_000
          ) {
            setBoardError(
              `${field.name} must be a number between -1 billion and 1 billion.`,
            );
            return;
          }
          values[field.id] = numberValue;
        } else if (
          field.type === "date" &&
          !isValidCardDate(value.trim())
        ) {
          setBoardError(`${field.name} must be a valid date using YYYY-MM-DD.`);
          return;
        } else {
          values[field.id] = value.trim();
        }
      }
    }
    updateTask(activeProject.id, editorTaskId, {
      title: editorTitle,
      stageId: editorStageId,
      values,
    });
    pendingCardFocusRef.current = { kind: "card", taskId: editorTaskId };
    closeEditor();
  };

  // Deleting the edited card leaves nothing for the browser to return focus
  // to, so aim the post-dismiss focus at the closest surviving neighbour in
  // the card's stage — the next card, or the previous one when the last card
  // went — and at the stage's "Add card" control once the stage is empty.
  const deleteEditedTask = () => {
    if (!editorTaskId) return;
    const task = tasks.find((item) => item.id === editorTaskId);
    if (task) {
      const columnTasks = tasksForStage(task.stageId);
      const index = columnTasks.findIndex((item) => item.id === task.id);
      const neighbour =
        index >= 0
          ? (columnTasks[index + 1] ?? columnTasks[index - 1])
          : undefined;
      pendingCardFocusRef.current = neighbour
        ? { kind: "card", taskId: neighbour.id }
        : { kind: "addCard", stageId: task.stageId };
    }
    deleteTask(activeProject.id, editorTaskId);
    closeEditor();
  };

  const moveCard = (
    task: Task,
    stageId: string,
    position: number,
  ) => {
    moveTask(activeProject.id, task.id, stageId, position);
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  const addNewStage = () => {
    const name = newStageName.trim();
    if (!name) {
      setBoardError("Stage name is required.");
      return;
    }
    if (stages.length >= 30) {
      setBoardError("A board can have up to 30 stages.");
      return;
    }
    if (
      stages.some(
        (stage) =>
          stage.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setBoardError("Stage names must be unique.");
      return;
    }
    addStage(activeProject.id, name, newStageIsDone);
    setNewStageName("");
    setNewStageIsDone(false);
    setBoardError("");
  };

  const beginRemoveStage = (stageId: string) => {
    const fallback = stages.find((stage) => stage.id !== stageId);
    if (!fallback) {
      setBoardError("A board must keep at least one stage.");
      return;
    }
    setRemovingStageId(stageId);
    setReassignStageId(fallback.id);
    setBoardError("");
  };

  const confirmRemoveStage = () => {
    if (!removingStageId || !reassignStageId) return;
    const removedIndex = stages.findIndex(
      (stage) => stage.id === removingStageId,
    );
    const nextStage = removedIndex >= 0 ? stages[removedIndex + 1] : undefined;
    removeStage(activeProject.id, removingStageId, reassignStageId);
    setRemovingStageId(null);
    setReassignStageId("");
    focusAfterSettingsRemoval(
      nextStage ? stageNameInputRefs.current.get(nextStage.id) : undefined,
      newStageNameInputRef.current,
    );
  };

  const confirmRemoveField = (fieldId: string) => {
    const removedIndex = fields.findIndex((field) => field.id === fieldId);
    const nextField = removedIndex >= 0 ? fields[removedIndex + 1] : undefined;
    removeFieldDefinition(activeProject.id, fieldId);
    setPendingDeleteFieldId(null);
    focusAfterSettingsRemoval(
      nextField ? fieldNameInputRefs.current.get(nextField.id) : undefined,
      newFieldNameInputRef.current,
    );
  };

  const addNewField = () => {
    const name = newFieldName.trim();
    const options = newFieldOptions
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    if (!name) {
      setBoardError("Field name is required.");
      return;
    }
    if (fields.length >= 40) {
      setBoardError("A board can have up to 40 custom fields.");
      return;
    }
    if (
      fields.some(
        (field) =>
          field.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setBoardError("Field names must be unique.");
      return;
    }
    if (newFieldType === "single_select" && options.length === 0) {
      setBoardError("Add at least one comma-separated option.");
      return;
    }
    addFieldDefinition(activeProject.id, {
      name,
      type: newFieldType,
      options,
      showOnCard: true,
    });
    setNewFieldName("");
    setNewFieldOptions("");
    setBoardError("");
  };

  const visibleFields = fields.filter((field) => field.showOnCard).slice(0, 3);
  const editingTask = tasks.find((task) => task.id === editorTaskId);
  const editorIsOpen = Boolean(editingTask);

  useEffect(() => {
    if (!editorIsOpen) return;
    editorAppear.setValue(reduceMotion ? 1 : 0);
    if (reduceMotion) return;
    const appearance = RNAnimated.timing(editorAppear, {
      toValue: 1,
      duration: 170,
      useNativeDriver: Platform.OS !== "web",
    });
    appearance.start();
    return () => appearance.stop();
  }, [editorAppear, editorIsOpen, reduceMotion]);

  // Cloud-lag notice: same arm-on-failure / sustain-through-retry timing as
  // the chat notice (useUnsyncedIndicator), so the board cannot blink while
  // backoff retries run or alarm on a blip that recovers on the first retry.
  // too_large keeps its own guidance because the person can fix that
  // themselves by trimming the board.
  const showSyncNotice = useUnsyncedIndicator(syncStatus);
  const syncNotice = showSyncNotice
    ? syncStatus === "too_large"
      ? "This board is saved on this device but is too large to sync. Remove unused cards or fields, then edit again to retry."
      : "Latest board changes are saved on this device only — they'll sync when the connection returns."
    : null;

  const renderCard = (
    task: Task,
    stage: KanbanStage,
    columnTasks: Task[],
  ) => {
    const stageIndex = stages.findIndex((item) => item.id === stage.id);
    const taskIndex = columnTasks.findIndex((item) => item.id === task.id);
    const handleDirectMove = (translationX: number, translationY: number) => {
      if (Math.abs(translationX) >= 72) {
        const targetStageIndex = Math.max(
          0,
          Math.min(
            stages.length - 1,
            stageIndex + (translationX > 0 ? 1 : -1),
          ),
        );
        if (targetStageIndex !== stageIndex) {
          const targetStage = stages[targetStageIndex];
          moveCard(
            task,
            targetStage.id,
            tasksForStage(targetStage.id).length,
          );
        }
        return;
      }
      if (Math.abs(translationY) >= 44) {
        const targetPosition = Math.max(
          0,
          Math.min(
            columnTasks.length - 1,
            taskIndex + (translationY > 0 ? 1 : -1),
          ),
        );
        if (targetPosition !== taskIndex) {
          moveCard(task, stage.id, targetPosition);
        }
      }
    };
    return (
      <DraggableKanbanCard key={task.id} onDragEnd={handleDirectMove}>
        <View
          style={[
            styles.kanbanCard,
            { backgroundColor: colors.card, borderColor: colors.border },
            focusedCardId === task.id && { borderColor: colors.primary },
          ]}
          testID={`kanban-card-${task.id}`}
        >
          <TouchableOpacity
            ref={registerCardControl(task.id, "edit")}
            onPress={() => openEditor(task)}
            accessibilityRole="button"
            accessibilityLabel={`Edit task ${task.title}`}
            accessibilityHint="Long press and drag to move this card. Arrow buttons provide the same controls."
            style={styles.kanbanCardMain}
            onFocus={() => setFocusedCardId(task.id)}
            onBlur={() =>
              setFocusedCardId((current) =>
                current === task.id ? null : current,
              )
            }
          >
            <Text
              style={[
                styles.kanbanCardTitle,
                {
                  color: stage.isDone
                    ? colors.mutedForeground
                    : colors.foreground,
                },
                stage.isDone && { textDecorationLine: "line-through" },
              ]}
            >
              {task.title}
            </Text>
            {visibleFields.map((field) => {
              const value = task.values[field.id];
              if (value === undefined || value === "") return null;
              return (
                <View key={field.id} style={styles.cardFieldRow}>
                  <Text
                    style={[
                      styles.cardFieldName,
                      { color: colors.mutedForeground },
                    ]}
                    numberOfLines={1}
                  >
                    {field.name}
                  </Text>
                  <Text
                    style={[
                      styles.cardFieldValue,
                      { color: colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {field.type === "checkbox"
                      ? value
                        ? "Yes"
                        : "No"
                      : String(value)}
                  </Text>
                </View>
              );
            })}
          </TouchableOpacity>
          <View style={styles.cardMoveActions}>
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:up` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() => moveCard(task, stage.id, taskIndex - 1)}
              disabled={taskIndex === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} up`}
              onFocus={() => setFocusedMoveControl(`${task.id}:up`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-up"
                size={13}
                color={
                  taskIndex === 0 ? colors.border : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:down` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() => moveCard(task, stage.id, taskIndex + 1)}
              disabled={taskIndex === columnTasks.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} down`}
              onFocus={() => setFocusedMoveControl(`${task.id}:down`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-down"
                size={13}
                color={
                  taskIndex === columnTasks.length - 1
                    ? colors.border
                    : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <View style={styles.cardMoveSpacer} />
            <TouchableOpacity
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:previous` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() =>
                moveCard(
                  task,
                  stages[stageIndex - 1].id,
                  tasksForStage(stages[stageIndex - 1].id).length,
                )
              }
              disabled={stageIndex === 0}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} to previous stage`}
              onFocus={() => setFocusedMoveControl(`${task.id}:previous`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-left"
                size={13}
                color={
                  stageIndex === 0 ? colors.border : colors.mutedForeground
                }
              />
            </TouchableOpacity>
            <TouchableOpacity
              ref={registerCardControl(task.id, "next")}
              style={[
                styles.cardMoveButton,
                focusedMoveControl === `${task.id}:next` && {
                  borderColor: colors.primary,
                },
              ]}
              onPress={() =>
                moveCard(
                  task,
                  stages[stageIndex + 1].id,
                  tasksForStage(stages[stageIndex + 1].id).length,
                )
              }
              disabled={stageIndex === stages.length - 1}
              accessibilityRole="button"
              accessibilityLabel={`Move ${task.title} to next stage`}
              onFocus={() => setFocusedMoveControl(`${task.id}:next`)}
              onBlur={() => setFocusedMoveControl(null)}
            >
              <Feather
                name="arrow-right"
                size={13}
                color={
                  stageIndex === stages.length - 1
                    ? colors.border
                    : colors.mutedForeground
                }
              />
            </TouchableOpacity>
          </View>
        </View>
      </DraggableKanbanCard>
    );
  };

  return (
    <View style={styles.workspaceContainer}>
      <ScrollView
        contentContainerStyle={styles.boardScrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.boardHeader}>
          <View>
            <Text style={[styles.boardTitle, { color: colors.foreground }]}>
              Task Board
            </Text>
            <Text
              style={[styles.boardSubtitle, { color: colors.mutedForeground }]}
            >
              {tasks.length} {tasks.length === 1 ? "card" : "cards"} ·{" "}
              {stages.length} {stages.length === 1 ? "stage" : "stages"}
            </Text>
          </View>
          <TouchableOpacity
            style={[
              styles.boardSettingsButton,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            onPress={() => {
              setShowSettings((shown) => !shown);
              setBoardError("");
            }}
            accessibilityRole="button"
            accessibilityLabel={
              showSettings ? "Close board settings" : "Open board settings"
            }
            testID="board-settings-button"
          >
            <Feather
              name={showSettings ? "x" : "sliders"}
              size={16}
              color={colors.foreground}
            />
          </TouchableOpacity>
        </View>

        {!!syncNotice && (
          <View
            style={[
              styles.boardSyncNotice,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            accessibilityLiveRegion="polite"
            testID="board-unsynced-notice"
          >
            <Feather
              name="cloud-off"
              size={14}
              color={colors.mutedForeground}
            />
            <Text
              style={[
                styles.boardSyncNoticeText,
                { color: colors.mutedForeground },
              ]}
            >
              {syncNotice}
            </Text>
          </View>
        )}

        {!!boardError && (
          <View
            style={[
              styles.boardError,
              { borderColor: colors.destructive },
            ]}
            accessibilityRole="alert"
          >
            <Feather
              name="alert-circle"
              size={14}
              color={colors.destructive}
            />
            <Text style={[styles.boardErrorText, { color: colors.destructive }]}>
              {boardError}
            </Text>
          </View>
        )}

        {showSettings && (
          <View
            style={[
              styles.boardSettings,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            <Text
              style={[styles.settingsSectionTitle, { color: colors.foreground }]}
            >
              Stages
            </Text>
            <Text
              style={[
                styles.settingsSectionHelp,
                { color: colors.mutedForeground },
              ]}
            >
              Done stages mark cards complete. You can use more than one.
            </Text>
            {stages.map((stage, index) => (
              <View key={stage.id}>
                <View
                  style={[
                    styles.settingsRow,
                    { borderTopColor: colors.border },
                  ]}
                >
                  <TextInput
                    ref={registerStageNameInput(stage.id)}
                    key={stage.id}
                    defaultValue={stage.name}
                    style={[
                      styles.settingsNameInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    maxLength={80}
                    accessibilityLabel={`Rename stage ${stage.name}`}
                    onChangeText={(name) => {
                      if (name.trim()) {
                        updateStage(activeProject.id, stage.id, { name });
                      }
                    }}
                    onEndEditing={(event) => {
                      const name = event.nativeEvent.text.trim();
                      if (!name) {
                        setBoardError("Stage name is required.");
                        return;
                      }
                      if (
                        stages.some(
                          (item) =>
                            item.id !== stage.id &&
                            item.name.toLocaleLowerCase() ===
                              name.toLocaleLowerCase(),
                        )
                      ) {
                        setBoardError("Stage names must be unique.");
                        return;
                      }
                      updateStage(activeProject.id, stage.id, { name });
                    }}
                  />
                  <TouchableOpacity
                    style={[
                      styles.doneToggle,
                      {
                        borderColor: stage.isDone
                          ? colors.primary
                          : colors.border,
                        backgroundColor: stage.isDone
                          ? colors.secondary
                          : "transparent",
                      },
                    ]}
                    onPress={() =>
                      stage.isDone &&
                      stages.filter((item) => item.isDone).length === 1
                        ? setBoardError(
                            "Keep at least one done stage so completion remains clear.",
                          )
                        : (updateStage(activeProject.id, stage.id, {
                            isDone: !stage.isDone,
                          }),
                          setBoardError(""))
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: stage.isDone }}
                    accessibilityLabel={`${stage.name} is a done stage`}
                    aria-checked={stage.isDone}
                  >
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={13}
                      color={
                        stage.isDone
                          ? colors.foreground
                          : colors.mutedForeground
                      }
                    />
                    <Text
                      style={[
                        styles.doneToggleText,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Done
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderStage(activeProject.id, stage.id, index - 1)
                    }
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${stage.name} left`}
                  >
                    <Feather
                      name="arrow-left"
                      size={14}
                      color={index === 0 ? colors.border : colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderStage(activeProject.id, stage.id, index + 1)
                    }
                    disabled={index === stages.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${stage.name} right`}
                  >
                    <Feather
                      name="arrow-right"
                      size={14}
                      color={
                        index === stages.length - 1
                          ? colors.border
                          : colors.foreground
                      }
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() => beginRemoveStage(stage.id)}
                    disabled={stages.length <= 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove stage ${stage.name}`}
                  >
                    <Feather
                      name="trash-2"
                      size={14}
                      color={
                        stages.length <= 1
                          ? colors.border
                          : colors.destructive
                      }
                    />
                  </TouchableOpacity>
                </View>
                {removingStageId === stage.id && (
                  <View
                    style={[
                      styles.confirmPanel,
                      { borderColor: colors.destructive },
                    ]}
                  >
                    <Text
                      style={[
                        styles.confirmTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Move its {tasksForStage(stage.id).length} cards to:
                    </Text>
                    <View style={styles.choiceWrap}>
                      {stages
                        .filter((item) => item.id !== stage.id)
                        .map((target) => (
                          <TouchableOpacity
                            key={target.id}
                            style={[
                              styles.choiceChip,
                              {
                                borderColor:
                                  reassignStageId === target.id
                                    ? colors.primary
                                    : colors.border,
                                backgroundColor:
                                  reassignStageId === target.id
                                    ? colors.secondary
                                    : "transparent",
                              },
                            ]}
                            onPress={() => setReassignStageId(target.id)}
                            accessibilityRole="radio"
                            accessibilityState={{
                              selected: reassignStageId === target.id,
                            }}
                            accessibilityLabel={`Reassign cards to ${target.name}`}
                            aria-checked={reassignStageId === target.id}
                          >
                            <Text
                              style={[
                                styles.choiceChipText,
                                { color: colors.foreground },
                              ]}
                            >
                              {target.name}
                            </Text>
                          </TouchableOpacity>
                        ))}
                    </View>
                    <View style={styles.confirmActions}>
                      <TouchableOpacity
                        onPress={() => setRemovingStageId(null)}
                        accessibilityRole="button"
                      >
                        <Text
                          style={[
                            styles.textButton,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          Cancel
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={confirmRemoveStage}
                        style={[
                          styles.destructiveButton,
                          { backgroundColor: colors.destructive },
                        ]}
                        accessibilityRole="button"
                      >
                        <Text
                          style={[
                            styles.destructiveButtonText,
                            { color: colors.primaryForeground },
                          ]}
                        >
                          Reassign & remove
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            ))}
            <View style={styles.settingsAddRow}>
              <TextInput
                ref={(node: CardControlHandle | null) => {
                  newStageNameInputRef.current = node;
                }}
                style={[
                  styles.settingsAddInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newStageName}
                onChangeText={setNewStageName}
                placeholder="New stage"
                placeholderTextColor={colors.mutedForeground}
                maxLength={80}
                accessibilityLabel="New stage name"
              />
              <TouchableOpacity
                style={[
                  styles.doneToggle,
                  {
                    borderColor: newStageIsDone
                      ? colors.primary
                      : colors.border,
                  },
                ]}
                onPress={() => setNewStageIsDone((value) => !value)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: newStageIsDone }}
                accessibilityLabel="New stage is a done stage"
                aria-checked={newStageIsDone}
              >
                <Feather
                  name={newStageIsDone ? "check-circle" : "circle"}
                  size={13}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.doneToggleText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Done
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.settingsAddButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={addNewStage}
                accessibilityRole="button"
                accessibilityLabel="Add stage"
              >
                <Feather
                  name="plus"
                  size={15}
                  color={colors.primaryForeground}
                />
              </TouchableOpacity>
            </View>

            <View
              style={[styles.settingsDivider, { backgroundColor: colors.border }]}
            />
            <Text
              style={[styles.settingsSectionTitle, { color: colors.foreground }]}
            >
              Card fields
            </Text>
            <Text
              style={[
                styles.settingsSectionHelp,
                { color: colors.mutedForeground },
              ]}
            >
              Choose which values appear on compact cards.
            </Text>
            {fields.map((field, index) => (
              <View key={field.id}>
                <View
                  style={[
                    styles.settingsRow,
                    { borderTopColor: colors.border },
                  ]}
                >
                  <TextInput
                    ref={registerFieldNameInput(field.id)}
                    key={field.id}
                    defaultValue={field.name}
                    style={[
                      styles.settingsNameInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    maxLength={80}
                    accessibilityLabel={`Rename field ${field.name}`}
                    onChangeText={(name) => {
                      if (name.trim()) {
                        updateFieldDefinition(activeProject.id, field.id, {
                          name,
                        });
                      }
                    }}
                    onEndEditing={(event) => {
                      const name = event.nativeEvent.text.trim();
                      if (!name) {
                        setBoardError("Field name is required.");
                        return;
                      }
                      if (
                        fields.some(
                          (item) =>
                            item.id !== field.id &&
                            item.name.toLocaleLowerCase() ===
                              name.toLocaleLowerCase(),
                        )
                      ) {
                        setBoardError("Field names must be unique.");
                        return;
                      }
                      updateFieldDefinition(activeProject.id, field.id, {
                        name,
                      })
                      setBoardError("");
                    }}
                  />
                  <Text
                    style={[
                      styles.fieldTypeBadge,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {FIELD_TYPE_LABELS[field.type]}
                  </Text>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      updateFieldDefinition(activeProject.id, field.id, {
                        showOnCard: !field.showOnCard,
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: field.showOnCard }}
                    accessibilityLabel={`Show ${field.name} on cards`}
                    aria-checked={field.showOnCard}
                  >
                    <Feather
                      name={field.showOnCard ? "eye" : "eye-off"}
                      size={14}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderFieldDefinition(
                        activeProject.id,
                        field.id,
                        index - 1,
                      )
                    }
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${field.name} up`}
                  >
                    <Feather
                      name="arrow-up"
                      size={14}
                      color={index === 0 ? colors.border : colors.foreground}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() =>
                      reorderFieldDefinition(
                        activeProject.id,
                        field.id,
                        index + 1,
                      )
                    }
                    disabled={index === fields.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${field.name} down`}
                  >
                    <Feather
                      name="arrow-down"
                      size={14}
                      color={
                        index === fields.length - 1
                          ? colors.border
                          : colors.foreground
                      }
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.settingsIconButton}
                    onPress={() => setPendingDeleteFieldId(field.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove field ${field.name}`}
                  >
                    <Feather
                      name="trash-2"
                      size={14}
                      color={colors.destructive}
                    />
                  </TouchableOpacity>
                </View>
                {field.type === "single_select" && (
                  <TextInput
                    key={`${field.id}-options-${field.updatedAt}`}
                    defaultValue={field.options.join(", ")}
                    style={[
                      styles.fieldOptionsInput,
                      { color: colors.foreground, borderColor: colors.border },
                    ]}
                    accessibilityLabel={`Options for ${field.name}`}
                    onEndEditing={(event) => {
                      const options = event.nativeEvent.text
                        .split(",")
                        .map((option) => option.trim())
                        .filter(Boolean);
                      if (options.length === 0) {
                        setBoardError(
                          `${field.name} needs at least one option.`,
                        );
                        return;
                      }
                      updateFieldDefinition(activeProject.id, field.id, {
                        options,
                      });
                      setBoardError("");
                    }}
                  />
                )}
                {pendingDeleteFieldId === field.id && (
                  <View
                    style={[
                      styles.confirmPanel,
                      { borderColor: colors.destructive },
                    ]}
                  >
                    <Text
                      style={[
                        styles.confirmTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Remove {field.name} and its values from every card?
                    </Text>
                    <View style={styles.confirmActions}>
                      <TouchableOpacity
                        onPress={() => setPendingDeleteFieldId(null)}
                      >
                        <Text
                          style={[
                            styles.textButton,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          Cancel
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => confirmRemoveField(field.id)}
                        style={[
                          styles.destructiveButton,
                          { backgroundColor: colors.destructive },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Confirm removal of ${field.name}`}
                      >
                        <Text
                          style={[
                            styles.destructiveButtonText,
                            { color: colors.primaryForeground },
                          ]}
                        >
                          Remove field
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            ))}
            <View style={styles.fieldTypePicker}>
              {(Object.keys(FIELD_TYPE_LABELS) as KanbanFieldType[]).map(
                (type) => (
                  <TouchableOpacity
                    key={type}
                    style={[
                      styles.choiceChip,
                      {
                        borderColor:
                          newFieldType === type
                            ? colors.primary
                            : colors.border,
                        backgroundColor:
                          newFieldType === type
                            ? colors.secondary
                            : "transparent",
                      },
                    ]}
                    onPress={() => setNewFieldType(type)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: newFieldType === type }}
                    accessibilityLabel={`${FIELD_TYPE_LABELS[type]} field type`}
                    aria-checked={newFieldType === type}
                  >
                    <Text
                      style={[
                        styles.choiceChipText,
                        { color: colors.foreground },
                      ]}
                    >
                      {FIELD_TYPE_LABELS[type]}
                    </Text>
                  </TouchableOpacity>
                ),
              )}
            </View>
            <View style={styles.settingsAddRow}>
              <TextInput
                ref={(node: CardControlHandle | null) => {
                  newFieldNameInputRef.current = node;
                }}
                style={[
                  styles.settingsAddInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newFieldName}
                onChangeText={setNewFieldName}
                placeholder="New field"
                placeholderTextColor={colors.mutedForeground}
                maxLength={80}
                accessibilityLabel="New field name"
              />
              <TouchableOpacity
                style={[
                  styles.settingsAddButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={addNewField}
                accessibilityRole="button"
                accessibilityLabel="Add field"
              >
                <Feather
                  name="plus"
                  size={15}
                  color={colors.primaryForeground}
                />
              </TouchableOpacity>
            </View>
            {newFieldType === "single_select" && (
              <TextInput
                style={[
                  styles.fieldOptionsInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={newFieldOptions}
                onChangeText={setNewFieldOptions}
                placeholder="Options, separated by commas"
                placeholderTextColor={colors.mutedForeground}
                accessibilityLabel="New field options"
              />
            )}
          </View>
        )}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.boardColumnsContainer}
          directionalLockEnabled
          nestedScrollEnabled
          accessibilityLabel="Kanban stages"
        >
          {stages.map((stage) => {
            const columnTasks = tasksForStage(stage.id);
            return (
              <View
                key={stage.id}
                style={[
                  styles.boardColumn,
                  { borderColor: colors.border, backgroundColor: colors.card },
                ]}
                accessibilityRole="list"
                accessibilityLabel={`${stage.name} stage`}
              >
                <View style={styles.boardColumnHeader}>
                  <View style={styles.boardColumnTitleRow}>
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={13}
                      color={colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.boardColumnTitle,
                        { color: colors.foreground },
                      ]}
                      numberOfLines={1}
                    >
                      {stage.name}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.boardColumnCount,
                      { color: colors.mutedForeground },
                    ]}
                    accessibilityLabel={`${columnTasks.length} cards`}
                  >
                    {columnTasks.length}
                  </Text>
                </View>
                <View style={styles.boardColumnList}>
                  {columnTasks.length === 0 && addingStageId !== stage.id && (
                    <View
                      style={[
                        styles.columnEmpty,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Text
                        style={[
                          styles.columnEmptyText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        No cards in {stage.name}
                      </Text>
                    </View>
                  )}
                  {columnTasks.map((task) =>
                    renderCard(task, stage, columnTasks),
                  )}
                  {addingStageId === stage.id ? (
                    <View
                      style={[
                        styles.addTaskForm,
                        { borderColor: colors.border },
                      ]}
                    >
                      <TextInput
                        style={[
                          styles.addTaskInput,
                          {
                            color: colors.foreground,
                            borderColor: colors.border,
                          },
                        ]}
                        placeholder={`Add to ${stage.name}`}
                        placeholderTextColor={colors.mutedForeground}
                        value={newTaskTitle}
                        onChangeText={setNewTaskTitle}
                        autoFocus
                        onSubmitEditing={() => handleAddTask(stage.id)}
                        returnKeyType="done"
                        maxLength={280}
                        accessibilityLabel={`New task title for ${stage.name}`}
                      />
                      <View style={styles.addTaskActions}>
                        <TouchableOpacity
                          onPress={() => {
                            setAddingStageId(null);
                            setNewTaskTitle("");
                          }}
                          accessibilityRole="button"
                        >
                          <Text
                            style={[
                              styles.textButton,
                              { color: colors.mutedForeground },
                            ]}
                          >
                            Cancel
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => handleAddTask(stage.id)}
                          style={[
                            styles.addTaskSubmit,
                            { backgroundColor: colors.primary },
                          ]}
                          accessibilityRole="button"
                        >
                          <Text
                            style={[
                              styles.addTaskSubmitText,
                              { color: colors.primaryForeground },
                            ]}
                          >
                            Add card
                          </Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <TouchableOpacity
                      ref={registerAddCardControl(stage.id)}
                      style={[
                        styles.columnAddButton,
                        { borderColor: colors.border },
                        focusedAddCardStageId === stage.id && {
                          borderColor: colors.primary,
                        },
                      ]}
                      onPress={() => {
                        setAddingStageId(stage.id);
                        setNewTaskTitle("");
                        setBoardError("");
                      }}
                      onFocus={() => setFocusedAddCardStageId(stage.id)}
                      onBlur={() =>
                        setFocusedAddCardStageId((current) =>
                          current === stage.id ? null : current,
                        )
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`Add card to ${stage.name}`}
                      testID={`add-task-${stage.id}`}
                    >
                      <Feather
                        name="plus"
                        size={14}
                        color={colors.mutedForeground}
                      />
                      <Text
                        style={[
                          styles.columnAddText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Add card
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </ScrollView>

      <Modal
        visible={Boolean(editingTask)}
        transparent
        // On web an animated dismissal keeps the dialog (and its focus trap)
        // mounted for the length of the fade, which pulls keyboard focus back
        // into the closing editor. Close immediately there instead.
        animationType={Platform.OS === "web" ? "none" : "fade"}
        onDismiss={handleEditorDismiss}
        onRequestClose={closeEditor}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior="padding"
        >
          <RNAnimated.View
            style={[
              styles.cardEditor,
              { backgroundColor: colors.background, borderColor: colors.border },
              {
                opacity: editorAppear,
                transform: [
                  {
                    translateY: editorAppear.interpolate({
                      inputRange: [0, 1],
                      outputRange: [10, 0],
                    }),
                  },
                ],
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel="Card editor"
          >
            <ScrollView
              contentContainerStyle={styles.cardEditorContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.cardEditorHeader}>
                <Text
                  style={[styles.cardEditorTitle, { color: colors.foreground }]}
                >
                  Edit card
                </Text>
                <TouchableOpacity
                  style={styles.settingsIconButton}
                  onPress={closeEditor}
                  accessibilityRole="button"
                  accessibilityLabel="Close card editor"
                >
                  <Feather name="x" size={18} color={colors.foreground} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.formLabel, { color: colors.foreground }]}>
                Title
              </Text>
              <TextInput
                style={[
                  styles.editorInput,
                  { color: colors.foreground, borderColor: colors.border },
                ]}
                value={editorTitle}
                onChangeText={setEditorTitle}
                maxLength={280}
                accessibilityLabel="Task title"
                autoFocus
              />
              <Text style={[styles.formLabel, { color: colors.foreground }]}>
                Stage
              </Text>
              <View style={styles.choiceWrap}>
                {stages.map((stage) => (
                  <TouchableOpacity
                    key={stage.id}
                    style={[
                      styles.choiceChip,
                      {
                        borderColor:
                          editorStageId === stage.id
                            ? colors.primary
                            : colors.border,
                        backgroundColor:
                          editorStageId === stage.id
                            ? colors.secondary
                            : "transparent",
                      },
                    ]}
                    onPress={() => setEditorStageId(stage.id)}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: editorStageId === stage.id,
                    }}
                    accessibilityLabel={`Move card to ${stage.name}`}
                    aria-checked={editorStageId === stage.id}
                  >
                    <Feather
                      name={stage.isDone ? "check-circle" : "circle"}
                      size={12}
                      color={colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.choiceChipText,
                        { color: colors.foreground },
                      ]}
                    >
                      {stage.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              {fields.map((field) => (
                <View key={field.id} style={styles.editorField}>
                  <Text style={[styles.formLabel, { color: colors.foreground }]}>
                    {field.name}
                  </Text>
                  {field.type === "checkbox" ? (
                    <TouchableOpacity
                      style={[
                        styles.checkboxField,
                        { borderColor: colors.border },
                      ]}
                      onPress={() =>
                        setEditorValues((values) => ({
                          ...values,
                          [field.id]: values[field.id] !== true,
                        }))
                      }
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: editorValues[field.id] === true,
                      }}
                      accessibilityLabel={field.name}
                      aria-checked={editorValues[field.id] === true}
                    >
                      <Feather
                        name={
                          editorValues[field.id] === true
                            ? "check-square"
                            : "square"
                        }
                        size={17}
                        color={colors.foreground}
                      />
                      <Text
                        style={[
                          styles.checkboxFieldText,
                          { color: colors.foreground },
                        ]}
                      >
                        {editorValues[field.id] === true ? "Yes" : "No"}
                      </Text>
                    </TouchableOpacity>
                  ) : field.type === "single_select" ? (
                    <View style={styles.choiceWrap}>
                      <TouchableOpacity
                        style={[
                          styles.choiceChip,
                          { borderColor: colors.border },
                        ]}
                        onPress={() =>
                          setEditorValues((values) => ({
                            ...values,
                            [field.id]: "",
                          }))
                        }
                        accessibilityRole="radio"
                        accessibilityState={{
                          selected: !editorValues[field.id],
                        }}
                        accessibilityLabel={`Clear ${field.name}`}
                        aria-checked={!editorValues[field.id]}
                      >
                        <Text
                          style={[
                            styles.choiceChipText,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          None
                        </Text>
                      </TouchableOpacity>
                      {field.options.map((option) => (
                        <TouchableOpacity
                          key={option}
                          style={[
                            styles.choiceChip,
                            {
                              borderColor:
                                editorValues[field.id] === option
                                  ? colors.primary
                                  : colors.border,
                            },
                          ]}
                          onPress={() =>
                            setEditorValues((values) => ({
                              ...values,
                              [field.id]: option,
                            }))
                          }
                          accessibilityRole="radio"
                          accessibilityState={{
                            selected: editorValues[field.id] === option,
                          }}
                          accessibilityLabel={`Set ${field.name} to ${option}`}
                          aria-checked={editorValues[field.id] === option}
                        >
                          <Text
                            style={[
                              styles.choiceChipText,
                              { color: colors.foreground },
                            ]}
                          >
                            {option}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : (
                    <TextInput
                      style={[
                        styles.editorInput,
                        {
                          color: colors.foreground,
                          borderColor: colors.border,
                        },
                      ]}
                      value={
                        typeof editorValues[field.id] === "string"
                          ? String(editorValues[field.id])
                          : ""
                      }
                      onChangeText={(value) =>
                        setEditorValues((values) => ({
                          ...values,
                          [field.id]: value,
                        }))
                      }
                      keyboardType={
                        field.type === "number" ? "decimal-pad" : "default"
                      }
                      placeholder={
                        field.type === "date" ? "YYYY-MM-DD" : undefined
                      }
                      placeholderTextColor={colors.mutedForeground}
                      accessibilityLabel={field.name}
                      maxLength={field.type === "text" ? 1000 : 80}
                    />
                  )}
                </View>
              ))}
              {!!boardError && (
                <Text
                  style={[
                    styles.editorError,
                    { color: colors.destructive },
                  ]}
                  accessibilityRole="alert"
                >
                  {boardError}
                </Text>
              )}
              {pendingDeleteTaskId === editorTaskId ? (
                <View
                  style={[
                    styles.confirmPanel,
                    { borderColor: colors.destructive },
                  ]}
                >
                  <Text
                    style={[styles.confirmTitle, { color: colors.foreground }]}
                  >
                    Delete this card? This cannot be undone.
                  </Text>
                  <View style={styles.confirmActions}>
                    <TouchableOpacity
                      onPress={() => setPendingDeleteTaskId(null)}
                      accessibilityRole="button"
                    >
                      <Text
                        style={[
                          styles.textButton,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        Cancel
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={deleteEditedTask}
                      style={[
                        styles.destructiveButton,
                        { backgroundColor: colors.destructive },
                      ]}
                      accessibilityRole="button"
                      testID="confirm-delete-card"
                    >
                      <Text
                        style={[
                          styles.destructiveButtonText,
                          { color: colors.primaryForeground },
                        ]}
                      >
                        Delete card
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.deleteCardButton}
                  onPress={() => setPendingDeleteTaskId(editorTaskId)}
                  accessibilityRole="button"
                >
                  <Feather
                    name="trash-2"
                    size={14}
                    color={colors.destructive}
                  />
                  <Text
                    style={[
                      styles.deleteCardText,
                      { color: colors.destructive },
                    ]}
                  >
                    Delete card
                  </Text>
                </TouchableOpacity>
              )}
            </ScrollView>
            <View
              style={[
                styles.cardEditorFooter,
                { borderTopColor: colors.border },
              ]}
            >
              <TouchableOpacity
                onPress={closeEditor}
                style={styles.editorCancelButton}
                accessibilityRole="button"
              >
                <Text
                  style={[
                    styles.editorCancelText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={saveTask}
                style={[
                  styles.editorSaveButton,
                  { backgroundColor: colors.primary },
                ]}
                accessibilityRole="button"
                testID="save-card-button"
              >
                <Text
                  style={[
                    styles.editorSaveText,
                    { color: colors.primaryForeground },
                  ]}
                >
                  Save card
                </Text>
              </TouchableOpacity>
            </View>
          </RNAnimated.View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
function isValidCardDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
