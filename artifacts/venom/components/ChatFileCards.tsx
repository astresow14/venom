import React from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import type { VenomMessageAttachment } from "@workspace/api-client-react";
import { formatFileSize, isImageAttachment } from "@/lib/chatFiles";

/**
 * Chat file exchange UI: the chips a queued upload shows in the composer,
 * the attachment rows a sent message carries, and the live card while
 * Venom writes a document.
 */

type Colors = {
  foreground: string;
  mutedForeground: string;
  card: string;
  border: string;
  background: string;
  destructive: string;
};

export type PendingChatFile = {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  /** Present once the upload handshake finished; rides the sent message. */
  stamp?: VenomMessageAttachment;
  /** Tiny data-URL preview, present for image files once generated. */
  thumbnail?: string;
};

export function PendingAttachmentChips({
  items,
  onRemove,
  colors,
}: {
  items: PendingChatFile[];
  onRemove: (key: string) => void;
  colors: Colors;
}) {
  if (items.length === 0) return null;
  return (
    <View style={chipStyles.row} testID="pending-attachments-row">
      {items.map((item) => (
        <View
          key={item.key}
          style={[
            chipStyles.chip,
            {
              backgroundColor: colors.card,
              borderColor:
                item.status === "error" ? colors.destructive : colors.border,
            },
          ]}
          testID={`pending-file-${item.status}`}
        >
          {item.thumbnail ? (
            <Image
              source={{ uri: item.thumbnail }}
              style={[chipStyles.thumbnail, { borderColor: colors.border }]}
              accessibilityIgnoresInvertColors
              testID="pending-thumbnail"
            />
          ) : null}
          {item.status === "uploading" ? (
            <ActivityIndicator size={12} color={colors.mutedForeground} />
          ) : item.status === "error" ? (
            <Feather name="alert-circle" size={12} color={colors.destructive} />
          ) : item.thumbnail ? null : (
            <Feather name="file-text" size={12} color={colors.foreground} />
          )}
          <Text
            style={[chipStyles.chipName, { color: colors.foreground }]}
            numberOfLines={1}
          >
            {item.name}
          </Text>
          <Text
            style={[chipStyles.chipMeta, { color: colors.mutedForeground }]}
            numberOfLines={1}
          >
            {item.status === "error"
              ? (item.error ?? "Upload failed")
              : formatFileSize(item.size)}
          </Text>
          <TouchableOpacity
            onPress={() => onRemove(item.key)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${item.name}`}
            testID="remove-pending-file"
          >
            <Feather name="x" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

export function MessageAttachmentList({
  attachments,
  variant,
  downloadingId,
  onDownload,
  colors,
}: {
  attachments: VenomMessageAttachment[];
  variant: "user" | "assistant";
  downloadingId: string | null;
  onDownload: (attachment: VenomMessageAttachment) => void;
  colors: Colors;
}) {
  if (attachments.length === 0) return null;
  return (
    <View
      style={[
        listStyles.wrap,
        variant === "user" ? listStyles.wrapUser : null,
      ]}
    >
      {attachments.map((attachment) => {
        const busy = downloadingId === attachment.id;
        if (attachment.thumbnail) {
          return (
            <TouchableOpacity
              key={attachment.id}
              onPress={() => onDownload(attachment)}
              disabled={busy}
              style={[
                listStyles.imageCard,
                { backgroundColor: colors.card, borderColor: colors.border },
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Download ${attachment.name}`}
              accessibilityState={{ busy }}
              testID={
                variant === "user" ? "message-attachment" : "file-delivery-card"
              }
              activeOpacity={0.8}
            >
              <Image
                source={{ uri: attachment.thumbnail }}
                style={listStyles.imagePreview}
                resizeMode="cover"
                accessibilityIgnoresInvertColors
                testID="attachment-thumbnail"
              />
              <View style={listStyles.imageCaption}>
                <Text
                  style={[listStyles.name, { color: colors.foreground }]}
                  numberOfLines={1}
                  testID="attachment-name"
                >
                  {attachment.name}
                </Text>
                {busy ? (
                  <ActivityIndicator
                    size={12}
                    color={colors.mutedForeground}
                  />
                ) : (
                  <Feather
                    name="download"
                    size={12}
                    color={colors.mutedForeground}
                  />
                )}
              </View>
            </TouchableOpacity>
          );
        }
        return (
          <TouchableOpacity
            key={attachment.id}
            onPress={() => onDownload(attachment)}
            disabled={busy}
            style={[
              listStyles.card,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Download ${attachment.name}`}
            accessibilityState={{ busy }}
            testID={
              variant === "user" ? "message-attachment" : "file-delivery-card"
            }
            activeOpacity={0.8}
          >
            <View
              style={[
                listStyles.iconWrap,
                { backgroundColor: colors.background },
              ]}
            >
              <Feather
                name={
                  attachment.kind === "generated"
                    ? "file"
                    : isImageAttachment(attachment)
                      ? "image"
                      : "file-text"
                }
                size={14}
                color={colors.foreground}
              />
            </View>
            <View style={listStyles.nameBlock}>
              <Text
                style={[listStyles.name, { color: colors.foreground }]}
                numberOfLines={1}
                testID="attachment-name"
              >
                {attachment.name}
              </Text>
              <Text
                style={[listStyles.meta, { color: colors.mutedForeground }]}
                numberOfLines={1}
              >
                {formatFileSize(attachment.size)}
              </Text>
            </View>
            {busy ? (
              <ActivityIndicator size={14} color={colors.mutedForeground} />
            ) : (
              <Feather
                name="download"
                size={14}
                color={colors.mutedForeground}
              />
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const MODE_LABELS: Record<string, string> = {
  verify: "Verify",
  debate: "Debate",
};

export type FileActivity = {
  title: string;
  format: string;
  switchedFrom?: string;
  chars: number;
};

export function FileWritingCard({
  activity,
  colors,
}: {
  activity: FileActivity;
  colors: Colors;
}) {
  const switchedLabel = activity.switchedFrom
    ? (MODE_LABELS[activity.switchedFrom] ?? activity.switchedFrom)
    : null;
  return (
    <View
      style={[
        writingStyles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      accessibilityLiveRegion="polite"
      testID="file-writing-card"
    >
      <View style={writingStyles.headerRow}>
        <ActivityIndicator size={12} color={colors.foreground} />
        <Text
          style={[writingStyles.title, { color: colors.foreground }]}
          numberOfLines={1}
        >
          {`Writing ${activity.title}`}
        </Text>
        <Text
          style={[writingStyles.format, { color: colors.mutedForeground }]}
        >
          {activity.format.toUpperCase()}
        </Text>
      </View>
      {activity.chars > 0 && (
        <Text style={[writingStyles.meta, { color: colors.mutedForeground }]}>
          {`${activity.chars.toLocaleString()} characters so far`}
        </Text>
      )}
      {switchedLabel && (
        <Text
          style={[writingStyles.note, { color: colors.mutedForeground }]}
          testID="file-mode-note"
        >
          {`${switchedLabel} stepped aside — a single voice authors a file.`}
        </Text>
      )}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    maxWidth: "100%",
  },
  chipName: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    maxWidth: 140,
  },
  chipMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    maxWidth: 120,
  },
  thumbnail: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 1,
  },
});

const listStyles = StyleSheet.create({
  wrap: {
    gap: 6,
    marginTop: 6,
    alignSelf: "stretch",
  },
  wrapUser: {
    alignItems: "flex-end",
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 180,
    maxWidth: 280,
  },
  imageCard: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
    width: 180,
  },
  imagePreview: {
    width: "100%",
    height: 110,
  },
  imageCaption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  nameBlock: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  meta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
});

const writingStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  format: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
  },
  meta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  note: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
  },
});
