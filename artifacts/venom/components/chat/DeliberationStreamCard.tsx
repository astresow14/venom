import React from "react";
import { Text, View } from "react-native";
import { BreathingDot } from "@/components/chat/BreathingDot";
import { type LocalDeliberation } from "@/components/chat/chatTypes";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

/** The in-progress chamber: voice takes surfacing while the answer forms. */
export function DeliberationStreamCard({
  deliberation,
  colors,
  renderContent,
}: {
  deliberation: LocalDeliberation;
  colors: ReturnType<typeof useColors>;
  renderContent: (content: string, keyPrefix: string) => React.ReactNode;
}) {
  const converging = deliberation.stage === "synthesis";
  const showModels =
    new Set(deliberation.roster.map((voice) => voice.modelId).filter(Boolean))
      .size > 1;

  return (
    <View
      style={[
        styles.deliberationPanel,
        { borderColor: colors.border, backgroundColor: colors.card },
      ]}
      testID="deliberation-panel"
    >
      <View style={styles.deliberationHeader}>
        <Text
          style={[styles.deliberationHeaderTitle, { color: colors.foreground }]}
        >
          {converging ? "Converging" : "Verifying"}
        </Text>
        <Text
          style={[
            styles.deliberationHeaderMeta,
            { color: colors.mutedForeground },
          ]}
          numberOfLines={1}
        >
          {converging
            ? "merging into one answer"
            : `${deliberation.roster.length} voices are checking the question`}
        </Text>
      </View>
      {deliberation.roster.map((voice, index) => {
        const take = deliberation.takes[voice.voiceId] ?? {
          content: "",
          status: "streaming" as const,
        };
        return (
          <View
            key={voice.voiceId}
            style={[
              styles.deliberationVoiceCard,
              {
                borderColor: colors.border,
                backgroundColor: colors.background,
                opacity: converging ? 0.65 : 1,
              },
            ]}
            testID={`deliberation-voice-${voice.voiceId}`}
          >
            <View style={styles.deliberationVoiceHeader}>
              {take.status === "streaming" ? (
                <BreathingDot
                  color={colors.foreground}
                  phase={index / 3}
                  testID={`deliberation-dot-${voice.voiceId}`}
                />
              ) : (
                <View
                  testID={`deliberation-dot-${voice.voiceId}`}
                  style={[
                    styles.deliberationDot,
                    take.status === "ok"
                      ? { backgroundColor: colors.foreground }
                      : {
                          borderWidth: 1,
                          borderColor: colors.mutedForeground,
                          backgroundColor: "transparent",
                        },
                  ]}
                />
              )}
              <Text
                style={[
                  styles.deliberationVoiceName,
                  { color: colors.foreground },
                ]}
                numberOfLines={1}
              >
                {voice.name}
              </Text>
              {showModels && voice.modelName ? (
                <Text
                  style={[
                    styles.deliberationVoiceModel,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {voice.modelName}
                </Text>
              ) : null}
            </View>
            {take.status === "failed" ? (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground },
                ]}
              >
                Didn't finish — the others carry on.
              </Text>
            ) : take.content ? (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground },
                ]}
                numberOfLines={6}
              >
                {renderContent(take.content, `live-${voice.voiceId}`)}
              </Text>
            ) : (
              <Text
                style={[
                  styles.deliberationTakeText,
                  { color: colors.mutedForeground, opacity: 0.7 },
                ]}
              >
                Forming a take…
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
