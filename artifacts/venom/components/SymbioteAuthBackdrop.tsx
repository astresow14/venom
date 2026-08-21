import React, { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Platform,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';

type ViewPointerMoveEvent = Parameters<
  NonNullable<React.ComponentProps<typeof View>['onPointerMove']>
>[0];
type ViewTouchMoveEvent = Parameters<
  NonNullable<React.ComponentProps<typeof View>['onTouchMove']>
>[0];

type SymbioteInteraction = {
  onPointerMove: (event: ViewPointerMoveEvent) => void;
  onTouchMove: (event: ViewTouchMoveEvent) => void;
  onTouchEnd: () => void;
  pointerX: SharedValue<number>;
  pointerY: SharedValue<number>;
};

type SymbioteAuthBackdropProps = Pick<
  SymbioteInteraction,
  'pointerX' | 'pointerY'
>;
type TendrilStyle = StyleProp<ViewStyle>;

function clampPosition(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Whether ambient looping motion should run: the app is foregrounded and, on
 * web, the tab is visible. Shared by the backdrop and the auth hero.
 */
export function useBackdropActivity(): boolean {
  const [isActive, setIsActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener(
      'change',
      (nextState: AppStateStatus) => {
        setIsActive(nextState === 'active');
      },
    );

    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return () => subscription.remove();
    }

    const handleVisibilityChange = () => {
      setIsActive(document.visibilityState === 'visible');
    };
    handleVisibilityChange();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      subscription.remove();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return isActive;
}

/**
 * Keeps input events on the auth screen while giving the decorative backdrop
 * a normalized focal point. Shared values mean pointer movement never rerenders
 * the form or its Clerk controls.
 */
export function useSymbioteInteraction(): SymbioteInteraction {
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const pointerX = useSharedValue(0.68);
  const pointerY = useSharedValue(0.26);

  const moveTo = useCallback(
    (x: number, y: number) => {
      if (reduceMotion) return;
      pointerX.value = clampPosition(x / Math.max(width, 1));
      pointerY.value = clampPosition(y / Math.max(height, 1));
    },
    [height, pointerX, pointerY, reduceMotion, width],
  );

  const onPointerMove = useCallback(
    (event: ViewPointerMoveEvent) => {
      if (Platform.OS !== 'web') return;
      moveTo(event.nativeEvent.pageX, event.nativeEvent.pageY);
    },
    [moveTo],
  );

  const onTouchMove = useCallback(
    (event: ViewTouchMoveEvent) => {
      if (Platform.OS === 'web') return;
      const touch = event.nativeEvent.touches[0];
      if (touch) moveTo(touch.pageX, touch.pageY);
    },
    [moveTo],
  );

  const onTouchEnd = useCallback(() => {
    if (Platform.OS === 'web' || reduceMotion) return;
    pointerX.value = withTiming(0.68, { duration: 900 });
    pointerY.value = withTiming(0.26, { duration: 900 });
  }, [pointerX, pointerY, reduceMotion]);

  return { onPointerMove, onTouchMove, onTouchEnd, pointerX, pointerY };
}

function CurvedTendril({
  color,
  highlight,
  size,
  style,
  thickness,
}: {
  color: string;
  highlight: string;
  size: number;
  style: TendrilStyle;
  thickness: number;
}) {
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: thickness,
          borderColor: color,
          shadowColor: highlight,
          shadowOpacity: 0.05,
          shadowRadius: 32,
          shadowOffset: { width: 0, height: 0 },
          elevation: 8,
        },
        style,
      ]}
    />
  );
}

function SolidTendril({
  color,
  gradientColor,
  height,
  style,
  width,
}: {
  color: string;
  gradientColor: string;
  height: number;
  style: TendrilStyle;
  width: number;
}) {
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          width,
          height,
          borderRadius: width / 2,
          backgroundColor: color,
          shadowColor: gradientColor,
          shadowOpacity: 0.06,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 8 },
          elevation: 8,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <LinearGradient
        colors={[gradientColor, color, color, gradientColor]}
        locations={[0, 0.2, 0.8, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

function Striations({ color }: { color: string }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.pointerNone]}>
      {[12, 28, 45, 62, 78, 89].map((left, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: `${left}%`,
            top: '-20%',
            bottom: '-20%',
            width: 1,
            backgroundColor: color,
            opacity: 0.015 + (i % 3) * 0.01,
            transform: [{ rotate: '12deg' }],
          }}
        />
      ))}
    </View>
  );
}

