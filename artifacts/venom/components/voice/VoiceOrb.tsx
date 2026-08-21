/**
 * VoiceOrb.tsx — the living centerpiece of voice mode.
 *
 * A layered black mass with a white rim and a drifting sheen, morphing its
 * silhouette continuously (symbiote, not sci-fi): no waveforms, no rings of
 * bars. The mass visibly reacts to the conversation:
 *  - connecting: slow, dim breathing
 *  - listening:  rim brightens and swells with the user's voice
 *  - thinking:   silhouette tightens and churns faster
 *  - speaking:   the mass ripples with the streamed reply's loudness
 *  - error:      motion stops; a thin gray rim remains
 *
 * Levels arrive as Reanimated shared values so nothing re-renders per frame.
 */

import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import type { VoicePhase } from "@/hooks/useVoiceConversation";

type VoiceOrbProps = {
  phase: VoicePhase;
  inputLevel: SharedValue<number>;
  outputLevel: SharedValue<number>;
  size?: number;
};

const MORPH_DURATION: Record<string, number> = {
  idle: 7000,
  connecting: 7000,
  listening: 5200,
  transcribing: 3400,
  thinking: 2100,
  speaking: 3000,
  error: 0,
};

export function VoiceOrb({
  phase,
  inputLevel,
  outputLevel,
  size = 190,
}: VoiceOrbProps) {
  const reduceMotion = useReducedMotion();

  // Two independent morph loops give the silhouette a non-repeating wobble.
  const morphA = useSharedValue(0.5);
  const morphB = useSharedValue(0.5);
  const spin = useSharedValue(0);
  // Smoothed conversation level: input while listening, output while speaking.
  const energy = useSharedValue(0);
  // Phase as a number the UI thread can branch on cheaply.
  const phaseSv = useSharedValue(0);

  const phaseIndex =
    phase === "listening"
      ? 1
      : phase === "transcribing" || phase === "thinking"
        ? 2
        : phase === "speaking"
          ? 3
          : phase === "error"
            ? 4
            : 0;

  useEffect(() => {
    phaseSv.value = withTiming(phaseIndex, { duration: 420 });
  }, [phaseIndex, phaseSv]);

  useEffect(() => {
    const duration = MORPH_DURATION[phase] ?? 6000;
    cancelAnimation(morphA);
    cancelAnimation(morphB);
    cancelAnimation(spin);
    if (reduceMotion || duration === 0) {
      morphA.value = withTiming(0.5, { duration: 600 });
      morphB.value = withTiming(0.5, { duration: 600 });
      return;
    }
    morphA.value = withRepeat(
      withTiming(morphA.value > 0.5 ? 0 : 1, {
        duration,
        easing: Easing.inOut(Easing.sin),
      }),
      -1,
      true,
    );
    morphB.value = withRepeat(
      withTiming(morphB.value > 0.5 ? 0 : 1, {
        duration: Math.round(duration * 1.37),
        easing: Easing.inOut(Easing.quad),
      }),
      -1,
      true,
    );
    spin.value = withRepeat(
      withTiming(spin.value + 360, {
        duration: phase === "thinking" ? 9000 : 22_000,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
  }, [morphA, morphB, phase, reduceMotion, spin]);

  // Feed the smoothed energy value from whichever side is live.
  useAnimatedReaction(
    () => {
      const listening = phaseSv.value < 1.5 && phaseSv.value >= 0.5;
      const speaking = phaseSv.value >= 2.5 && phaseSv.value < 3.5;
      if (listening) return inputLevel.value;
      if (speaking) return outputLevel.value;
      return 0;
    },
    (target) => {
      energy.value = withTiming(Math.min(1, target * 1.4), { duration: 130 });
    },
  );

  const massStyle = useAnimatedStyle(() => {
    const base = size * 0.46;
    const amp = size * 0.11;
    const active = phaseSv.value >= 0.5 && phaseSv.value < 3.5;
    const scale =
      1 +
      energy.value * 0.16 +
      interpolate(phaseSv.value, [0, 1, 2, 3, 4], [0, 0.02, -0.05, 0.04, -0.02]);
    return {
      borderTopLeftRadius: base + amp * (morphA.value - 0.5) * 2,
      borderBottomRightRadius: base - amp * (morphA.value - 0.5) * 2,
      borderTopRightRadius: base + amp * (morphB.value - 0.5) * 1.6,
      borderBottomLeftRadius: base - amp * (morphB.value - 0.5) * 1.6,
      transform: [{ rotate: `${spin.value * 0.05}deg` }, { scale }],
      borderColor: `rgba(255,255,255,${active ? 0.34 + energy.value * 0.4 : 0.16})`,
    };
  });

  const haloStyle = useAnimatedStyle(() => {
    const base = size * 0.62;
    const amp = size * 0.07;
    const listening = phaseSv.value >= 0.5 && phaseSv.value < 1.5;
    return {
      borderTopLeftRadius: base - amp * (morphB.value - 0.5) * 2,
      borderBottomRightRadius: base + amp * (morphB.value - 0.5) * 2,
      borderTopRightRadius: base - amp * (morphA.value - 0.5) * 1.4,
      borderBottomLeftRadius: base + amp * (morphA.value - 0.5) * 1.4,
      opacity:
        phaseSv.value >= 3.5
          ? 0.22
          : 0.24 + energy.value * (listening ? 0.6 : 0.35),
      transform: [
        { rotate: `${-spin.value * 0.03}deg` },
        { scale: 1 + energy.value * (listening ? 0.24 : 0.1) },
      ],
    };
  });

  const sheenStyle = useAnimatedStyle(() => {
    const drift = size * 0.1;
    return {
      opacity: phaseSv.value >= 3.5 ? 0.05 : 0.1 + energy.value * 0.25,
      transform: [
        { translateX: (morphA.value - 0.5) * drift },
        { translateY: (morphB.value - 0.5) * drift * 1.4 },
        { rotate: `${spin.value * 0.08}deg` },
        { scale: 1 + energy.value * 0.3 },
      ],
    };
  });

  const coreStyle = useAnimatedStyle(() => {
    // The core brightens while thinking — a slow internal churn.
    const thinking = phaseSv.value >= 1.5 && phaseSv.value < 2.5;
    return {
      opacity: thinking ? 0.5 + (morphA.value - 0.5) * 0.35 : 0.14,
      transform: [{ scale: thinking ? 0.9 + morphB.value * 0.25 : 1 }],
    };
  });

  return (
    <View
      style={[styles.wrap, { width: size * 1.5, height: size * 1.5 }]}
      pointerEvents="none"
    >
      <Animated.View
        style={[
          styles.halo,
          { width: size * 1.24, height: size * 1.24 },
          haloStyle,
        ]}
      />
      <Animated.View
        style={[styles.mass, { width: size, height: size }, massStyle]}
      >
        <Animated.View
          style={[
            styles.sheen,
            {
              width: size * 0.34,
              height: size * 0.26,
              top: size * 0.14,
              left: size * 0.16,
              borderRadius: size * 0.2,
            },
            sheenStyle,
          ]}
        />
        <Animated.View
          style={[
            styles.core,
            {
              width: size * 0.16,
              height: size * 0.16,
              borderRadius: size * 0.08,
            },
            coreStyle,
          ]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
  },
  mass: {
    backgroundColor: "#0b0b0b",
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    shadowColor: "#ffffff",
    shadowOpacity: 0.12,
    shadowRadius: 42,
    shadowOffset: { width: 0, height: 0 },
    elevation: 12,
  },
  sheen: {
    position: "absolute",
    backgroundColor: "#f7f7f7",
  },
  core: {
    backgroundColor: "#f7f7f7",
  },
});
