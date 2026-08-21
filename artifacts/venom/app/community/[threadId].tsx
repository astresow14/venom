import React, { useState, useCallback, useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform, Share, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Linking from "expo-linking";
import * as Crypto from "expo-crypto";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { 
  useGetCommunityThread, 
  useCreateCommunityReply, 
  useDeleteCommunityThread, 
  useDeleteCommunityReply,
  useCreateCommunityReport,
  useUpdateCommunityThread,
  useUpdateCommunityReply,
  useGetCommunityProfile,
  CommunityReply,
  CommunityReportInputTargetType,
  CommunityReportInputReason
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCommunityVoting } from "@/components/community/useCommunityVoting";
import { CommunityActionMenu } from "@/components/community/CommunityActionMenu";

function formatRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diffInSeconds < 60) return "Just now";
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d ago`;
  return date.toLocaleDateString();
}

export default function ThreadDetailScreen() {
  const { threadId, replyId } = useLocalSearchParams<{
    threadId: string;
    replyId?: string;
  }>();
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const { data: profile } = useGetCommunityProfile({
    query: {
      queryKey: ["/api/venom/community/profile"],
      retry: false
    }
  });

  const { data, isLoading, isError, refetch } = useGetCommunityThread(
    threadId,
    replyId ? { replyId } : undefined,
    {
      query: {
        enabled: !!threadId,
        queryKey: [
          "/api/venom/community/threads",
          threadId,
          replyId ?? null,
        ],
      },
    },
  );

  const { toggleVote, isPending: isVotePending } = useCommunityVoting();
  const replyMutation = useCreateCommunityReply();
  const updateThreadMutation = useUpdateCommunityThread();
  const updateReplyMutation = useUpdateCommunityReply();
  const deleteThreadMutation = useDeleteCommunityThread();
  const deleteReplyMutation = useDeleteCommunityReply();
  const reportMutation = useCreateCommunityReport();

  const [replyBody, setReplyBody] = useState("");
  const [replyRequestId, setReplyRequestId] = useState(() =>
    Crypto.randomUUID(),
  );
  const [activeParentReplyId, setActiveParentReplyId] = useState<string | null>(
    null,
  );
  const [highlightedReplyId, setHighlightedReplyId] = useState<string | null>(
    replyId ?? null,
  );
  const repliesRef = useRef<FlatList<CommunityReply>>(null);
  const [menuTarget, setMenuTarget] = useState<{ type: 'thread' | 'reply', id: string, isAuthor: boolean, currentBody?: string } | null>(null);

  const [editingTarget, setEditingTarget] = useState<{ type: 'thread' | 'reply', id: string } | null>(null);
  const [editingBody, setEditingBody] = useState("");

  useEffect(() => {
    if (!replyId || !data) return;
    const replyIndex = data.replies.findIndex((reply) => reply.id === replyId);
    if (replyIndex < 0) return;
    setHighlightedReplyId(replyId);
    const frame = requestAnimationFrame(() => {
      repliesRef.current?.scrollToIndex({
        index: replyIndex,
        animated: true,
        viewPosition: 0.35,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [data, replyId]);

  const handleActionRequiringProfile = useCallback(
    (action: () => void) => {
      if (!profile) {
        if (Platform.OS !== 'web') {
          Alert.alert(
            "Profile Required",
            "You need to set up a quick community profile before interacting.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Set Up Profile", onPress: () => router.push("/community/profile" as any) }
            ]
          );
        } else {
          router.push("/community/profile" as any);
        }
      } else {
        action();
      }
    },
    [profile, router]
  );

  const handleShare = async () => {
    if (!data) return;
    try {
      const url = process.env.EXPO_PUBLIC_DOMAIN 
        ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/community/${threadId}`
        : Linking.createURL(`/community/${threadId}`);
      
      await Share.share({
        message: Platform.OS === "web" ? url : `Read ${data.thread.author.displayName}'s thread on Venom: ${url}`,
        url: Platform.OS === "ios" ? url : undefined,
      });
    } catch (e: any) {
      if (Platform.OS === 'web') {
        window.alert(`Could not share: ${e.message}`);
      } else {
        Alert.alert("Share Failed", e.message);
      }
    }
  };

  const handlePostReply = () => {
    if (!replyBody.trim() || !threadId) return;
    replyMutation.mutate(
      {
        threadId,
        data: {
          body: replyBody.trim(),
          clientRequestId: replyRequestId,
          ...(activeParentReplyId
            ? { parentReplyId: activeParentReplyId }
            : {}),
        },
      },
      {
        onSuccess: () => {
          setReplyBody("");
          setActiveParentReplyId(null);
          setReplyRequestId(Crypto.randomUUID());
          queryClient.invalidateQueries({ queryKey: ["/api/venom/community/threads", threadId] });
        },
        onError: () => {
          if (Platform.OS === 'web') {
            window.alert("Could not send this reply. Please try again.");
          } else {
            Alert.alert(
              "Reply Failed",
              "Could not send this reply. Please try again.",
            );
          }
        }
      }
    );
  };

  const handleSaveEdit = () => {
    if (!editingTarget || !editingBody.trim()) return;

    if (editingTarget.type === 'thread') {
      updateThreadMutation.mutate(
        { threadId: editingTarget.id, data: { body: editingBody.trim() } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/venom/community/threads", threadId] });
            queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
            setEditingTarget(null);
          },
          onError: (err: any) => {
            if (Platform.OS === 'web') {
              window.alert(`Failed to update thread: ${err.message || 'Unknown error'}`);
            } else {
              Alert.alert("Update Failed", err.message || 'Unknown error');
            }
          }
        }
      );
    } else {
      updateReplyMutation.mutate(
        { replyId: editingTarget.id, data: { body: editingBody.trim() } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/venom/community/threads", threadId] });
            setEditingTarget(null);
          },
          onError: (err: any) => {
            if (Platform.OS === 'web') {
              window.alert(`Failed to update reply: ${err.message || 'Unknown error'}`);
            } else {
              Alert.alert("Update Failed", err.message || 'Unknown error');
            }
          }
        }
      );
    }
  };

  const handleDelete = () => {
    if (!menuTarget) return;

    const confirmDelete = () => {
      if (menuTarget.type === 'thread') {
        deleteThreadMutation.mutate(
          { threadId: menuTarget.id },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: ["/api/venom/community/briefing"] });
              setMenuTarget(null);
              router.back();
            },
            onError: (err: any) => {
              if (Platform.OS === 'web') {
                window.alert(`Failed to delete thread: ${err.message || 'Unknown error'}`);
              } else {
                Alert.alert("Delete Failed", err.message || 'Unknown error');
              }
              setMenuTarget(null);
            }
          }
        );
      } else {
        deleteReplyMutation.mutate(
          { replyId: menuTarget.id },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: ["/api/venom/community/threads", threadId] });
              setMenuTarget(null);
            },
            onError: (err: any) => {
              if (Platform.OS === 'web') {
                window.alert(`Failed to delete reply: ${err.message || 'Unknown error'}`);
              } else {
                Alert.alert("Delete Failed", err.message || 'Unknown error');
              }
              setMenuTarget(null);
            }
          }
        );
      }
    };

    if (Platform.OS === 'web') {
      if (window.confirm("Are you sure you want to delete this?")) {
        confirmDelete();
      } else {
        setMenuTarget(null);
      }
    } else {
      Alert.alert(
        "Delete Confirmation",
        "Are you sure you want to delete this?",
        [
          { text: "Cancel", style: "cancel", onPress: () => setMenuTarget(null) },
          { text: "Delete", style: "destructive", onPress: confirmDelete }
        ]
      );
    }
  };

  const handleReport = () => {
    if (!menuTarget) return;
    
    const confirmReport = () => {
      reportMutation.mutate(
        {
          data: {
            targetType: menuTarget.type as CommunityReportInputTargetType,
            targetId: menuTarget.id,
            reason: "spam" as CommunityReportInputReason
          }
        },
        {
          onSuccess: () => {
            setMenuTarget(null);
            if (Platform.OS === 'web') {
              window.alert('Report submitted successfully.');
            } else {
              Alert.alert("Reported", "Thank you for keeping the community safe.");
            }
          },
          onError: (err: any) => {
            if (Platform.OS === 'web') {
              window.alert(`Failed to report: ${err.message || 'Unknown error'}`);
            } else {
              Alert.alert("Report Failed", err.message || 'Unknown error');
            }
            setMenuTarget(null);
          }
        }
      );
    };

    if (Platform.OS === 'web') {
      if (window.confirm("Are you sure you want to report this for spam?")) {
        confirmReport();
      } else {
        setMenuTarget(null);
      }
    } else {
      Alert.alert(
        "Report Content",
        "Are you sure you want to report this content?",
        [
          { text: "Cancel", style: "cancel", onPress: () => setMenuTarget(null) },
          { text: "Report", style: "destructive", onPress: confirmReport }
        ]
      );
    }
  };

  const openEdit = () => {
    if (!menuTarget || !menuTarget.currentBody) return;
    setEditingTarget({ type: menuTarget.type, id: menuTarget.id });
    setEditingBody(menuTarget.currentBody);
    setMenuTarget(null);
  };

  const renderReply = ({ item }: { item: CommunityReply }) => {
    const isEditing = editingTarget?.id === item.id;
    return (
      <View
        nativeID={`reply-${item.id}`}
        style={[
          styles.replyCard,
          { borderBottomColor: colors.border },
          highlightedReplyId === item.id && [
            styles.highlightedReply,
            { borderColor: colors.foreground },
          ],
        ]}
        accessibilityLabel={
          highlightedReplyId === item.id
            ? `Opened reply from ${item.author.displayName}`
            : undefined
        }
      >
        <View style={styles.replyHeader}>
          <View style={styles.authorRow}>
            <View style={[styles.avatarSmall, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.avatarTextSmall, { color: colors.foreground }]}>
                {item.author.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View>
              <Text style={[styles.authorName, { color: colors.foreground }]}>{item.author.displayName}</Text>
              <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
                {formatRelativeTime(item.createdAt)}
              </Text>
            </View>
          </View>
          <TouchableOpacity 
            hitSlop={10} 
            accessibilityRole="button"
            accessibilityLabel="Reply options"
            onPress={() => setMenuTarget({ type: 'reply', id: item.id, isAuthor: item.viewerIsAuthor, currentBody: item.body })}
          >
            <Feather name="more-horizontal" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
        
        {isEditing ? (
          <View style={styles.editContainer}>
            <TextInput
              style={[styles.editInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
              value={editingBody}
              onChangeText={setEditingBody}
              multiline
              autoFocus
              maxLength={1000}
            />
            <View style={styles.editActions}>
              <TouchableOpacity onPress={() => setEditingTarget(null)} style={styles.editCancelBtn}>
                <Text style={[styles.editActionText, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={handleSaveEdit} 
                style={[styles.editSaveBtn, { backgroundColor: colors.primary }]}
                disabled={updateReplyMutation.isPending}
              >
                {updateReplyMutation.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.editActionText, { color: colors.primaryForeground }]}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View>
            <Text style={[styles.replyBody, { color: colors.foreground }]}>{item.body}</Text>
            <TouchableOpacity
              style={styles.replyActionButton}
              onPress={() => {
                setActiveParentReplyId(item.id);
                setReplyRequestId(Crypto.randomUUID());
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Reply to ${item.author.displayName}`}
            >
              <Feather name="message-square" size={14} color={colors.mutedForeground} />
              <Text style={[styles.replyActionText, { color: colors.mutedForeground }]}>Reply</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  const renderHeader = () => {
    if (!data) return null;
    const { thread } = data;
    const isEditing = editingTarget?.id === thread.id;

    return (
      <View style={[styles.threadSection, { borderBottomColor: colors.border }]}>
        <View style={styles.threadHeaderRow}>
          <View style={styles.authorRow}>
            <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
              <Text style={[styles.avatarText, { color: colors.foreground }]}>
                {thread.author.displayName.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View>
              <Text style={[styles.authorNameLarge, { color: colors.foreground }]}>{thread.author.displayName}</Text>
              <Text style={[styles.timeText, { color: colors.mutedForeground }]}>
                {formatRelativeTime(thread.createdAt)}
              </Text>
            </View>
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity onPress={handleShare} hitSlop={10} accessibilityRole="button" accessibilityLabel="Share thread">
              <Feather name="share" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
            <TouchableOpacity
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Thread options"
              onPress={() => setMenuTarget({ type: 'thread', id: thread.id, isAuthor: thread.viewerIsAuthor, currentBody: thread.body })}
            >
              <Feather name="more-horizontal" size={18} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        </View>

        {isEditing ? (
          <View style={styles.editContainer}>
            <TextInput
              style={[styles.editInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background, minHeight: 100 }]}
              value={editingBody}
              onChangeText={setEditingBody}
              multiline
              autoFocus
              maxLength={2000}
            />
            <View style={styles.editActions}>
              <TouchableOpacity onPress={() => setEditingTarget(null)} style={styles.editCancelBtn}>
                <Text style={[styles.editActionText, { color: colors.mutedForeground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={handleSaveEdit} 
                style={[styles.editSaveBtn, { backgroundColor: colors.primary }]}
                disabled={updateThreadMutation.isPending}
              >
                {updateThreadMutation.isPending ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.editActionText, { color: colors.primaryForeground }]}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <Text style={[styles.threadBodyLarge, { color: colors.foreground }]}>{thread.body}</Text>
        )}

        {thread.summary && (
          <View style={[styles.summaryBox, { backgroundColor: colors.secondary }]}>
            <View style={styles.summaryHeader}>
              <Feather name="cpu" size={12} color={colors.primary} />
              <Text style={[styles.summaryLabel, { color: colors.primary }]}>{thread.summary.label}</Text>
            </View>
            <Text style={[styles.summaryText, { color: colors.secondaryForeground }]}>
              {thread.summary.text}
            </Text>
          </View>
        )}

        <View style={styles.threadFooter}>
          <TouchableOpacity
            style={[
              styles.actionButton,
              thread.viewerHasUpvoted && { backgroundColor: colors.primary },
              isVotePending(thread.id) && { opacity: 0.5 }
            ]}
            disabled={isVotePending(thread.id)}
            onPress={() => handleActionRequiringProfile(() => toggleVote(thread.id, thread.viewerHasUpvoted))}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={thread.viewerHasUpvoted ? "Remove upvote" : "Upvote thread"}
            accessibilityState={{ checked: thread.viewerHasUpvoted, disabled: isVotePending(thread.id) }}
          >
            <Feather
              name="arrow-up"
              size={14}
              color={thread.viewerHasUpvoted ? colors.primaryForeground : colors.mutedForeground}
            />
            <Text
              style={[
                styles.actionText,
                { color: thread.viewerHasUpvoted ? colors.primaryForeground : colors.mutedForeground },
              ]}
            >
              {thread.score}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

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
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Thread</Text>
        <View style={{ width: 40 }} />
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : isError || !data ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={24} color={colors.mutedForeground} style={{ marginBottom: 12 }} />
          <Text style={{ color: colors.mutedForeground }}>Could not load thread</Text>
          <TouchableOpacity style={[styles.retryBtn, { borderColor: colors.border }]} onPress={() => refetch()}>
            <Text style={{ color: colors.foreground }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          ref={repliesRef}
          data={data.replies}
          renderItem={renderReply}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          onScrollToIndexFailed={({ index }) => {
            setTimeout(() => {
              repliesRef.current?.scrollToIndex({
                index,
                animated: true,
                viewPosition: 0.35,
              });
            }, 120);
          }}
          ListEmptyComponent={
            <View style={styles.emptyReplies}>
              <Text style={{ color: colors.mutedForeground }}>No replies yet. Be the first!</Text>
            </View>
          }
        />
      )}

      {data && (
        <View style={[styles.replyInputWrapper, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {activeParentReplyId && (
            <View style={[styles.parentReplyTarget, { backgroundColor: colors.secondary }]}>
              <View style={styles.parentReplyTargetTextRow}>
                <Feather name="corner-down-right" size={12} color={colors.mutedForeground} style={{ marginTop: 2 }} />
                <Text style={[styles.parentReplyTargetText, { color: colors.mutedForeground }]} numberOfLines={1}>
                  Replying to{" "}
                  {data.replies.find(
                    (reply) => reply.id === activeParentReplyId,
                  )?.author.displayName ?? "this reply"}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  setActiveParentReplyId(null);
                  setReplyRequestId(Crypto.randomUUID());
                }}
                accessibilityRole="button"
                accessibilityLabel="Cancel replying to comment"
                hitSlop={8}
              >
                <Feather name="x" size={14} color={colors.mutedForeground} />
              </TouchableOpacity>
            </View>
          )}
          <View style={styles.replyInputContainer}>
            <TextInput
              style={[styles.replyInput, { color: colors.foreground, backgroundColor: colors.background, borderColor: colors.border }]}
              placeholder={activeParentReplyId ? "Write a reply..." : "Write a comment..."}
              placeholderTextColor={colors.mutedForeground}
              value={replyBody}
              onChangeText={(value) => {
                setReplyBody(value);
                setReplyRequestId(Crypto.randomUUID());
              }}
              multiline
              maxLength={1000}
              accessibilityLabel="Reply text input"
            />
            <TouchableOpacity
              style={[styles.sendButton, { backgroundColor: colors.primary }, (!replyBody.trim() || replyMutation.isPending) && { opacity: 0.5 }]}
              disabled={!replyBody.trim() || replyMutation.isPending}
              onPress={() => handleActionRequiringProfile(handlePostReply)}
              accessibilityRole="button"
              accessibilityLabel="Send reply"
              accessibilityState={{ disabled: !replyBody.trim() || replyMutation.isPending }}
            >
              {replyMutation.isPending ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <Feather name="send" size={16} color={colors.primaryForeground} />
              )}
            </TouchableOpacity>
          </View>
        </View>
      )}

      <CommunityActionMenu
        visible={menuTarget !== null}
        onClose={() => setMenuTarget(null)}
        viewerIsAuthor={menuTarget?.isAuthor ?? false}
        onEdit={openEdit}
        onDelete={handleDelete}
        onReport={handleReport}
      />
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
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  retryBtn: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginTop: 16 },
  listContent: { paddingBottom: 24 },
  threadSection: { padding: 16, borderBottomWidth: 8 },
  threadHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  authorRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontFamily: "Inter_600SemiBold" },
  authorNameLarge: { fontSize: 16, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  timeText: { fontSize: 13, fontFamily: "Inter_400Regular" },
  headerActions: { flexDirection: "row", gap: 16, alignItems: "center", paddingTop: 8 },
  threadBodyLarge: { fontSize: 17, fontFamily: "Inter_400Regular", lineHeight: 26, marginBottom: 24 },
  summaryBox: { borderRadius: 12, padding: 16, marginBottom: 24 },
  summaryHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  summaryLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5 },
  summaryText: { fontSize: 14, fontFamily: "Inter_400Regular", lineHeight: 20 },
  threadFooter: { flexDirection: "row" },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "transparent",
  },
  actionText: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  replyCard: { padding: 16, borderBottomWidth: 1 },
  highlightedReply: {
    borderWidth: 2,
  },
  replyHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 },
  avatarSmall: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  avatarTextSmall: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  authorName: { fontSize: 14, fontFamily: "Inter_600SemiBold", marginBottom: 2 },
  replyBody: { fontSize: 15, fontFamily: "Inter_400Regular", lineHeight: 22, marginBottom: 8 },
  replyActionButton: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  replyActionText: { fontSize: 13, fontFamily: "Inter_500Medium" },
  emptyReplies: { padding: 40, alignItems: "center" },
  replyInputWrapper: {
    borderTopWidth: 1,
  },
  replyInputContainer: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 12,
  },
  parentReplyTarget: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  parentReplyTargetTextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  parentReplyTargetText: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  replyInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  editContainer: {
    marginBottom: 16,
  },
  editInput: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 60,
    textAlignVertical: "top",
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 12,
    gap: 12,
  },
  editCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  editSaveBtn: {
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 16,
  },
  editActionText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
});
