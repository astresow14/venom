import React from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { styles } from "./styles";

export function DraggableKanbanCard({
  children,
  onDragEnd,
}: {
  children: React.ReactNode;
  onDragEnd: (translationX: number, translationY: number) => void;
}) {
  const dragX = useSharedValue(0);
  const dragY = useSharedValue(0);
  const dragging = useSharedValue(0);
  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(220)
    .minDistance(6)
    .onBegin(() => {
      dragging.value = 1;
    })
    .onUpdate((event) => {
      dragX.value = event.translationX;
      dragY.value = event.translationY;
    })
    .onEnd((event) => {
      runOnJS(onDragEnd)(event.translationX, event.translationY);
    })
    .onFinalize(() => {
      dragging.value = 0;
      dragX.value = withSpring(0, {
        damping: 20,
        stiffness: 240,
        reduceMotion: ReduceMotion.System,
      });
      dragY.value = withSpring(0, {
        damping: 20,
        stiffness: 240,
        reduceMotion: ReduceMotion.System,
      });
    });
  const dragStyle = useAnimatedStyle(() => ({
    zIndex: dragging.value ? 10 : 0,
    opacity: dragging.value ? 0.84 : 1,
    transform: [
      { translateX: dragX.value },
      { translateY: dragY.value },
      { scale: dragging.value ? 1.02 : 1 },
    ],
  }));

  return (
    <GestureDetector gesture={dragGesture}>
      <Animated.View style={dragStyle}>{children}</Animated.View>
    </GestureDetector>
  );
}
