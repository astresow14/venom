/**
 * VoiceModeOverlay.tsx — full-screen tap-to-talk voice conversation.
 *
 * Launched from the chat composer's mic button. Always the symbiote's own
 * near-black room regardless of theme: black mass orb center stage, a quiet
 * status word, the live transcript below, and a voice picker sheet. Tap the
 * orb once to start a recording and once more to send it. While a reply is
 * playing, tapping the orb stops it; voice never begins another recording
 * until the user asks it to.
 *
 * Failure states (mic denied, voice not configured, dropped connection) each
 * explain themselves and offer "Try again" / "Back to text" — voice mode
 * never hangs and never strands the conversation.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { VoiceOrb } from "@/components/voice/VoiceOrb";
import {
  VoicePresetList,
  VOICE_DARK_PALETTE,
} from "@/components/voice/VoicePresetList";
import {
  TalkativenessControl,
  TALKATIVENESS_DARK_PALETTE,
} from "@/components/voice/TalkativenessControl";
import {
  useVoiceConversation,
  type VoicePhase,
} from "@/hooks/useVoiceConversation";
import { useVoiceSample } from "@/hooks/useVoiceSample";
import { useVenom } from "@/context/VenomContext";
import { DEFAULT_VOICE_TALKATIVENESS } from "@/context/workspaceSync";

type ActiveProjectLike = {
  id: string;
  name?: string;
  description?: string;
} | null;

type VoiceModeOverlayProps = {
  visible: boolean;
  activeProject: ActiveProjectLike;
  onClose: () => void;
};

const BACKDROP = "#050505";
const PANEL = "#0d0d0d";
const LINE = "#242424";
const INK = "#f5f5f2";
const MUTED = "#8f8f8b";

function statusLine(
  phase: VoicePhase,
  voiceName: string | null,
  userSpeaking: boolean,
): string {
  switch (phase) {
    case "connecting":
      return "waking up…";
    case "idle":
      return "tap to talk";
    case "listening":
      return userSpeaking ? "recording" : "recording — tap to send";
    case "transcribing":
      return "got it…";
    case "thinking":
      return "thinking…";
    case "speaking":
      return voiceName ? `${voiceName} is speaking` : "speaking";
    case "error":
      return "voice paused";
    default:
      return "";
  }
}

export function VoiceModeOverlay({
  visible,
  activeProject,
  onClose,
}: VoiceModeOverlayProps) {
  const insets = useSafeAreaInsets();
  const voice = useVoiceConversation(activeProject);
  const sample = useVoiceSample();
  const { state, setVoiceTalkativeness } = useVenom();
  const talkativeness =
    state.voicePreferences?.talkativeness ?? DEFAULT_VOICE_TALKATIVENESS;
  const [pickerOpen, setPickerOpen] = useState(false);
  const transcriptRef = useRef<ScrollView>(null);
  const closingRef = useRef(false);

  const {
    phase,
    error,
    notice,
    endedQuietly,
    userSpeaking,
    liveUserText,
    liveAssistantText,
    transcript,
    inputLevel,
    outputLevel,
    presets,
    activePresetId,
    activePreset,
    selectPreset,
    begin,
    end,
    interrupt,
    toggleRecording,
    retry,
  } = voice;

  // One session per open. Closing tears the loop down and files partials.
  // begin/end are reached through refs: their identities change with every
  // context re-render (each filed message), and a dependency on them would
  // tear down and restart the session mid-conversation.
  const beginRef = useRef(begin);
  const endRef = useRef(end);
  useEffect(() => {
    beginRef.current = begin;
    endRef.current = end;
  });
  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      setPickerOpen(false);
      void beginRef.current();
      return () => {
        endRef.current();
      };
    }
    return undefined;
  }, [visible]);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    sample.stopSample();
    end();
    onClose();
  }, [end, onClose, sample]);

  // Wind-down: after a goodbye and a stretch of quiet the session ends
  // itself; the overlay simply slips away — no "are you still there?".
  useEffect(() => {
    if (visible && endedQuietly) handleClose();
  }, [visible, endedQuietly, handleClose]);

  // Escape leaves voice mode (or closes the picker first) on web.
  useEffect(() => {
    if (!visible || Platform.OS !== "web") return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (pickerOpen) {
        setPickerOpen(false);
      } else {
        handleClose();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [visible, pickerOpen, handleClose]);

  // Keep the transcript pinned to the latest words.
  useEffect(() => {
    const timer = setTimeout(
      () => transcriptRef.current?.scrollToEnd({ animated: true }),
      50,
    );
    return () => clearTimeout(timer);
  }, [transcript, liveAssistantText, liveUserText]);

  const orbPressable =
    phase === "idle" ||
    phase === "listening" ||
    phase === "speaking" ||
    phase === "thinking";
  const orbLabel =
    phase === "listening"
      ? "Stop recording and send"
      : phase === "speaking" || phase === "thinking"
        ? "Stop reply"
        : phase === "idle"
          ? "Start recording"
          : statusLine(phase, activePreset?.name ?? null, userSpeaking) ||
            "Voice mode";
  const handleOrbPress = () => {
    if (phase === "listening" || phase === "idle") {
      void toggleRecording();
    } else if (phase === "speaking" || phase === "thinking") {
      interrupt();
    }
  };

  const showLiveAssistant =
    liveAssistantText.length > 0 &&
    (phase === "thinking" || phase === "speaking");
  const showLiveUser =
    liveUserText !== null &&
    (phase === "transcribing" || phase === "thinking" || phase === "speaking");

  return (
    <Modal
      visible={visible}
      animationType={Platform.OS === "web" ? "none" : "fade"}
      transparent={false}
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View
        style={[styles.root, { paddingTop: insets.top + 10 }]}
        accessibilityViewIsModal
        testID="voice-mode-overlay"
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleClose}
            style={styles.headerButton}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Exit voice mode"
            testID="voice-mode-close"
          >
            <Feather name="x" size={20} color={INK} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>voice</Text>
          <TouchableOpacity
            onPress={() => setPickerOpen((open) => !open)}
            style={[styles.voiceChip, pickerOpen && styles.voiceChipOpen]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Voice: ${activePreset?.name ?? "default"}. Change voice`}
            testID="voice-preset-chip"
          >
            <Text style={styles.voiceChipText}>
              {activePreset?.name ?? "Voice"}
            </Text>
            <Feather name="chevron-down" size={13} color={MUTED} />
          </TouchableOpacity>
        </View>

        {/* Center stage */}
        {error ? (
          <View style={styles.errorWrap} testID="voice-error-panel">
            <VoiceOrb
              phase="error"
              inputLevel={inputLevel}
              outputLevel={outputLevel}
              size={130}
            />
            <Text style={styles.errorTitle}>
              {error.kind === "mic"
                ? "Mic is off"
                : error.kind === "unavailable"
                  ? "Voice isn't set up"
                  : error.kind === "unsupported"
                    ? "No voice on this device"
                    : "Connection dropped"}
            </Text>
            <Text style={styles.errorMessage} testID="voice-error-message">
              {error.message}
            </Text>
            <View style={styles.errorActions}>
              {error.kind !== "unsupported" && (
                <TouchableOpacity
                  onPress={retry}
                  style={styles.errorPrimary}
                  accessibilityRole="button"
                  accessibilityLabel="Try voice again"
                  testID="voice-error-retry"
                >
                  <Text style={styles.errorPrimaryText}>Try again</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={handleClose}
                style={styles.errorSecondary}
                accessibilityRole="button"
                accessibilityLabel="Back to text chat"
                testID="voice-error-exit"
              >
                <Text style={styles.errorSecondaryText}>Back to text</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.stage}>
            <TouchableOpacity
              activeOpacity={orbPressable ? 0.7 : 1}
              onPress={orbPressable ? handleOrbPress : undefined}
              disabled={!orbPressable}
              accessibilityRole="button"
              accessibilityLabel={orbLabel}
              testID="voice-orb-press"
            >
              <VoiceOrb
                phase={phase}
                inputLevel={inputLevel}
                outputLevel={outputLevel}
              />
            </TouchableOpacity>
            <Text style={styles.status} testID="voice-status">
              {statusLine(phase, activePreset?.name ?? null, userSpeaking)}
            </Text>
            {phase === "idle" && (
              <Text style={styles.hint}>tap the mass to talk</Text>
            )}
            {phase === "listening" && (
              <Text style={styles.hint}>tap again when you’re done</Text>
            )}
            {phase === "speaking" && (
              <Text style={styles.hint}>tap the mass to stop the reply</Text>
            )}
            {notice && (
              <Text style={styles.notice} testID="voice-notice">
                {notice}
              </Text>
            )}
          </View>
        )}

        {/* Live transcript */}
        {!error && (
          <View style={styles.transcriptWrap}>
            <ScrollView
              ref={transcriptRef}
              style={styles.transcript}
              contentContainerStyle={styles.transcriptContent}
              showsVerticalScrollIndicator={false}
              testID="voice-transcript"
            >
              {transcript.map((entry) => (
                <View
                  key={entry.id}
                  style={[
                    styles.bubble,
                    entry.role === "user"
                      ? styles.bubbleUser
                      : styles.bubbleAssistant,
                  ]}
                  testID={`voice-transcript-${entry.role}`}
                >
                  <Text
                    style={
                      entry.role === "user"
                        ? styles.bubbleUserText
                        : styles.bubbleAssistantText
                    }
                  >
                    {entry.text}
                  </Text>
                </View>
              ))}
              {showLiveUser && (
                <View
                  style={[styles.bubble, styles.bubbleUser]}
                  testID="voice-live-user"
                >
                  <Text style={styles.bubbleUserText}>{liveUserText}</Text>
                </View>
              )}
              {showLiveAssistant && (
                <View
                  style={[styles.bubble, styles.bubbleAssistant]}
                  testID="voice-live-assistant"
                >
                  <Text style={styles.bubbleAssistantText}>
                    {liveAssistantText}
                  </Text>
                </View>
              )}
            </ScrollView>
          </View>
        )}

        {/* Voice picker sheet */}
        {pickerOpen && !error && (
          <>
            <TouchableOpacity
              style={styles.sheetBackdrop}
              activeOpacity={1}
              onPress={() => setPickerOpen(false)}
              accessibilityLabel="Close voice picker"
            />
            <View
              style={[
                styles.sheet,
                { paddingBottom: Math.max(insets.bottom, 16) },
              ]}
              testID="voice-picker-sheet"
            >
              <View style={styles.sheetHandleRow}>
                <Text style={styles.sheetTitle}>Voices</Text>
                <TouchableOpacity
                  onPress={() => setPickerOpen(false)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel="Close voice picker"
                  testID="voice-picker-close"
                >
                  <Feather name="chevron-down" size={18} color={MUTED} />
                </TouchableOpacity>
              </View>
              <ScrollView
                style={styles.sheetList}
                showsVerticalScrollIndicator={false}
              >
                <VoicePresetList
                  presets={presets}
                  selectedId={activePresetId}
                  onSelect={(id) => selectPreset(id)}
                  onPreview={(preset) =>
                    sample.playSample(preset.id, preset.sampleText)
                  }
                  previewingId={sample.previewingId}
                  palette={VOICE_DARK_PALETTE}
                />
                {sample.sampleError && (
                  <Text style={styles.sampleError} testID="voice-sample-error">
                    {sample.sampleError}
                  </Text>
                )}
                <View style={styles.talkativenessBlock}>
                  <Text style={styles.talkativenessTitle}>Talkativeness</Text>
                  <TalkativenessControl
                    value={talkativeness}
                    onChange={setVoiceTalkativeness}
                    palette={TALKATIVENESS_DARK_PALETTE}
                  />
                </View>
              </ScrollView>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BACKDROP,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 6,
  },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: MUTED,
    fontSize: 12,
    letterSpacing: 3,
    textTransform: "uppercase",
  },
  voiceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: PANEL,
  },
  voiceChipOpen: {
    borderColor: INK,
  },
  voiceChipText: {
    color: INK,
    fontSize: 13,
    fontWeight: "600",
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  status: {
    color: INK,
    fontSize: 15,
    letterSpacing: 0.4,
    marginTop: 2,
  },
  hint: {
    color: MUTED,
    fontSize: 12.5,
  },
  notice: {
    color: MUTED,
    fontSize: 13,
    marginTop: 6,
    paddingHorizontal: 32,
    textAlign: "center",
  },
  transcriptWrap: {
    maxHeight: "32%",
    borderTopWidth: 1,
    borderTopColor: LINE,
    backgroundColor: "#070707",
  },
  transcript: {
    paddingHorizontal: 16,
  },
  transcriptContent: {
    paddingVertical: 14,
    gap: 8,
  },
  bubble: {
    maxWidth: "84%",
    borderRadius: 16,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: INK,
  },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: PANEL,
    borderWidth: 1,
    borderColor: LINE,
  },
  bubbleUserText: {
    color: "#0a0a09",
    fontSize: 14.5,
    lineHeight: 20,
  },
  bubbleAssistantText: {
    color: INK,
    fontSize: 14.5,
    lineHeight: 20,
  },
  errorWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
    gap: 8,
  },
  errorTitle: {
    color: INK,
    fontSize: 19,
    fontWeight: "700",
    marginTop: 8,
  },
  errorMessage: {
    color: MUTED,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
  },
  errorPrimary: {
    backgroundColor: INK,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  errorPrimaryText: {
    color: "#0a0a09",
    fontSize: 14,
    fontWeight: "600",
  },
  errorSecondary: {
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 999,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  errorSecondaryText: {
    color: INK,
    fontSize: 14,
    fontWeight: "600",
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: PANEL,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: LINE,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: "62%",
  },
  sheetHandleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  sheetTitle: {
    color: INK,
    fontSize: 16,
    fontWeight: "700",
  },
  sheetList: {
    flexGrow: 0,
  },
  sampleError: {
    color: MUTED,
    fontSize: 12.5,
    marginTop: 2,
    marginBottom: 10,
  },
  talkativenessBlock: {
    borderTopWidth: 1,
    borderTopColor: LINE,
    marginTop: 12,
    paddingTop: 14,
    paddingBottom: 8,
  },
  talkativenessTitle: {
    color: INK,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 10,
  },
});
