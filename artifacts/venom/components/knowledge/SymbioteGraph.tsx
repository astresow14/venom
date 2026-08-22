import { Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { clampGraphValue, type GraphPoint, type ProjectedGraphPoint } from "@/components/knowledge/graphProjection";
import { KnowledgeCluster } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

export function SymbioteTendrilSegment({
  from,
  to,
  index,
  breath,
  reduceMotion,
  opacity,
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  opacity: number;
}) {
  const colors = useColors();
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const thickness =
    (2.4 + (index % 3) * 0.55) *
    clampGraphValue(opacity + 0.25, 0.55, 1.2);
  const left = (from.x + to.x) / 2 - length / 2;
  const top = (from.y + to.y) / 2 - thickness / 2;

  const flowStyle = useAnimatedStyle(() => {
    if (reduceMotion) {
      return { transform: [{ translateX: 0 }], opacity: 0.62 };
    }
    return {
      transform: [
        {
          translateX: Math.sin(breath.value * Math.PI * 2 + index * 0.85) * 10,
        },
      ],
      opacity:
        0.4 + ((Math.sin(breath.value * Math.PI * 2 + index) + 1) / 2) * 0.55,
    };
  });

  return (
    <View
      pointerEvents="none"
      style={[
        styles.tendrilSegment,
        {
          left,
          top,
          width: length,
          height: thickness,
          borderRadius: thickness,
          backgroundColor: colors.symbioteSoft,
          borderColor: colors.symbioteSoft,
          shadowColor: colors.symbioteHighlight,
          opacity,
          transform: [{ rotate: `${angle}deg` }],
        },
      ]}
    >
      <View
        style={[
          styles.tendrilHighlight,
          {
            backgroundColor: colors.symbioteHighlight,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.tendrilFlow,
          {
            backgroundColor: colors.symbioteHighlight,
            left: `${28 + (index % 3) * 18}%`,
          },
          flowStyle,
        ]}
      />
    </View>
  );
}

export function SymbioteConnection({
  from,
  to,
  index,
  breath,
  reduceMotion,
  opacity,
}: {
  from: GraphPoint;
  to: GraphPoint;
  index: number;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  opacity: number;
}) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const bend = ((index % 5) - 2) * 10;
  const control = {
    x: (from.x + to.x) / 2 + (-dy / length) * bend,
    y: (from.y + to.y) / 2 + (dx / length) * bend,
  };

  return (
    <>
      <SymbioteTendrilSegment
        from={from}
        to={control}
        index={index * 2}
        breath={breath}
        reduceMotion={reduceMotion}
        opacity={opacity}
      />
      <SymbioteTendrilSegment
        from={control}
        to={to}
        index={index * 2 + 1}
        breath={breath}
        reduceMotion={reduceMotion}
        opacity={opacity}
      />
    </>
  );
}

export function SymbioteNode({
  cluster,
  position,
  index,
  isSelected,
  breath,
  reduceMotion,
  depthScale,
  depthOpacity,
  onPress,
  onPressIn,
  onPressOut,
}: {
  cluster: KnowledgeCluster;
  position: ProjectedGraphPoint;
  index: number;
  isSelected: boolean;
  breath: SharedValue<number>;
  reduceMotion: boolean;
  depthScale: number;
  depthOpacity: number;
  onPress: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
}) {
  const colors = useColors();
  const size = 34 + cluster.strength * 18;

  const nodeMotion = useAnimatedStyle(() => {
    const wave = reduceMotion
      ? 0
      : Math.sin(breath.value * Math.PI * 2 + index * 0.9);
    return {
      transform: [
        {
          scale:
            depthScale *
            (isSelected ? 1.14 : 1) *
            (1 + ((wave + 1) / 2) * 0.055),
        },
        { rotate: `${wave * 2.5}deg` },
      ],
    };
  });

  return (
    <>
      <Animated.View
        style={[
          styles.symbioteNodeMotion,
          {
            left: position.x - size / 2,
            top: position.y - size / 2,
            width: size,
            height: size,
            zIndex: Math.round(1000 + position.depth),
            opacity: depthOpacity,
          },
          nodeMotion,
        ]}
      >
        <View
          pointerEvents="none"
          style={[
            styles.symbioteNodeHalo,
            {
              width: size + 20,
              height: size + 20,
              borderRadius: (size + 20) / 2,
              left: -10,
              top: -10,
              backgroundColor: colors.symbioteGlow,
              opacity: isSelected ? 0.6 : 0.24,
            },
          ]}
        />
        <TouchableOpacity
          testID={`knowledge-cluster-${cluster.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${cluster.label}, ${cluster.category} knowledge cluster, strength ${Math.round(cluster.strength * 100)} percent, ${cluster.links.length} connections`}
          accessibilityHint="Opens cluster details, editing actions, and linked sources"
          accessibilityState={{ selected: isSelected }}
          style={[
            styles.symbioteNode,
            {
              width: size,
              height: size,
              borderRadius: size * 0.42,
              backgroundColor: colors.symbioteSurface,
              borderColor: isSelected
                ? colors.symbioteHighlight
                : colors.symbioteSoft,
            },
          ]}
          onPress={onPress}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          activeOpacity={0.75}
        >
          <View
            pointerEvents="none"
            style={[
              styles.symbioteNodeReflection,
              {
                width: Math.max(8, size * 0.24),
                height: Math.max(4, size * 0.09),
                borderRadius: size,
                backgroundColor: colors.symbioteHighlight,
              },
            ]}
          />
          <Feather
            name={
              cluster.category === "core"
                ? "cpu"
                : cluster.category === "data"
                  ? "database"
                  : "hexagon"
            }
            size={14}
            color={colors.symbioteHighlight}
          />
        </TouchableOpacity>
      </Animated.View>
      <View
        pointerEvents="none"
        style={[
          styles.nodeLabelContainer,
          {
            left: position.x - 75,
            top: position.y + (size * depthScale) / 2 + 8,
            zIndex: Math.round(1000 + position.depth),
            opacity: depthOpacity,
          },
        ]}
      >
        <Text
          style={[
            styles.nodeLabel,
            {
              color: isSelected
                ? colors.symbioteHighlight
                : colors.symbioteMuted,
              fontFamily: isSelected ? "Inter_600SemiBold" : "Inter_500Medium",
            },
          ]}
        >
          {cluster.label}
        </Text>
      </View>
    </>
  );
}
