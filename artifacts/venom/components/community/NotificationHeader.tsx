import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

export function NotificationHeader({
  unreadCount,
  isPending,
  onMarkAllRead,
}: {
  unreadCount: number;
  isPending: boolean;
  onMarkAllRead: () => void;
}) {
  const colors = useColors();

  return (
    <View style={styles.container}>
      <View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          Notifications
        </Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          {unreadCount === 0
            ? "No unread replies"
            : `${unreadCount} unread ${unreadCount === 1 ? "reply" : "replies"}`}
        </Text>
      </View>
      {unreadCount > 0 && (
        <TouchableOpacity
          onPress={onMarkAllRead}
          disabled={isPending}
          style={styles.markAllButton}
          accessibilityRole="button"
          accessibilityLabel="Mark all as read"
          accessibilityState={{ disabled: isPending }}
        >
          {isPending ? (
            <ActivityIndicator size="small" color={colors.foreground} />
          ) : (
            <>
              <Feather name="check" size={15} color={colors.foreground} />
              <Text
                style={[styles.markAllText, { color: colors.foreground }]}
              >
                Mark all read
              </Text>
            </>
          )}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  title: {
    fontSize: 21,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.4,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  markAllButton: {
    minHeight: 44,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  markAllText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
});