export function SymbioteAuthBackdrop({
  pointerX,
  pointerY,
}: SymbioteAuthBackdropProps) {
  const colors = useColors();
  const { width, height } = useWindowDimensions();
  const vmax = Math.max(width, height);
  const reduceMotion = useReducedMotion();
  const isActive = useBackdropActivity();
  const breath = useSharedValue(0);
  const drift = useSharedValue(0);
  const motionAllowed = isActive && !reduceMotion;

  useEffect(() => {
    cancelAnimation(breath);
    cancelAnimation(drift);

    if (!motionAllowed) {
      breath.value = 0;
      drift.value = 0;
      return;
    }

    breath.value = withRepeat(
      withTiming(1, {
        duration: 5200,
        easing: Easing.inOut(Easing.cubic),
      }),
      -1,
      true,
    );
    drift.value = withRepeat(
      withTiming(1, {
        duration: 8600,
        easing: Easing.inOut(Easing.sin),
      }),
      -1,
      true,
    );

    return () => {
      cancelAnimation(breath);
      cancelAnimation(drift);
    };
  }, [breath, drift, motionAllowed]);

  const t1Style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: reduceMotion
          ? 0
          : interpolate(pointerX.value, [0, 1], [-vmax * 0.03, vmax * 0.03]),
      },
      {
        translateY: reduceMotion
          ? 0
          : interpolate(pointerY.value, [0, 1], [-vmax * 0.02, vmax * 0.02]),
      },
      { rotate: `${-15 + (reduceMotion ? 0 : drift.value * 6)}deg` },
      { scale: reduceMotion ? 1 : 1 + breath.value * 0.04 },
    ],
  }));

  const t2Style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: reduceMotion
          ? 0
          : interpolate(pointerX.value, [0, 1], [vmax * 0.04, -vmax * 0.04]),
      },
      {
        translateY: reduceMotion
          ? 0
          : interpolate(pointerY.value, [0, 1], [vmax * 0.03, -vmax * 0.03]),
      },
      { rotate: `${42 - (reduceMotion ? 0 : drift.value * 8)}deg` },
      { scale: reduceMotion ? 1 : 1.03 - breath.value * 0.03 },
    ],
  }));

  const t3Style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: reduceMotion
          ? 0
          : interpolate(pointerX.value, [0, 1], [-vmax * 0.05, vmax * 0.05]),
      },
      {
        translateY: reduceMotion
          ? 0
          : interpolate(pointerY.value, [0, 1], [vmax * 0.04, -vmax * 0.04]),
      },
      { rotate: `${68 + (reduceMotion ? 0 : drift.value * 10)}deg` },
      { scale: reduceMotion ? 1 : 0.97 + breath.value * 0.06 },
    ],
  }));

  const t4Style = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: reduceMotion
          ? 0
          : interpolate(pointerX.value, [0, 1], [vmax * 0.02, -vmax * 0.02]),
      },
      {
        translateY: reduceMotion
          ? 0
          : interpolate(pointerY.value, [0, 1], [-vmax * 0.05, vmax * 0.05]),
      },
      { rotate: `${-35 - (reduceMotion ? 0 : drift.value * 5)}deg` },
      { scale: reduceMotion ? 1 : 1.05 - breath.value * 0.04 },
    ],
  }));

  const coreGlowStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.35 : 0.25 + breath.value * 0.15,
    transform: [
      {
        translateX: reduceMotion
          ? 0
          : interpolate(pointerX.value, [0, 1], [-vmax * 0.08, vmax * 0.08]),
      },
      {
        translateY: reduceMotion
          ? 0
          : interpolate(pointerY.value, [0, 1], [-vmax * 0.08, vmax * 0.08]),
      },
    ],
  }));

  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.backdrop,
        styles.pointerNone,
        { backgroundColor: colors.symbioteBackdrop },
      ]}
    >
      <LinearGradient
        colors={[
          colors.symbioteSurface,
          colors.symbiotePanel,
          colors.symbioteBackdrop,
        ]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />
      
      <Animated.View style={[
        {
          position: 'absolute',
          width: vmax * 1.2,
          height: vmax * 1.2,
          borderRadius: vmax * 0.6,
          backgroundColor: colors.symbioteGlow,
          top: height / 2 - vmax * 0.6,
          left: width / 2 - vmax * 0.6,
        },
        coreGlowStyle
      ]} />

      <CurvedTendril 
        color={colors.symbioteSurface}
        highlight={colors.symbioteHighlight}
        size={vmax * 1.4} 
        thickness={vmax * 0.12} 
        style={[
          { top: -vmax * 0.3, left: -vmax * 0.4 },
          t1Style
        ]} 
      />

      <CurvedTendril 
        color={colors.symbioteSurface}
        highlight={colors.symbioteHighlight}
        size={vmax * 1.6} 
        thickness={vmax * 0.07} 
        style={[
          { bottom: -vmax * 0.5, right: -vmax * 0.3 },
          t2Style
        ]} 
      />

      <SolidTendril
        color={colors.symbioteSurface}
        gradientColor={colors.symbioteGlow}
        width={vmax * 0.15}
        height={vmax * 1.8}
        style={[
          { top: -vmax * 0.3, left: '55%' },
          t3Style
        ]}
      />

      <SolidTendril
        color={colors.symbioteSurface}
        gradientColor={colors.symbioteGlow}
        width={vmax * 0.08}
        height={vmax * 1.4}
        style={[
          { top: '15%', right: '65%' },
          t4Style
        ]}
      />
      
      <Animated.View style={[
        {
          position: 'absolute',
          width: vmax * 1.1,
          height: vmax * 1.1,
          borderRadius: vmax * 0.55,
          borderWidth: 1,
          borderColor: colors.symbioteGlow,
          top: -vmax * 0.15,
          left: -vmax * 0.1,
        },
        t1Style
      ]} />
      
      <Striations color={colors.symbioteHighlight} />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  pointerNone: {
    pointerEvents: 'none',
  },
});
