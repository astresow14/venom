import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import {
  VENOM_WORDMARK_RATIO,
  VenomWordmark,
} from '@/components/VenomWordmark';

/**
 * One-time left-to-right "tagging" wipe for the scrawled VENOM wordmark
 * (auth brand row). The mark is revealed as if being swiped on, then rests
 * as the exact static wordmark — no loop.
 *
 * Implemented as two counter-translating views inside an overflow-hidden
 * frame so it behaves identically on iOS, Android, and web (no SVG masks,
 * transforms only). The outer frame reserves the final size from the first
 * frame, so nothing shifts while the wipe plays. Under reduced motion the
 * finished wordmark renders immediately.
 */

type VenomWordmarkRevealProps = {
  color: string;
  height?: number;
  /** Delay before the wipe starts, in ms. */
  delay?: number;
  accessibilityLabel?: string;
};

export function VenomWordmarkReveal({
  color,
  height = 32,
  delay = 0,
  accessibilityLabel = 'Venom',
}: VenomWordmarkRevealProps) {
  const reduceMotion = useReducedMotion();
  const width = Math.round(height * VENOM_WORDMARK_RATIO);
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }),
    );
  }, [delay, progress, reduceMotion]);

  // The clip window slides right while its content slides left by the same
  // amount, so the artwork stays visually pinned and only the revealed
  // region grows.
  const clipStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.value - 1) * width }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (1 - progress.value) * width }],
  }));

  return (
    <View style={{ width, height, overflow: 'hidden' }}>
      <Animated.View
        style={[{ width, height, overflow: 'hidden' }, clipStyle]}
      >
        <Animated.View style={[{ width, height }, contentStyle]}>
          <VenomWordmark
            color={color}
            height={height}
            accessibilityLabel={accessibilityLabel}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}
