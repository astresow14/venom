import React, { useCallback, useEffect, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  Easing,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { useColors } from "@/hooks/useColors";
import type { VenomResponseMode } from "@workspace/api-client-react";

const MODES: Array<{ mode: VenomResponseMode; label: string; hint: string }> = [
  { mode: "talk", label: "Talk", hint: "One assistant answers" },
  { mode: "verify", label: "Verify", hint: "Voices check the answer in the background" },
  { mode: "debate", label: "Debate", hint: "Voices argue it out in the thread" },
];

/**
 * Three-position response-mode switch: Talk / Verify / Debate. A quiet
 * monochrome segmented control whose thumb settles organically under the
 * selected mode. Selection is remembered per conversation by the caller.
 */
export function ResponseModeSwitch({
  mode,
  onChange,
  disabled = false,
}: {
  mode: VenomResponseMode;
  onChange: (mode: VenomResponseMode) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const selectedIndex = Math.max(
    0,
    MODES.findIndex((entry) => entry.mode === mode),
  );
  const position = useSharedValue(selectedIndex);

  useEffect(() => {
    if (reduceMotion) {
      position.value = selectedIndex;
      return;
    }
    position.value = withTiming(selectedIndex, {
      duration: 320,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
    });
  }, [selectedIndex, reduceMotion, position]);

  const segmentWidth = trackWidth > 0 ? trackWidth / MODES.length : 0;
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: position.value * segmentWidth }],
  }));

  const handleSelect = useCallback(
    (next: VenomResponseMode) => {
      if (disabled || next === mode) return;
      if (Platform.OS !== "web") {
        Haptics.selectionAsync();
      }
      onChange(next);
    },
    [disabled, mode, onChange],
  );

  return (
    <View
      style={[
        styles.track,
        { borderColor: colors.border, backgroundColor: colors.card },
        disabled && styles.disabled,
      ]}
      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width - 4)}
      accessibilityRole="radiogroup"
      accessibilityLabel="Response mode"
      testID="mode-switch"
    >
      {segmentWidth > 0 && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              width: segmentWidth,
              backgroundColor: colors.foreground,
            },
            thumbStyle,
          ]}
        />
      )}
      {MODES.map((entry) => {
        const selected = entry.mode === mode;
        return (
          <TouchableOpacity
            key={entry.mode}
            style={styles.segment}
            onPress={() => handleSelect(entry.mode)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled }}
            aria-checked={selected}
            accessibilityLabel={`${entry.label}: ${entry.hint}`}
            testID={`mode-option-${entry.mode}`}
            hitSlop={6}
          >
            <Text
              style={[
                styles.segmentLabel,
                {
                  color: selected ? colors.background : colors.mutedForeground,
                },
              ]}
            >
              {entry.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: "row",
    alignItems: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    padding: 2,
    position: "relative",
    overflow: "hidden",
  },
  thumb: {
    position: "absolute",
    top: 2,
    bottom: 2,
    left: 2,
    borderRadius: 999,
  },
  segment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  segmentLabel: {
    fontSize: 12.5,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  disabled: {
    opacity: 0.5,
  },
});
