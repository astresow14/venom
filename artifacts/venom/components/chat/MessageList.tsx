import React, { useState } from "react";
import { ActivityIndicator, FlatList, Linking, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { type VenomMessageAttachment } from "@workspace/api-client-react";
import {
  type LocalDebate,
  type LocalDeliberation,
} from "@/components/chat/chatTypes";
import { DebateStreamCard } from "@/components/chat/DebateStreamCard";
import { DeliberationStreamCard } from "@/components/chat/DeliberationStreamCard";
import {
  type FileActivity,
  FileWritingCard,
  MessageAttachmentList,
} from "@/components/ChatFileCards";
import {
  type FamilyForModel,
  SpeakerAvatar,
  speakerGlyph,
} from "@/components/chat/SpeakerAvatar";
import { messageCitationSegments } from "@/context/messageCitations";
import { Message, type ProjectSource } from "@/context/VenomContext";
import { useColors } from "@/hooks/useColors";
import { styles } from "./styles";

type CitationsById = Parameters<typeof messageCitationSegments>[1];
type ArchivedCitationsById = Parameters<typeof messageCitationSegments>[2];

/**
 * The chat thread: the inverted message list, the per-message renderer
 * (speaker chips, citations, deliberation results, attachments, model
 * attribution), and the transient header — debate card, deliberation
 * chamber, writing card, or typing dots — for the turn in flight.
 */
export function MessageList({
  messages,
  colors,
  citationsById,
  archivedCitationsById,
  sourceByCitationId,
  streamError,
  downloadingFileId,
  onDownloadAttachment,
  liveTurnOnScreen,
  localDebate,
  localDeliberation,
  localFileActivity,
  showTyping,
  familyForModel,
}: {
  /** Display messages, newest first (the list renders inverted). */
  messages: Message[];
  colors: ReturnType<typeof useColors>;
  citationsById: CitationsById;
  archivedCitationsById: ArchivedCitationsById;
  sourceByCitationId: Map<string, ProjectSource>;
  streamError: { message: string; retryable: boolean } | null;
  downloadingFileId: string | null;
  onDownloadAttachment: (attachment: VenomMessageAttachment) => void;
  liveTurnOnScreen: boolean;
  localDebate: LocalDebate | null;
  localDeliberation: LocalDeliberation | null;
  localFileActivity: FileActivity | null;
  showTyping: boolean;
  /** Resolves a model id to its family via the already-fetched catalog. */
  familyForModel: FamilyForModel;
}) {
  const router = useRouter();
  const [expandedTakeMessageIds, setExpandedTakeMessageIds] = useState<
    Set<string>
  >(() => new Set());

  // Shared renderer for assistant text: citation markers resolve to source
  // references (live links or archived labels), never raw [source:id] tags.
  const renderSegments = (
    segments: ReturnType<typeof messageCitationSegments>,
    keyPrefix: string,
  ) =>
    segments.map((segment, index) => {
      if (segment.kind === "text") return segment.text;
      if (segment.kind === "citation") {
        return (
          <Text
            key={`${keyPrefix}-${segment.citation.id}-${index}`}
            onPress={() => Linking.openURL(segment.citation.url)}
            accessibilityRole="link"
            accessibilityLabel={`Open source: ${segment.citation.title}`}
            style={[styles.citationLink, { color: colors.primary }]}
          >
            {segment.citation.title}
          </Text>
        );
      }
      const archived = segment.archived;
      if (archived && archived.url) {
        return (
          <Text
            key={`${keyPrefix}-${segment.citationId}-${index}`}
            onPress={() => Linking.openURL(archived.url)}
            accessibilityRole="link"
            accessibilityLabel={`Open archived source, no longer connected: ${archived.title}`}
            style={[
              styles.citationArchivedLink,
              { color: colors.mutedForeground },
            ]}
          >
            {segment.label}
          </Text>
        );
      }
      return (
        <Text
          key={`${keyPrefix}-${segment.citationId}-${index}`}
          accessibilityLabel={
            archived
              ? `Archived source, no longer connected: ${archived.title}`
              : "Archived source, no longer connected"
          }
          style={[
            styles.citationArchived,
            { color: colors.mutedForeground },
          ]}
        >
          {segment.label}
        </Text>
      );
    });

  const renderCitationText = (content: string, keyPrefix: string) =>
    renderSegments(
      messageCitationSegments(content, citationsById, archivedCitationsById),
      keyPrefix,
    );

  const toggleTakes = (messageId: string) => {
    setExpandedTakeMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  };

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const isUser = item.role === "user";
    const isError = item.status === "error";
    const segments = isUser
      ? []
      : messageCitationSegments(
          item.content,
          citationsById,
          archivedCitationsById,
        );
    // The connected sources this answer cited, in the order they appear, so the
    // reader can open one and read the rest of the evidence it carries. Each
    // entry remembers the first citation the answer quoted from that source,
    // so the jump lands on the exact quoted row, not just the card around it.
    const citedSources: { source: ProjectSource; citationId: string }[] = [];
    for (const segment of segments) {
      if (segment.kind !== "citation") continue;
      const source = sourceByCitationId.get(segment.citation.id);
      if (
        !source ||
        citedSources.some((entry) => entry.source.id === source.id)
      ) {
        continue;
      }
      citedSources.push({ source, citationId: segment.citation.id });
    }
    const content = !isUser
      ? renderSegments(segments, item.id)
      : item.content;

    const deliberation = !isUser && !isError ? item.deliberation : undefined;
    const takesExpanded = deliberation
      ? expandedTakeMessageIds.has(item.id)
      : false;
    const deliberationOkCount = deliberation
      ? deliberation.voices.filter((take) => take.status === "ok").length
      : 0;
    const deliberationShowModels = deliberation
      ? new Set(
          deliberation.voices
            .filter((take) => take.status === "ok")
            .map((take) => take.modelId)
            .filter(Boolean),
        ).size > 1
      : false;

    // Debate turns carry their own speaker chip above the bubble, so the
    // trailing model attribution is suppressed for them.
    const speakerName = !isUser ? item.speakerName : undefined;
    const speakerModelLabel =
      speakerName && item.modelName && item.modelName !== speakerName
        ? item.modelName
        : null;
    const modelLabel = !isUser && !speakerName && item.modelName
      ? item.modelName
      : !isUser && !speakerName && item.modelId
        ? item.modelId
        : null;

    // Group-chat runs: consecutive turns from the same speaker read as one
    // visual group, so the avatar and name chip sit only on the run's first
    // message. The list is newest-first, so the chronological predecessor is
    // the NEXT array entry.
    const chronologicalPrev = messages[index + 1];
    const runStart =
      Boolean(speakerName) &&
      !(
        chronologicalPrev &&
        chronologicalPrev.role === "assistant" &&
        chronologicalPrev.speakerName === speakerName
      );
    const avatarGlyph = speakerName
      ? speakerGlyph({
          speakerId: item.speakerId,
          modelId: item.modelId,
          name: speakerName,
          familyForModel,
        })
      : null;

    return (
      <View
        style={[
          styles.messageRow,
          isUser ? styles.messageUser : styles.messageAssistant,
          speakerName && !runStart ? styles.messageRowGrouped : null,
        ]}
      >
        {speakerName ? (
          // Fixed-width gutter keeps every bubble in a run left-aligned; only
          // the run's first row actually carries the avatar.
          <View style={styles.speakerGutter}>
            {runStart && avatarGlyph ? (
              <SpeakerAvatar glyph={avatarGlyph} colors={colors} />
            ) : null}
          </View>
        ) : null}
        <View style={styles.messageWrap}>
          {speakerName && runStart && (
            <View style={styles.speakerChip} testID="chip-speaker">
              <Text
                style={[styles.speakerName, { color: colors.foreground }]}
                numberOfLines={1}
              >
                {speakerName}
              </Text>
              {speakerModelLabel && (
                <Text
                  style={[
                    styles.speakerModel,
                    { color: colors.mutedForeground },
                  ]}
                  numberOfLines={1}
                >
                  {` · ${speakerModelLabel}`}
                </Text>
              )}
            </View>
          )}
          <View
            style={[
              styles.messageBubble,
              isUser
                ? [styles.bubbleUser, { backgroundColor: colors.secondary }]
                : styles.bubbleAssistant,
              isError && {
                borderColor: colors.destructive,
                borderWidth: 1,
              },
            ]}
          >
            {isError && (
              <View style={styles.errorBadge}>
                <Feather name="alert-circle" size={12} color={colors.destructive} />
                <Text style={[styles.errorBadgeText, { color: colors.destructive }]}>
                  {streamError?.retryable !== false ? "Tap send to retry" : "Error"}
                </Text>
              </View>
            )}
            <Text
              testID={isUser ? "chat-message-user" : "chat-message-assistant"}
              style={[
                styles.messageText,
                { color: colors.foreground },
              ]}
            >
              {content}
            </Text>
          </View>
          {!isError && item.attachments && item.attachments.length > 0 && (
            <MessageAttachmentList
              attachments={item.attachments}
              variant={isUser ? "user" : "assistant"}
              downloadingId={downloadingFileId}
              onDownload={onDownloadAttachment}
              colors={colors}
            />
          )}
          {deliberation && (
            <View style={styles.deliberationResult} testID="deliberation-result">
              {deliberation.disagreements.length > 0 ? (
                <View
                  style={[
                    styles.deliberationDisagreements,
                    { borderColor: colors.border, backgroundColor: colors.card },
                  ]}
                  testID="deliberation-disagreements"
                >
                  <View style={styles.deliberationDisagreeHeader}>
                    <Feather
                      name="git-branch"
                      size={12}
                      color={colors.foreground}
                    />
                    <Text
                      style={[
                        styles.deliberationDisagreeTitle,
                        { color: colors.foreground },
                      ]}
                    >
                      Where the voices split
                    </Text>
                  </View>
                  {deliberation.disagreements.map((note, index) => (
                    <View key={index} style={styles.deliberationDisagreeItem}>
                      <View
                        style={[
                          styles.deliberationDisagreeBullet,
                          { backgroundColor: colors.mutedForeground },
                        ]}
                      />
                      <Text
                        style={[
                          styles.deliberationDisagreeText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {renderCitationText(note, `${item.id}-dis-${index}`)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text
                  style={[
                    styles.deliberationAgreement,
                    { color: colors.mutedForeground },
                  ]}
                  testID="deliberation-agreement"
                >
                  The voices converged without real disagreement.
                </Text>
              )}
              <TouchableOpacity
                onPress={() => toggleTakes(item.id)}
                style={styles.deliberationToggle}
                accessibilityRole="button"
                accessibilityState={{ expanded: takesExpanded }}
                accessibilityLabel={
                  takesExpanded ? "Hide the voice takes" : "Show the voice takes"
                }
                testID="toggle-deliberation-takes"
              >
                <Feather
                  name={takesExpanded ? "chevron-up" : "chevron-down"}
                  size={13}
                  color={colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.deliberationToggleText,
                    { color: colors.mutedForeground },
                  ]}
                >
                  {takesExpanded
                    ? "Hide the takes"
                    : `Read the takes (${deliberationOkCount})`}
                </Text>
              </TouchableOpacity>
              {takesExpanded &&
                deliberation.voices.map((take) => (
                  <View
                    key={take.voiceId}
                    style={[
                      styles.deliberationTakeCard,
                      { borderColor: colors.border },
                    ]}
                    testID={`deliberation-take-${take.voiceId}`}
                  >
                    <View style={styles.deliberationVoiceHeader}>
                      <SpeakerAvatar
                        glyph={speakerGlyph({
                          speakerId: take.voiceId,
                          modelId: take.modelId,
                          name: take.name,
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
                        {take.name}
                      </Text>
                      {deliberationShowModels && take.modelName ? (
                        <Text
                          style={[
                            styles.deliberationVoiceModel,
                            { color: colors.mutedForeground },
                          ]}
                          numberOfLines={1}
                        >
                          {take.modelName}
                        </Text>
                      ) : null}
                    </View>
                    {take.status === "failed" ? (
                      <Text
                        style={[
                          styles.deliberationTakeText,
                          { color: colors.mutedForeground, opacity: 0.8 },
                        ]}
                      >
                        This voice didn't finish its take.
                      </Text>
                    ) : (
                      <Text
                        style={[
                          styles.deliberationTakeText,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {renderCitationText(
                          take.content,
                          `${item.id}-take-${take.voiceId}`,
                        )}
                      </Text>
                    )}
                  </View>
                ))}
            </View>
          )}
          {citedSources.length > 0 && !isError && (
            <View style={styles.citedSourceRow}>
              {citedSources.map(({ source, citationId }) => (
                <TouchableOpacity
                  key={source.id}
                  style={[
                    styles.citedSourceChip,
                    {
                      borderColor: colors.border,
                      backgroundColor: colors.card,
                    },
                  ]}
                  onPress={() =>
                    router.push({
                      pathname: "/knowledge",
                      params: {
                        view: "sources",
                        source: source.id,
                        citation: citationId,
                      },
                    })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`Show all ${source.citations.length} citation${
                    source.citations.length === 1 ? "" : "s"
                  } from ${source.name} in Venom`}
                  testID={`chat-open-source-${source.id}`}
                  activeOpacity={0.8}
                >
                  <Feather
                    name={source.provider === "github" ? "github" : "globe"}
                    size={11}
                    color={colors.primary}
                  />
                  <Text
                    style={[
                      styles.citedSourceChipText,
                      { color: colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {source.name}
                  </Text>
                  <Text
                    style={[
                      styles.citedSourceChipMeta,
                      { color: colors.mutedForeground },
                    ]}
                  >
                    {`${source.citations.length} citation${
                      source.citations.length === 1 ? "" : "s"
                    }`}
                  </Text>
                  <Feather
                    name="arrow-up-right"
                    size={11}
                    color={colors.mutedForeground}
                  />
                </TouchableOpacity>
              ))}
            </View>
          )}
          {modelLabel && !isUser && !isError && (
            <Text
              style={[styles.messageAttribution, { color: colors.mutedForeground }]}
              numberOfLines={1}
            >
              {modelLabel}
            </Text>
          )}
        </View>
      </View>
    );
  };

  return (
    <FlatList
      style={styles.chatList}
      data={messages}
      keyExtractor={(item) => item.id}
      renderItem={renderMessage}
      inverted={messages.length > 0}
      contentContainerStyle={[
        styles.listContent,
        { paddingBottom: 24, flexGrow: 1 },
      ]}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEnabled={messages.length > 0}
      ListHeaderComponent={
        !liveTurnOnScreen ? null : localDebate ? (
          <DebateStreamCard
            debate={localDebate}
            colors={colors}
            renderContent={renderCitationText}
            familyForModel={familyForModel}
          />
        ) : localDeliberation ? (
          <DeliberationStreamCard
            deliberation={localDeliberation}
            colors={colors}
            renderContent={renderCitationText}
            familyForModel={familyForModel}
          />
        ) : localFileActivity ? (
          <FileWritingCard activity={localFileActivity} colors={colors} />
        ) : showTyping ? (
          <View style={styles.typingContainer}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        ) : null
      }
      ListEmptyComponent={
        !liveTurnOnScreen && messages.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View
              style={[
                styles.emptyAvatar,
                { backgroundColor: colors.secondary },
              ]}
            >
              <Feather name="zap" size={24} color={colors.primary} />
            </View>
            <Text style={[styles.emptyText, { color: colors.foreground }]}>
              How can I help?
            </Text>
            <Text
              style={[styles.emptySubtext, { color: colors.mutedForeground }]}
            >
              Ask anything about the project.
            </Text>
          </View>
        ) : null
      }
    />
  );
}
