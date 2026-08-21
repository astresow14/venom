/**
 * VoicePresetList.tsx — the named voice picker, shared between Settings and
 * the in-voice-mode sheet. Each row: name, persona, a tap-to-hear preview,
 * and radio-style selection. Selection is synced workspace state, so the
 * chosen voice follows the account across devices.
 */

import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import type { VenomVoicePresetId } from "@/context/VenomContext";
import type { VoiceCatalogPreset } from "@/hooks/useVoiceConversation";

type Palette = {
  rowBackground: string;
  rowBorder: string;
  selectedBorder: string;
  name: string;
  persona: string;
  icon: string;
  radioOn: string;
  radioOff: string;
};

/** Fixed near-black palette for the voice-mode sheet. */
export const VOICE_DARK_PALETTE: Palette = {
  rowBackground: "#101010",
  rowBorder: "#242424",
  selectedBorder: "#f5f5f2",
  name: "#f5f5f2",
  persona: "#9a9a96",
  icon: "#f5f5f2",
  radioOn: "#f5f5f2",
  radioOff: "#4a4a48",
};

type VoicePresetListProps = {
  presets: VoiceCatalogPreset[];
  selectedId: VenomVoicePresetId;
  onSelect: (id: VenomVoicePresetId) => void;
  onPreview: (preset: VoiceCatalogPreset) => void;
  previewingId: VenomVoicePresetId | null;
  palette: Palette;
  /** Disables the preview buttons (e.g. voice not configured). */
  previewsDisabled?: boolean;
};

export function VoicePresetList({
  presets,
  selectedId,
  onSelect,
  onPreview,
  previewingId,
  palette,
  previewsDisabled = false,
}: VoicePresetListProps) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Voice presets">
      {presets.map((preset) => {
        const selected = preset.id === selectedId;
        const previewing = previewingId === preset.id;
        return (
          <TouchableOpacity
            key={preset.id}
            onPress={() => onSelect(preset.id as VenomVoicePresetId)}
            style={[
              styles.row,
              {
                backgroundColor: palette.rowBackground,
                borderColor: selected
                  ? palette.selectedBorder
                  : palette.rowBorder,
              },
            ]}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={`Voice ${preset.name}. ${preset.persona}`}
            testID={`voice-preset-${preset.id}`}
          >
            <View
              style={[
                styles.radio,
                {
                  borderColor: selected ? palette.radioOn : palette.radioOff,
                },
              ]}
            >
              {selected && (
                <View
                  style={[styles.radioDot, { backgroundColor: palette.radioOn }]}
                />
              )}
            </View>
            <View style={styles.textBlock}>
              <View style={styles.nameRow}>
                <Text style={[styles.name, { color: palette.name }]}>
                  {preset.name}
                </Text>
                <Text style={[styles.tone, { color: palette.persona }]}>
                  {preset.tone}
                </Text>
              </View>
              <Text
                style={[styles.persona, { color: palette.persona }]}
                numberOfLines={2}
              >
                {preset.persona}
              </Text>
            </View>
            <TouchableOpacity
              onPress={(event) => {
                event.stopPropagation?.();
                onPreview(preset);
              }}
              disabled={previewsDisabled}
              hitSlop={10}
              style={[
                styles.previewButton,
                {
                  borderColor: palette.rowBorder,
                  opacity: previewsDisabled ? 0.35 : 1,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                previewing
                  ? `Stop ${preset.name} sample`
                  : `Hear a sample of ${preset.name}`
              }
              testID={`voice-preview-${preset.id}`}
            >
              <Feather
                name={previewing ? "square" : "play"}
                size={14}
                color={palette.icon}
              />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
    gap: 12,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  textBlock: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
  },
  name: {
    fontSize: 15,
    fontWeight: "600",
  },
  tone: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  persona: {
    fontSize: 12.5,
    lineHeight: 17,
  },
  previewButton: {
    width: 34,
    height: 34,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
