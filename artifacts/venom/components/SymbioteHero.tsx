import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useBackdropActivity } from '@/components/SymbioteAuthBackdrop';
import { useColors } from '@/hooks/useColors';

type SymbioteHeroProps = {
  /** Square edge of the hero, in px. */
  size: number;
};

/**
 * The living centerpiece of the welcome screen: a breathing black symbiote
 * mass tagged over with white marker scrawl — raw strokes, whips, and a slow
 * drip. Purely decorative; it never captures pointer events or a11y focus.
 */
export function SymbioteHero({ size }: SymbioteHeroProps) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const isActive = useBackdropActivity();
  const motionAllowed = isActive && !reduceMotion;

  const breath = useSharedValue(0);
  const sway = useSharedValue(0);
  const drip = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(sway);
    cancelAnimation(drip);

    if (!motionAllowed) {
      breath.value = 0;
      sway.value = 0;
      drip.value = 0;
      return;
    }

    breath.value = withRepeat(
      withTiming(1, { duration: 5400, easing: Easing.inOut(Easing.cubic) }),
      -1,
      true,
    );
    sway.value = withRepeat(
      withTiming(1, { duration: 9200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
    drip.value = withRepeat(
      withDelay(1600, withTiming(1, { duration: 2600, easing: Easing.in(Easing.quad) })),
      -1,
      false,
    );

    return () => {
      cancelAnimation(breath);
      cancelAnimation(sway);
      cancelAnimation(drip);
    };
  }, [breath, drip, motionAllowed, sway]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + breath.value * 0.35,
    transform: [{ scale: 1 + breath.value * 0.05 }],
  }));

  const massStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(sway.value, [0, 1], [-3.5, 3.5])}deg` },
      { scale: 1 + breath.value * 0.045 },
    ],
  }));

  const massInnerStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(sway.value, [0, 1], [4, -5])}deg` },
      { scale: 1.02 - breath.value * 0.05 },
      { translateY: breath.value * size * 0.012 },
    ],
  }));

  const scrawlStyle = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${interpolate(sway.value, [0, 1], [1.6, -1.6])}deg` },
      { translateY: interpolate(breath.value, [0, 1], [2, -3]) },
    ],
  }));

  const dripStyle = useAnimatedStyle(() => ({
    opacity: motionAllowed
      ? interpolate(drip.value, [0, 0.12, 0.8, 1], [0, 0.9, 0.5, 0])
      : 0.35,
    transform: [{ translateY: drip.value * size * 0.055 }],
  }));

  const dropletAStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(breath.value, [0, 1], [3, -4]) },
      { translateX: interpolate(sway.value, [0, 1], [-2, 3]) },
    ],
  }));

  const dropletBStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(breath.value, [0, 1], [-3, 4]) },
      { translateX: interpolate(sway.value, [0, 1], [2, -3]) },
    ],
  }));

  const s = size;
  const stroke = colors.symbioteHighlight;

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: s,
        height: s,
        alignSelf: 'center',
        pointerEvents: 'none',
      }}
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * 0.08,
            top: s * 0.1,
            width: s * 0.84,
            height: s * 0.8,
            borderRadius: s * 0.42,
            backgroundColor: colors.symbioteGlow,
          },
          haloStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * 0.11,
            top: s * 0.18,
            width: s * 0.78,
            height: s * 0.64,
            backgroundColor: colors.symbiotePanel,
            borderWidth: 1.5,
            borderColor: 'rgba(247, 247, 247, 0.15)',
            borderTopLeftRadius: s * 0.26,
            borderTopRightRadius: s * 0.36,
            borderBottomRightRadius: s * 0.22,
            borderBottomLeftRadius: s * 0.34,
          },
          massStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * 0.22,
            top: s * 0.24,
            width: s * 0.56,
            height: s * 0.5,
            backgroundColor: colors.symbioteSurface,
            borderWidth: 1,
            borderColor: 'rgba(247, 247, 247, 0.1)',
            borderTopLeftRadius: s * 0.3,
            borderTopRightRadius: s * 0.2,
            borderBottomRightRadius: s * 0.28,
            borderBottomLeftRadius: s * 0.18,
          },
          massInnerStyle,
        ]}
      />
      <Animated.View style={[StyleSheet.absoluteFillObject, scrawlStyle]}>
        <Svg width={s} height={s} viewBox="0 0 220 220">
          {/* open hand-drawn loop, tail crossing its own start */}
          <Path
            d="M100 18 C 158 6 204 52 201 110 C 198 164 152 204 100 203 C 50 202 16 158 19 106 C 22 60 54 24 118 14"
            stroke={stroke}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            opacity={0.35}
          />
          {/* main strike strokes — the V */}
          <Path
            d="M50 38 C 62 88 82 138 104 174"
            stroke={stroke}
            strokeWidth={11}
            strokeLinecap="round"
            fill="none"
          />
          <Path
            d="M104 174 C 118 132 142 84 172 40"
            stroke={stroke}
            strokeWidth={11}
            strokeLinecap="round"
            fill="none"
          />
          {/* marker echoes */}
          <Path
            d="M58 34 C 70 84 90 132 108 168"
            stroke={stroke}
            strokeWidth={3.2}
            strokeLinecap="round"
            fill="none"
            opacity={0.5}
          />
          <Path
            d="M110 170 C 126 128 148 82 180 36"
            stroke={stroke}
            strokeWidth={3.2}
            strokeLinecap="round"
            fill="none"
            opacity={0.5}
          />
          {/* tendril whips */}
          <Path
            d="M172 40 C 180 28 188 30 198 20"
            stroke={stroke}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            opacity={0.85}
          />
          <Path
            d="M50 38 C 42 26 34 28 24 18"
            stroke={stroke}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            opacity={0.85}
          />
          <Path
            d="M104 174 C 101 188 107 196 100 208"
            stroke={stroke}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            opacity={0.85}
          />
          <Path
            d="M46 150 C 32 158 26 170 14 174"
            stroke={stroke}
            strokeWidth={3}
            strokeLinecap="round"
            fill="none"
            opacity={0.6}
          />
          <Circle cx={100} cy={214} r={3} fill={stroke} opacity={0.9} />
        </Svg>
      </Animated.View>
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * (98 / 220),
            top: s * (216 / 220),
            width: s * 0.02,
            height: s * 0.02,
            borderRadius: s * 0.01,
            backgroundColor: colors.symbioteHighlight,
          },
          dripStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * 0.87,
            top: s * 0.3,
            width: s * 0.045,
            height: s * 0.045,
            borderRadius: s * 0.0225,
            backgroundColor: colors.symbiotePanel,
            borderWidth: 1,
            borderColor: 'rgba(247, 247, 247, 0.28)',
          },
          dropletAStyle,
        ]}
      />
      <Animated.View
        style={[
          {
            position: 'absolute',
            left: s * 0.05,
            top: s * 0.6,
            width: s * 0.03,
            height: s * 0.03,
            borderRadius: s * 0.015,
            backgroundColor: colors.symbiotePanel,
            borderWidth: 1,
            borderColor: 'rgba(247, 247, 247, 0.22)',
          },
          dropletBStyle,
        ]}
      />
    </View>
  );
}
