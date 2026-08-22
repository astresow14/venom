import React, { useRef, useState } from "react";
import { Platform, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { type EdgeInsets } from "react-native-safe-area-context";
import {
  type VenomManagedModel,
  type VenomResponseMode,
} from "@workspace/api-client-react";
import { type BlendCorner, BlendPad } from "@/components/BlendPad";
import {
  MAX_MESSAGE_ATTACHMENTS,
} from "@/lib/chatFiles";
import {
  PendingAttachmentChips,
  type PendingChatFile,
} from "@/components/ChatFileCards";
import { ResponseModeSwitch } from "@/components/ResponseModeSwitch";
import { VoiceModeOverlay } from "@/components/voice/VoiceModeOverlay";
import {
  type BlendWeights,
  describeBlend,
  summarizeBlend,
} from "@/context/responsePrefs";
import {
  type VenomModelId,
  type VenomModelSelectionPolicy,
} from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { StyleSheet } from "react-native";
import { styles } from "./styles";

const composerLocal = StyleSheet.create({
  attachMenu: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 8,
    overflow: "hidden",
  },
  attachMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  attachMenuDivider: {
    width: 1,
    alignSelf: "stretch",
  },
  attachMenuText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
});

/**
 * The chat input area: response-mode switch, blend pad with corner picker,
 * shared-workspace chip, model selector, voice-mode launcher, unsynced
 * notice, pending attachments, and the text input with its stop / attach /
 * voice / send buttons. Pure composition — the send loop itself lives in
 * useChatSend, and blend/mode derivation stays with the workspace.
 */
