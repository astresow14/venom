import React from "react";
import { Text, View } from "react-native";
import { BreathingDot } from "@/components/chat/BreathingDot";
import { type LocalDebate } from "@/components/chat/chatTypes";
import {
  type FamilyForModel,
  SpeakerAvatar,
  speakerGlyph,
} from "@/components/chat/SpeakerAvatar";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

/**
 * The live debate: the roster, whose turn is streaming right now, and voices
 * that failed. Finished turns already sit in the thread as named messages —
 * this card only renders the in-flight one.
 */
export function DebateStreamCard({
  debate,
  colors,
  renderContent,
  familyForModel,
}: {
  debate: LocalDebate;
  colors: ReturnType<typeof useColors>;
  renderContent: (content: string, keyPrefix: string) => React.ReactNode;
  familyForModel: FamilyForModel;
}) {
  const current = debate.current;
  const showModels =
    new Set(debate.roster.map((voice) => voice.modelId).filter(Boolean)).size >
    1;
  const currentIndexInRoster = current
    ? Math.max(
        0,
        debate.roster.findIndex((voice) => voice.voiceId === current.voiceId),
      )
    : 0;

  return (
    <View
      style={[
        styles.deliberationPanel,
        { borderColor: colors.border, backgroundColor: colors.card },
      ]}
      testID="debate-stream"
    >
      <View style={styles.deliberationHeader}>
        <Text
          style={[styles.deliberationHeaderTitle, { color: colors.foreground }]}
        >
          Debating
        </Text>
        <Text
          style={[
            styles.deliberationHeaderMeta,
            { color: colors.mutedForeground },
          ]}
          numberOfLines={1}
          testID="debate-status"
        >
          {current
            ? `Turn ${current.index + 1} of ${debate.of} · ${current.name} is speaking`
            : "the voices are gathering"}
        </Text>
      </View>
      {debate.failedNames.length > 0 && (
        <Text
          style={[
            styles.debateFailedNote,
            { color: colors.mutedForeground, borderColor: colors.border },
          ]}
          testID="chip-debate-failed"
        >
          {`${debate.failedNames.join(", ")} couldn't respond — the debate carries on.`}
        </Text>
      )}
      {current && (
        <View
          style={[
            styles.deliberationVoiceCard,
            { borderColor: colors.border, backgroundColor: colors.background },
          ]}
          testID={`debate-turn-${current.index}`}
        >
          <View style={styles.deliberationVoiceHeader}>
            <BreathingDot
              color={colors.foreground}
              phase={currentIndexInRoster / 3}
            />
            <SpeakerAvatar
              glyph={speakerGlyph({
                speakerId: current.voiceId,
                modelId: current.modelId,
                name: current.name,
                familyForModel,
              })}
              colors={colors}
              size={20}
            />
            <Text
              style={[
                styles.deliberationVoiceName,
                { color: colors.foreground },
              ]}
              numberOfLines={1}
            >
              {current.name}
            </Text>
            {showModels && current.modelName ? (
              <Text
                style={[
                  styles.deliberationVoiceModel,
                  { color: colors.mutedForeground },
                ]}
                numberOfLines={1}
              >
                {current.modelName}
              </Text>
            ) : null}
          </View>
          {current.content ? (
            <Text
              style={[styles.deliberationTakeText, { color: colors.foreground }]}
            >
              {renderContent(current.content, `debate-${current.index}`)}
            </Text>
          ) : (
            <Text
              style={[
                styles.deliberationTakeText,
                { color: colors.mutedForeground, opacity: 0.7 },
              ]}
            >
              Forming a reply…
            </Text>
          )}
        </View>
      )}
    </View>
  );
}
