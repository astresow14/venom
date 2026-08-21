import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, TouchableWithoutFeedback, Platform } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface CommunityActionMenuProps {
  visible: boolean;
  onClose: () => void;
  viewerIsAuthor: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onReport?: () => void;
}

export function CommunityActionMenu({
  visible,
  onClose,
  viewerIsAuthor,
  onEdit,
  onDelete,
  onReport,
}: CommunityActionMenuProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <View style={[styles.menu, { backgroundColor: colors.card, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, 24) }]}>
              {viewerIsAuthor ? (
                <>
                  {onEdit && (
                    <TouchableOpacity style={[styles.action, { borderBottomColor: colors.border }]} onPress={onEdit}>
                      <Feather name="edit-2" size={18} color={colors.foreground} />
                      <Text style={[styles.actionText, { color: colors.foreground }]}>Edit</Text>
                    </TouchableOpacity>
                  )}
                  {onDelete && (
                    <TouchableOpacity style={styles.action} onPress={onDelete}>
                      <Feather name="trash-2" size={18} color={colors.destructive} />
                      <Text style={[styles.actionText, { color: colors.destructive }]}>Delete</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <>
                  {onReport && (
                    <TouchableOpacity style={styles.action} onPress={onReport}>
                      <Feather name="flag" size={18} color={colors.destructive} />
                      <Text style={[styles.actionText, { color: colors.destructive }]}>Report</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  menu: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  actionText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
  },
});
