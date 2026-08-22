import React from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { type VenomCanonDraft } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

export type CanonTeachState = {
  /** Conversation the teaching came from; the card renders only there. */
  convId: string;
  /** The admin message the draft was distilled from. */
  userMessageId: string;
  /** Project on screen when the teach began, for the fall-through turn. */
  projectId: string | null;
  message: string;
  phase: "probing" | "confirm" | "committing";
  draft?: VenomCanonDraft;
  error?: string | null;
};

/**
 * The teach confirmation card: before anything becomes canon, the super
 * admin sees exactly what Venom is about to keep — the skill domain and the
 * distilled principles — and nothing commits until they say so. Cancel turns
 * the message back into an ordinary chat turn.
 *
 * Rendered only for super admins (the flow that sets its state is gated on
 * the identity flag, and the server re-verifies the role on every call), so
 * regular users never see this surface.
 */
export function CanonTeachCard({
  state,
  onConfirm,
  onCancel,
}: {
  state: CanonTeachState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const busy = state.phase === "committing";

  return (
    <View
      testID="canon-teach-card"
      style={{
        marginHorizontal: 16,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: colors.radius,
        backgroundColor: colors.card,
        padding: 14,
        gap: 8,
      }}
    >
      {state.phase === "probing" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
            Reading this as a teaching…
          </Text>
        </View>
      ) : (
        <>
          <Text
            style={{
              color: colors.mutedForeground,
              fontSize: 11,
              letterSpacing: 1.2,
              textTransform: "uppercase",
            }}
          >
            Add to canon · {state.draft?.domain}
          </Text>
          <Text
            testID="canon-teach-title"
            style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}
          >
            {state.draft?.title}
          </Text>
          <View style={{ gap: 6 }}>
            {(state.draft?.principles ?? []).map((principle, index) => (
              <View
                key={index}
                style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}
              >
                <Text style={{ color: colors.mutedForeground, fontSize: 13 }}>
                  —
                </Text>
                <Text
                  style={{ color: colors.text, fontSize: 13, flex: 1, lineHeight: 19 }}
                >
                  {principle}
                </Text>
              </View>
            ))}
          </View>
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
            This will shape Venom's answers for everyone. Nothing is stored
            until you confirm.
          </Text>
          {state.error ? (
            <Text
              testID="canon-teach-error"
              style={{ color: colors.destructive, fontSize: 12 }}
            >
              {state.error}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
            <Pressable
              testID="canon-teach-confirm"
              accessibilityRole="button"
              accessibilityLabel="Make it canon"
              disabled={busy}
              onPress={onConfirm}
              style={({ pressed }) => ({
                backgroundColor: colors.primary,
                borderRadius: colors.radius - 6,
                paddingVertical: 10,
                paddingHorizontal: 16,
                opacity: busy ? 0.6 : pressed ? 0.85 : 1,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              })}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.primaryForeground} />
              ) : null}
              <Text
                style={{
                  color: colors.primaryForeground,
                  fontSize: 13,
                  fontWeight: "600",
                }}
              >
                Make it canon
              </Text>
            </Pressable>
            <Pressable
              testID="canon-teach-cancel"
              accessibilityRole="button"
              accessibilityLabel="Just chat instead"
              disabled={busy}
              onPress={onCancel}
              style={({ pressed }) => ({
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: colors.radius - 6,
                paddingVertical: 10,
                paddingHorizontal: 16,
                opacity: busy ? 0.6 : pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>Just chat</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}