export function ChatComposer({
  colors,
  insets,
  activeProject,
  deliberationAvailable,
  responseMode,
  onModeChange,
  blendCorners,
  padWeights,
  onPadChange,
  onPadCommit,
  cornersPickable,
  cornerCandidates,
  onCornerPick,
  enabledModels,
  activeModelId,
  onSelectModel,
  selectionPolicy,
  unsyncedNoticeText,
  pendingFiles,
  onRemovePendingFile,
  onPickFiles,
  onPickPhotos,
  inputRef,
  text,
  onChangeText,
  isStreaming,
  debateOnScreen,
  onStopDebate,
  onSend,
}: {
  colors: ReturnType<typeof useColors>;
  insets: EdgeInsets;
  activeProject: any;
  deliberationAvailable: boolean;
  responseMode: VenomResponseMode;
  onModeChange: (mode: VenomResponseMode) => void;
  blendCorners: [BlendCorner, BlendCorner, BlendCorner] | null;
  padWeights: BlendWeights;
  onPadChange: (weights: BlendWeights) => void;
  onPadCommit: (weights: BlendWeights) => void;
  cornersPickable: boolean;
  cornerCandidates: VenomManagedModel[];
  onCornerPick: (modelId: string) => void;
  enabledModels: VenomManagedModel[];
  activeModelId: VenomModelId;
  onSelectModel: (modelId: VenomModelId) => void;
  selectionPolicy: VenomModelSelectionPolicy;
  unsyncedNoticeText: string | null;
  pendingFiles: PendingChatFile[];
  onRemovePendingFile: (key: string) => void;
  onPickFiles: () => void;
  onPickPhotos: () => void;
  inputRef: React.RefObject<TextInput | null>;
  text: string;
  onChangeText: (value: string) => void;
  isStreaming: boolean;
  debateOnScreen: boolean;
  onStopDebate: () => void;
  onSend: () => void;
}) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showCornerPicker, setShowCornerPicker] = useState(false);
  // Device-local mixer visibility: entering Verify/Debate for the first time
  // shows the pad so it stays discoverable, and a collapse then sticks —
  // re-renders, streaming, and the next mode-eligible message never reopen
  // it. Talk's rules are untouched: it hides the whole section either way.
  const [mixerCollapsed, setMixerCollapsed] = useState(false);
  const [voiceModeOpen, setVoiceModeOpen] = useState(false);
  // A small inline menu (not Alert.alert) so the choice works on web too.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const voiceButtonRef = useRef<React.ComponentRef<typeof TouchableOpacity>>(
    null,
  );
  const blendCollapseRef = useRef<React.ComponentRef<typeof TouchableOpacity>>(
    null,
  );
  const blendSummaryRef = useRef<React.ComponentRef<typeof TouchableOpacity>>(
    null,
  );

  // Collapsing unmounts the control that was just pressed, so focus is
  // handed to its counterpart explicitly (web only) — the voice-overlay
  // handoff pattern — and never vanishes with the section.
  const focusAfterMixerToggle = (
    ref: React.RefObject<React.ComponentRef<typeof TouchableOpacity> | null>,
  ) => {
    if (Platform.OS !== "web") return;
    setTimeout(() => {
      (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
    }, 50);
  };

  const handleCollapseMixer = () => {
    setMixerCollapsed(true);
    // Folding the mixer puts the corner picker away too, so reopening
    // always starts from the pad itself.
    setShowCornerPicker(false);
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
    focusAfterMixerToggle(blendSummaryRef);
  };

  const handleExpandMixer = () => {
    setMixerCollapsed(false);
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
    focusAfterMixerToggle(blendCollapseRef);
  };

  return (
    <View
      style={[
        styles.inputContainer,
        {
          backgroundColor: colors.background,
          paddingBottom: Math.max(
            insets.bottom,
            Platform.OS === "web" ? 34 : 16,
          ),
        },
      ]}
    >
      {/* Response mode: Talk / Verify / Debate, remembered per session. */}
      {deliberationAvailable && (
        <View style={styles.modeSwitchRow}>
          <ResponseModeSwitch
            mode={responseMode}
            onChange={onModeChange}
            disabled={isStreaming}
          />
        </View>
      )}
      {/* Blend pad: who carries the exchange in Verify and Debate. The mixer
          is collapsible — the committed blend keeps applying while it's
          folded away, and the compact chip restates it until reopened. */}
      {deliberationAvailable &&
        responseMode !== "talk" &&
        blendCorners &&
        (mixerCollapsed ? (
          <View style={styles.blendCollapsedRow}>
            <TouchableOpacity
              ref={blendSummaryRef}
              onPress={handleExpandMixer}
              accessibilityRole="button"
              accessibilityState={{ expanded: false }}
              // accessibilityState.expanded never reaches the web DOM on
              // this RN Web version; mirror it the way the mode switch
              // mirrors aria-checked.
              aria-expanded={false}
              accessibilityLabel={`Show the blend mixer. ${describeBlend(
                padWeights,
                blendCorners.map((corner) => corner.name),
              )}.`}
              testID="button-blend-summary"
              hitSlop={6}
              style={[
                styles.blendSummaryChip,
                { borderColor: colors.border, backgroundColor: colors.card },
              ]}
            >
              <Feather
                name="sliders"
                size={11}
                color={colors.mutedForeground}
              />
              <Text
                style={[
                  styles.blendSummaryChipText,
                  { color: colors.foreground },
                ]}
                numberOfLines={1}
              >
                {summarizeBlend(
                  padWeights,
                  blendCorners.map((corner) => corner.name),
                )}
              </Text>
              <Feather
                name="chevron-up"
                size={12}
                color={colors.mutedForeground}
              />
            </TouchableOpacity>
          </View>
        ) : (
        <View style={styles.blendSection}>
          <BlendPad
            corners={blendCorners}
            weights={padWeights}
            onChange={onPadChange}
            onCommit={onPadCommit}
            disabled={isStreaming}
          />
          {cornersPickable && (
            <TouchableOpacity
              onPress={() => {
                setShowCornerPicker((value) => !value);
                if (Platform.OS !== "web") {
                  Haptics.selectionAsync();
                }
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: showCornerPicker }}
              aria-expanded={showCornerPicker}
              accessibilityLabel="Choose which three models take the corners"
              testID="button-blend-corners"
              hitSlop={6}
              style={styles.cornerPickerToggle}
            >
              <Text
                style={[
                  styles.cornerPickerToggleText,
                  { color: colors.mutedForeground },
                ]}
              >
                {showCornerPicker
                  ? "Done choosing voices"
                  : "Choose the three voices"}
              </Text>
            </TouchableOpacity>
          )}
          {cornersPickable && showCornerPicker && (
            <View style={styles.cornerPickerRow} testID="blend-corner-picker">
              {cornerCandidates.map((model) => {
                const inCorners = blendCorners.some(
                  (corner) => corner.id === model.id,
                );
                return (
                  <TouchableOpacity
                    key={model.id}
                    onPress={() => onCornerPick(model.id)}
                    disabled={inCorners}
                    style={[
                      styles.cornerPickChip,
                      {
                        borderColor: inCorners
                          ? colors.foreground
                          : colors.border,
                        backgroundColor: inCorners
                          ? colors.foreground
                          : colors.card,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: inCorners }}
                    accessibilityLabel={
                      inCorners
                        ? `${model.name} holds a corner`
                        : `Give ${model.name} a corner`
                    }
                    testID={`button-corner-pick-${model.id}`}
                    hitSlop={4}
                  >
                    <Text
                      style={[
                        styles.cornerPickChipText,
                        {
                          color: inCorners
                            ? colors.background
                            : colors.mutedForeground,
                        },
                      ]}
                    >
                      {model.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          <TouchableOpacity
            ref={blendCollapseRef}
            onPress={handleCollapseMixer}
            accessibilityRole="button"
            accessibilityState={{ expanded: true }}
            aria-expanded={true}
            accessibilityLabel="Hide the blend mixer"
            testID="button-blend-collapse"
            hitSlop={8}
            style={[
              styles.blendCollapseButton,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
          >
            <Feather
              name="chevron-down"
              size={14}
              color={colors.foreground}
            />
          </TouchableOpacity>
        </View>
        ))}
      {/* Model selector row. In auto policies the manual chips hand over to
          a single "Venom is choosing" indicator — the server owns the pick
          on every reply, and each reply is stamped with the model it ran. */}
      {selectionPolicy !== "manual" ? (
        <View style={styles.modelSelectorRow}>
          <View
            style={[
              styles.modelChip,
              styles.policyChip,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            accessibilityLabel={`Venom is choosing models automatically: ${
              selectionPolicy === "auto-cheapest"
                ? "cheapest healthy models"
                : "most capable models"
            }`}
            testID="composer-policy-takeover"
          >
            <Feather name="zap" size={11} color={colors.primary} />
            <Text
              style={[styles.modelChipText, { color: colors.mutedForeground }]}
            >
              Venom is choosing ·{" "}
              {selectionPolicy === "auto-cheapest"
                ? "Auto — cheapest"
                : "Auto — max power"}
            </Text>
          </View>
        </View>
      ) : enabledModels.length > 1 && (
        <View style={styles.modelSelectorRow}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.modelSelectorScroll}
          >
            {enabledModels.map((model) => {
              const isSelected = model.id === activeModelId;
              return (
                <TouchableOpacity
                  key={model.id}
                  onPress={() => {
                    onSelectModel(model.id as VenomModelId);
                    setShowModelPicker(false);
                  }}
                  style={[
                    styles.modelChip,
                    {
                      backgroundColor: isSelected ? colors.primary : colors.card,
                      borderColor: isSelected ? colors.primary : colors.border,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${model.name}`}
                  accessibilityState={{ selected: isSelected }}
                  testID={`select-model-${model.id}`}
                >
                  <Text
                    style={[
                      styles.modelChipText,
                      {
                        color: isSelected
                          ? colors.primaryForeground
                          : colors.mutedForeground,
                      },
                    ]}
                  >
                    {model.name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      <VoiceModeOverlay
        visible={voiceModeOpen}
        activeProject={activeProject}
        onClose={() => {
          setVoiceModeOpen(false);
          // An animated modal's focus trap can strand focus while closing;
          // hand it back to the launcher explicitly (web only).
          if (Platform.OS === "web") {
            setTimeout(() => {
              (
                voiceButtonRef.current as unknown as {
                  focus?: () => void;
                } | null
              )?.focus?.();
            }, 80);
          }
        }}
      />

      {!!unsyncedNoticeText && (
        <View
          style={[
            styles.unsyncedNotice,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          accessibilityLiveRegion="polite"
          testID="chat-unsynced-notice"
        >
          <Feather
            name="cloud-off"
            size={12}
            color={colors.mutedForeground}
          />
          <Text
            style={[
              styles.unsyncedNoticeText,
              { color: colors.mutedForeground },
            ]}
          >
            {unsyncedNoticeText}
          </Text>
        </View>
      )}

      <PendingAttachmentChips
        items={pendingFiles}
        onRemove={onRemovePendingFile}
        colors={colors}
      />
      {attachMenuOpen && (
        <View
          style={[
            composerLocal.attachMenu,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
          testID="attach-menu"
        >
          <TouchableOpacity
            style={composerLocal.attachMenuItem}
            onPress={() => {
              setAttachMenuOpen(false);
              onPickPhotos();
            }}
            accessibilityRole="button"
            accessibilityLabel="Attach from your photo library"
            testID="attach-pick-photo"
          >
            <Feather name="image" size={15} color={colors.foreground} />
            <Text
              style={[
                composerLocal.attachMenuText,
                { color: colors.foreground },
              ]}
            >
              Photo library
            </Text>
          </TouchableOpacity>
          <View
            style={[
              composerLocal.attachMenuDivider,
              { backgroundColor: colors.border },
            ]}
          />
          <TouchableOpacity
            style={composerLocal.attachMenuItem}
            onPress={() => {
              setAttachMenuOpen(false);
              onPickFiles();
            }}
            accessibilityRole="button"
            accessibilityLabel="Browse for a document"
            testID="attach-pick-file"
          >
            <Feather name="file-text" size={15} color={colors.foreground} />
            <Text
              style={[
                composerLocal.attachMenuText,
                { color: colors.foreground },
              ]}
            >
              Browse files
            </Text>
          </TouchableOpacity>
        </View>
      )}
      <View
        style={[
          styles.inputWrapper,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <TextInput
          ref={inputRef}
          testID="chat-input"
          accessibilityLabel="Message Venom"
          style={[styles.input, { color: colors.foreground }]}
          placeholder={
            debateOnScreen ? "Join the debate..." : "Message..."
          }
          placeholderTextColor={colors.mutedForeground}
          value={text}
          onChangeText={onChangeText}
          multiline
          maxLength={1000}
          blurOnSubmit={false}
        />
        {debateOnScreen && (
          <TouchableOpacity
            style={[styles.stopButton, { borderColor: colors.border }]}
            onPress={onStopDebate}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Stop the debate after this turn"
            testID="stop-debate"
          >
            <View
              style={[
                styles.stopButtonSquare,
                { backgroundColor: colors.foreground },
              ]}
            />
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[
            styles.voiceButton,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
          onPress={() => setAttachMenuOpen((open) => !open)}
          disabled={
            isStreaming || pendingFiles.length >= MAX_MESSAGE_ATTACHMENTS
          }
          hitSlop={12}
          testID="attach-file-button"
          accessibilityRole="button"
          accessibilityLabel="Attach photos or files"
          accessibilityState={{ expanded: attachMenuOpen }}
        >
          <Feather name="paperclip" size={16} color={colors.foreground} />
        </TouchableOpacity>
        <TouchableOpacity
          ref={voiceButtonRef}
          style={[
            styles.voiceButton,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
          onPress={() => setVoiceModeOpen(true)}
          disabled={isStreaming}
          hitSlop={12}
          testID="open-voice-mode"
          accessibilityRole="button"
          accessibilityLabel="Start a voice conversation"
        >
          <Feather name="mic" size={16} color={colors.foreground} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.sendButton,
            {
              backgroundColor:
                text.trim() ||
                pendingFiles.some((item) => item.status === "ready")
                  ? colors.primary
                  : colors.secondary,
            },
          ]}
          onPress={onSend}
          disabled={
            (!text.trim() &&
              !pendingFiles.some((item) => item.status === "ready")) ||
            pendingFiles.some((item) => item.status === "uploading") ||
            (isStreaming && !debateOnScreen)
          }
          hitSlop={12}
          testID="send-message-button"
          accessibilityRole="button"
          accessibilityLabel={
            debateOnScreen
              ? "Send a message into the debate"
              : "Send message"
          }
        >
          <Feather
            name="arrow-up"
            size={18}
            color={
              text.trim() ||
              pendingFiles.some((item) => item.status === "ready")
                ? colors.primaryForeground
                : colors.mutedForeground
            }
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}
