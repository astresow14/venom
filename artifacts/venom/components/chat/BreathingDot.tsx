import { useEffect } from "react";
import { View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { styles } from "./styles";

/** Small monochrome dot that breathes while a voice is still speaking. */
export function BreathingDot({
  color,
  phase,
  testID,
}: {
  color: string;
  phase: number;
  testID?: string;
}) {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0.35 + phase * 0.3);

  useEffect(() => {
    if (reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = withTiming(0.9, { duration: 200 });
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [reduceMotion, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: 0.8 + pulse.value * 0.2 }],
  }));

  return (
    <Animated.View
      testID={testID}
      style={[
        styles.deliberationDot,
        { backgroundColor: color },
        animatedStyle,
      ]}
    />
  );
}
