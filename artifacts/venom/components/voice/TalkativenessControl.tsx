/**
 * TalkativenessControl.tsx — the chatty ↔ reserved dial for voice mode,
 * shared between Settings and the in-voice-mode sheet.
 *
 * Three segments on one axis: how eager Venom is to speak when a remark
 * doesn't clearly call for an answer. Direct questions always get a full
 * reply at every level — this only tunes what happens to trailing remarks,
 * asides, and wind-downs. The selection is synced workspace state, so it
 * follows the account across devices.
 */

import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import type { VenomVoiceTalkativeness } from "@/context/VenomContext";
import {
  TALKATIVENESS_OPTIONS,
  talkativenessOption,
} from "@/hooks/voiceRestraint";

type Palette = {
  segmentBackground: string;
  segmentBorder: string;
  selectedBackground: string;
  selectedText: string;
  text: string;
  description: string;
};

/** Fixed near-black palette for the voice-mode sheet. */
export const TALKATIVENESS_DARK_PALETTE: Palette = {
  segmentBackground: "#101010",
  segmentBorder: "#242424",
  selectedBackground: "#f5f5f2",
  selectedText: "#0a0a09",
  text: "#9a9a96",
  description: "#9a9a96",
};

type TalkativenessControlProps = {
  value: VenomVoiceTalkativeness;
  onChange: (level: VenomVoiceTalkativeness) => void;
  palette: Palette;
};

export function TalkativenessControl({
  value,
  onChange,
  palette,
}: TalkativenessControlProps) {
  const active = talkativenessOption(value);
  return (
    <View testID="voice-talkativeness-control">
      <View
        style={styles.row}
        accessibilityRole="radiogroup"
        accessibilityLabel="Talkativeness"
      >
        {TALKATIVENESS_OPTIONS.map((option) => {
          const selected = option.id === value;
          return (
            <TouchableOpacity
              key={option.id}
              onPress={() => onChange(option.id)}
              style={[
                styles.segment,
                {
                  backgroundColor: selected
                    ? palette.selectedBackground
                    : palette.segmentBackground,
                  borderColor: selected
                    ? palette.selectedBackground
                    : palette.segmentBorder,
                },
              ]}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={`${option.label}. ${option.description}`}
              testID={`voice-talkativeness-${option.id}`}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  { color: selected ? palette.selectedText : palette.text },
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text
        style={[styles.description, { color: palette.description }]}
        testID="voice-talkativeness-description"
      >
        {active.description}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 8,
  },
  segment: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 9,
    alignItems: "center",
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  description: {
    fontSize: 12.5,
    lineHeight: 17,
    marginTop: 8,
  },
});
