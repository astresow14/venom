import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useColors } from "@/hooks/useColors";

export function NotificationBadge({ count }: { count: number }) {
  const colors = useColors();

  if (count === 0) return null;

  return (
    <View
      style={[styles.badge, { backgroundColor: colors.primary }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[styles.badgeText, { color: colors.primaryForeground }]}>
        {count > 99 ? "99+" : count}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    marginLeft: 6,
    paddingHorizontal: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    lineHeight: 12,
  },
});
