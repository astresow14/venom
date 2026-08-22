import React, { useCallback, useMemo, useRef } from "react";
import {
  AccessibilityInfo,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Svg, {
  Circle,
  Defs,
  Polygon,
  RadialGradient,
  Stop,
} from "react-native-svg";
import * as Haptics from "expo-haptics";

import { useColors } from "@/hooks/useColors";
import {
  BLEND_TRIANGLE,
  describeBlend,
  EVEN_BLEND,
  favoredBlend,
  pinToWeights,
  weightsToPin,
  type BlendWeights,
} from "@/context/responsePrefs";

export type BlendCorner = { id: string; name: string };

const PAD_WIDTH = 248;
const PAD_HEIGHT = 172;
const INSET_X = 34;
const INSET_TOP = 22;
const INSET_BOTTOM = 30;
const INNER_WIDTH = PAD_WIDTH - INSET_X * 2;
const INNER_HEIGHT = PAD_HEIGHT - INSET_TOP - INSET_BOTTOM;

function toPixels(point: { x: number; y: number }) {
  return {
    x: INSET_X + point.x * INNER_WIDTH,
    y: INSET_TOP + point.y * INNER_HEIGHT,
  };
}

/**
 * The model blend pad: a triangle with the participating voices at its
 * corners and a draggable pin. Pin position reads as a weight gradient —
 * centered is an even blend, near a corner favors that voice. Dragging is
 * one input path; the Favor buttons underneath set the same weights without
 * a pointer, and every commit is announced for screen readers.
 */
export function BlendPad({
  corners,
  weights,
  onChange,
  onCommit,
  disabled = false,
}: {
  corners: [BlendCorner, BlendCorner, BlendCorner];
  weights: BlendWeights;
  onChange: (weights: BlendWeights) => void;
  onCommit: (weights: BlendWeights) => void;
  disabled?: boolean;
}) {
  const colors = useColors();
  const padRef = useRef<View>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  // The newest touch point that arrived before measureInWindow answered —
  // the measure callback replays it, so a fast tap whose release beats the
  // (async) measurement still lands and commits.
  const pendingRef = useRef<{
    pageX: number;
    pageY: number;
    commit: boolean;
  } | null>(null);
  const latestRef = useRef<BlendWeights>(weights);
  latestRef.current = weights;

  const names = useMemo(() => corners.map((corner) => corner.name), [corners]);
  const pin = toPixels(weightsToPin(weights));
  const cornerPixels = BLEND_TRIANGLE.map(toPixels);

  const announce = useCallback(
    (next: BlendWeights) => {
      AccessibilityInfo.announceForAccessibility(describeBlend(next, names));
    },
    [names],
  );

  const applyPagePoint = useCallback(
    (pageX: number, pageY: number, commit: boolean) => {
      const origin = originRef.current;
      if (!origin) {
        // measureInWindow hasn't answered yet; remember the newest point so
        // the measure callback can replay it instead of dropping a commit.
        pendingRef.current = { pageX, pageY, commit };
        return;
      }
      const next = pinToWeights({
        x: (pageX - origin.x - INSET_X) / INNER_WIDTH,
        y: (pageY - origin.y - INSET_TOP) / INNER_HEIGHT,
      });
      if (commit) {
        if (Platform.OS !== "web") {
          Haptics.selectionAsync();
        }
        onCommit(next);
        announce(next);
      } else {
        onChange(next);
      }
    },
    [announce, onChange, onCommit],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        // The workspace pager claims mostly-horizontal moves; refusing the
        // handover keeps a drag toward a side corner on the pad instead of
        // swiping tabs mid-gesture.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (event) => {
          const { pageX, pageY } = event.nativeEvent;
          originRef.current = null;
          pendingRef.current = { pageX, pageY, commit: false };
          padRef.current?.measureInWindow((x, y) => {
            originRef.current = { x, y };
            const pending = pendingRef.current;
            pendingRef.current = null;
            if (pending) {
              applyPagePoint(pending.pageX, pending.pageY, pending.commit);
            }
          });
        },
        // Coordinates come from the event itself: gesture.moveX/moveY stay
        // (0, 0) until the first move, so a stationary tap would otherwise
        // release at the screen origin and commit a corner the finger never
        // touched.
        onPanResponderMove: (event) => {
          applyPagePoint(
            event.nativeEvent.pageX,
            event.nativeEvent.pageY,
            false,
          );
        },
        onPanResponderRelease: (event) => {
          applyPagePoint(event.nativeEvent.pageX, event.nativeEvent.pageY, true);
          originRef.current = null;
        },
        onPanResponderTerminate: () => {
          // Drag interrupted by the system: settle on whatever the live
          // weights show, quietly.
          onCommit(latestRef.current);
          originRef.current = null;
          pendingRef.current = null;
        },
      }),
    [applyPagePoint, disabled, onCommit],
  );

  const handleFavor = useCallback(
    (index: 0 | 1 | 2) => {
      if (disabled) return;
      if (Platform.OS !== "web") {
        Haptics.selectionAsync();
      }
      const next = favoredBlend(index);
      onCommit(next);
      announce(next);
    },
    [announce, disabled, onCommit],
  );

  const handleEven = useCallback(() => {
    if (disabled) return;
    if (Platform.OS !== "web") {
      Haptics.selectionAsync();
    }
    const next = [...EVEN_BLEND] as BlendWeights;
    onCommit(next);
    announce(next);
  }, [announce, disabled, onCommit]);

  const trianglePoints = cornerPixels
    .map((point) => `${point.x},${point.y}`)
    .join(" ");
  const gradientCx = ((pin.x / PAD_WIDTH) * 100).toFixed(1);
  const gradientCy = ((pin.y / PAD_HEIGHT) * 100).toFixed(1);

  const labelPlacements = [
    { left: 0, right: 0, top: 0, alignItems: "center" as const },
    { left: 0, top: PAD_HEIGHT - 22, maxWidth: PAD_WIDTH / 2 - 8, alignItems: "flex-start" as const },
    { right: 0, top: PAD_HEIGHT - 22, maxWidth: PAD_WIDTH / 2 - 8, alignItems: "flex-end" as const },
  ];

  return (
    <View style={styles.wrap}>
      <View
        ref={padRef}
        style={[styles.pad, disabled && styles.disabled]}
        testID="blend-pad"
        accessible
        accessibilityLabel={`Model blend: ${describeBlend(weights, names)}. Use the favor buttons below to change it without dragging.`}
        {...panResponder.panHandlers}
      >
        <Svg width={PAD_WIDTH} height={PAD_HEIGHT}>
          <Defs>
            <RadialGradient
              id="blend-glow"
              cx={`${gradientCx}%`}
              cy={`${gradientCy}%`}
              r="62%"
            >
              <Stop offset="0%" stopColor={colors.foreground} stopOpacity="0.28" />
              <Stop offset="55%" stopColor={colors.foreground} stopOpacity="0.09" />
              <Stop offset="100%" stopColor={colors.foreground} stopOpacity="0.02" />
            </RadialGradient>
          </Defs>
          <Polygon
            points={trianglePoints}
            fill="url(#blend-glow)"
            stroke={colors.border}
            strokeWidth={1}
          />
          {cornerPixels.map((point, index) => (
            <Circle
              key={corners[index].id}
              cx={point.x}
              cy={point.y}
              r={3 + weights[index] * 7}
              fill={colors.foreground}
              opacity={0.35 + weights[index] * 0.65}
            />
          ))}
          <Circle
            cx={pin.x}
            cy={pin.y}
            r={9}
            fill={colors.background}
            stroke={colors.foreground}
            strokeWidth={2}
          />
          <Circle cx={pin.x} cy={pin.y} r={3.4} fill={colors.foreground} />
        </Svg>
        {corners.map((corner, index) => (
          <View
            key={corner.id}
            pointerEvents="none"
            style={[styles.cornerLabel, labelPlacements[index]]}
          >
            <Text
              style={[styles.cornerName, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {corner.name}
            </Text>
            <Text
              style={[styles.cornerWeight, { color: colors.mutedForeground }]}
              testID={`blend-weight-${corner.id}`}
            >
              {`${Math.round(weights[index] * 100)}%`}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.buttonRow}>
        {corners.map((corner, index) => (
          <TouchableOpacity
            key={corner.id}
            onPress={() => handleFavor(index as 0 | 1 | 2)}
            disabled={disabled}
            style={[
              styles.favorButton,
              { borderColor: colors.border, backgroundColor: colors.card },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Favor ${corner.name}`}
            testID={`button-blend-favor-${corner.id}`}
            hitSlop={6}
          >
            <Text
              style={[styles.favorLabel, { color: colors.foreground }]}
              numberOfLines={1}
            >
              {`Favor ${corner.name}`}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          onPress={handleEven}
          disabled={disabled}
          style={[
            styles.favorButton,
            { borderColor: colors.border, backgroundColor: colors.card },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Even blend of all three voices"
          testID="button-blend-even"
          hitSlop={6}
        >
          <Text style={[styles.favorLabel, { color: colors.mutedForeground }]}>
            Even blend
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    gap: 10,
  },
  pad: {
    width: PAD_WIDTH,
    height: PAD_HEIGHT,
    position: "relative",
  },
  disabled: {
    opacity: 0.5,
  },
  cornerLabel: {
    position: "absolute",
    gap: 1,
  },
  cornerName: {
    fontSize: 11.5,
    fontWeight: "600",
    maxWidth: 110,
  },
  cornerWeight: {
    fontSize: 10.5,
    fontVariant: ["tabular-nums"],
  },
  buttonRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  favorButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  favorLabel: {
    fontSize: 11.5,
    fontWeight: "500",
  },
});
