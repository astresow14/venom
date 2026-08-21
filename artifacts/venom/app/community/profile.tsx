import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useGetCommunityProfile, useUpsertCommunityProfile } from "@workspace/api-client-react";

export default function CommunityProfileScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  
  const { data: profile, isLoading, error, isError, refetch } = useGetCommunityProfile({
    query: {
      queryKey: ["/api/venom/community/profile"],
      retry: false, // if 404, it might fail. Actually the API might return 404 if not found, we should handle that gracefully.
    }
  });

  const upsertMutation = useUpsertCommunityProfile();
  
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || "");
      setBio(profile.bio || "");
    }
  }, [profile]);

  const handleSave = () => {
    if (!displayName.trim()) return;
    upsertMutation.mutate(
      { data: { displayName: displayName.trim(), bio: bio.trim() || null } },
      {
        onSuccess: () => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace("/");
          }
        },
        onError: (err: any) => {
          if (Platform.OS === 'web') {
            window.alert(`Failed to save profile: ${err.message || 'Unknown error'}`);
          } else {
            import('react-native').then(({ Alert }) => {
              Alert.alert("Save Failed", err.message || 'Unknown error');
            });
          }
        }
      }
    );
  };

  const isSaving = upsertMutation.isPending;

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
          accessibilityLabel="Go back"
        >
          <Feather name="arrow-left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Your Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError && (error as any)?.status !== 404 ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={24} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.mutedForeground, marginBottom: 16 }}>Failed to load profile.</Text>
          <TouchableOpacity 
            style={[styles.retryBtn, { borderColor: colors.border }]} 
            onPress={() => refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading profile"
          >
            <Text style={{ color: colors.foreground }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={[styles.label, { color: colors.foreground }]}>Display Name</Text>
          <TextInput
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Choose a name..."
            placeholderTextColor={colors.mutedForeground}
            maxLength={60}
            accessibilityLabel="Display Name"
          />

          <Text style={[styles.label, { color: colors.foreground }]}>Bio (Optional)</Text>
          <TextInput
            style={[styles.textArea, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
            value={bio}
            onChangeText={setBio}
            placeholder="Tell the community about yourself..."
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={300}
            textAlignVertical="top"
            accessibilityLabel="Bio"
          />

          <TouchableOpacity 
            style={[styles.saveButton, { backgroundColor: colors.primary }, (!displayName.trim() || isSaving) && { opacity: 0.5 }]}
            disabled={!displayName.trim() || isSaving}
            onPress={handleSave}
            accessibilityRole="button"
            accessibilityLabel="Save Profile"
            accessibilityState={{ disabled: !displayName.trim() || isSaving }}
          >
            {isSaving ? (
              <ActivityIndicator color={colors.primaryForeground} size="small" />
            ) : (
              <Text style={[styles.saveButtonText, { color: colors.primaryForeground }]}>Save Profile</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
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
  headerTitle: { fontSize: 17, fontFamily: "Inter_600SemiBold" },
  form: { padding: 24, gap: 16 },
  label: { fontSize: 13, fontFamily: "Inter_500Medium" },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    height: 120,
  },
  saveButton: {
    borderRadius: 24,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  saveButtonText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  retryBtn: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
});
