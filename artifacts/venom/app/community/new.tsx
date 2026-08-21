import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator, Alert } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useCreateCommunityThread } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export default function CreateThreadScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  
  const createMutation = useCreateCommunityThread();
  
  const [body, setBody] = useState("");

  const handlePost = () => {
    if (!body.trim() || body.length > 2000) return;
    createMutation.mutate(
      { data: { body: body.trim() } },
      {
        onSuccess: (newThread) => {
          queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
          router.replace(`/community/${newThread.id}` as any);
        },
        onError: (err: any) => {
          if (Platform.OS === 'web') {
            window.alert(`Failed to create thread: ${err.message || 'Unknown error'}`);
          } else {
            Alert.alert("Post Failed", err.message || 'Unknown error');
          }
        }
      }
    );
  };

  const isPosting = createMutation.isPending;
  const isValid = body.trim().length > 0 && body.length <= 2000;

  return (
    <KeyboardAvoidingView 
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 16), borderBottomColor: colors.border }]}>
        <TouchableOpacity 
          style={styles.backButton} 
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Cancel new thread"
        >
          <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>New Thread</Text>
        <TouchableOpacity 
          style={[styles.postButton, { backgroundColor: colors.primary }, (!isValid || isPosting) && { opacity: 0.5 }]}
          disabled={!isValid || isPosting}
          onPress={handlePost}
          accessibilityRole="button"
          accessibilityLabel="Post thread"
          accessibilityState={{ disabled: !isValid || isPosting }}
        >
          {isPosting ? (
            <ActivityIndicator color={colors.primaryForeground} size="small" />
          ) : (
            <Text style={[styles.postButtonText, { color: colors.primaryForeground }]}>Post</Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.form}>
        <TextInput
          style={[styles.textArea, { color: colors.foreground }]}
          value={body}
          onChangeText={setBody}
          placeholder="What's on your mind?"
          placeholderTextColor={colors.mutedForeground}
          multiline
          autoFocus
          maxLength={2000}
          textAlignVertical="top"
          accessibilityLabel="Thread body input"
        />
        <Text style={[
          styles.charCount, 
          { color: body.length > 2000 ? colors.destructive : colors.mutedForeground }
        ]}>
          {body.length} / 2000
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  backButton: { padding: 8, marginLeft: -8 },
  cancelText: { fontSize: 15, fontFamily: "Inter_500Medium" },
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  postButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  postButtonText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  form: { flex: 1, padding: 16 },
  textArea: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  charCount: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    textAlign: "right",
    paddingTop: 8,
  }
});
