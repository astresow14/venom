import { StyleSheet } from "react-native";
import { sharedWorkspaceStyles } from "@/components/sharedWorkspaceStyles";

const ownStyles = StyleSheet.create({
  // Chat Styles
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  chatList: {
    flex: 1,
  },
  messageRow: {
    marginBottom: 24,
    flexDirection: "row",
  },
  // A run-continuation row (same debate speaker as the message before it)
  // sits tight against its predecessor so the run reads as one group. The
  // list is inverted, so marginBottom is the on-screen gap ABOVE this row.
  messageRowGrouped: {
    marginBottom: 6,
  },
  // Fixed-width lane beside every speaker-attributed bubble; only the first
  // row of a run carries the avatar, the rest stay empty so bubbles align.
  speakerGutter: {
    width: 24,
    marginRight: 8,
    alignItems: "center",
  },
  messageUser: {
    justifyContent: "flex-end",
  },
  messageAssistant: {
    justifyContent: "flex-start",
  },
  messageWrap: {
    maxWidth: "85%",
    flexShrink: 1,
  },
  messageBubble: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  bubbleUser: {
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    borderBottomLeftRadius: 4,
    backgroundColor: "transparent",
  },
  messageText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    lineHeight: 24,
  },
  messageAttribution: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginTop: 4,
    marginLeft: 4,
    letterSpacing: 0.1,
  },
  errorBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 6,
  },
  errorBadgeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  citationLink: {
    fontFamily: "Inter_600SemiBold",
    textDecorationLine: "underline",
  },
  citedSourceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
    marginLeft: 4,
  },
  citedSourceChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  citedSourceChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    flexShrink: 1,
  },
  citedSourceChipMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
  },
  citationArchived: {
    fontStyle: "italic",
  },
  citationArchivedLink: {
    fontStyle: "italic",
    textDecorationLine: "underline",
  },
  newSessionRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  newSessionButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  newSessionButtonText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  sessionSheet: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "70%",
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 12,
  },
  sessionSheetHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  sessionSheetHeading: {
    flex: 1,
    gap: 2,
  },
  sessionSheetTitle: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  sessionSheetSubtitle: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  sessionSheetEmpty: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    paddingVertical: 12,
  },
  sessionSheetList: {
    flexGrow: 0,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 8,
  },
  sessionRowText: {
    flex: 1,
    gap: 2,
  },
  sessionRowTitle: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  sessionRowMeta: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  sessionRowBadge: {
    fontSize: 10,
    fontFamily: "Inter_500Medium",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: "hidden",
  },
  sessionSheetSection: {
    marginTop: 4,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(128,128,128,0.25)",
  },
  sessionSheetSectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  sessionSheetSectionHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    marginBottom: 10,
  },
  sessionFileButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  sessionFileButtonText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  modelSelectorRow: {
    marginBottom: 8,
  },
  modelSelectorScroll: {
    paddingHorizontal: 0,
    gap: 6,
    flexDirection: "row",
  },
  modelChip: {
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  // Auto-policy takeover indicator in the model selector slot: same chip
  // silhouette, but inert and icon-led, so the handover reads at a glance.
  policyChip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    gap: 6,
  },
  modelChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 0.1,
  },
  // Both header-slot views render inside the list's padded content
  // container, so they carry no horizontal inset of their own — otherwise
  // they sit 16px right of the message column they hand off to.
  typingContainer: {
    paddingVertical: 12,
    marginBottom: 16,
    alignItems: "flex-start",
  },
  deliberationPanel: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 10,
    gap: 8,
    marginBottom: 16,
  },
  deliberationHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 6,
    paddingHorizontal: 4,
    paddingTop: 2,
  },
  deliberationHeaderTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  deliberationHeaderMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    flexShrink: 1,
  },
  deliberationVoiceCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  deliberationVoiceHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deliberationVoiceName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    flexShrink: 1,
  },
  deliberationVoiceModel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    marginLeft: "auto",
  },
  deliberationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  deliberationTakeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
  },
  deliberationResult: {
    marginTop: 8,
    gap: 8,
    alignSelf: "stretch",
  },
  deliberationDisagreements: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 6,
  },
  deliberationDisagreeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deliberationDisagreeTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  deliberationDisagreeItem: {
    flexDirection: "row",
    gap: 8,
  },
  deliberationDisagreeBullet: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    marginTop: 8,
  },
  deliberationDisagreeText: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 20,
    flex: 1,
  },
  deliberationAgreement: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginLeft: 4,
  },
  deliberationToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    marginLeft: 2,
    alignSelf: "flex-start",
  },
  deliberationToggleText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  deliberationTakeCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  modeSwitchRow: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  blendSection: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: "center",
    gap: 8,
  },
  cornerPickerToggle: {
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  cornerPickerToggleText: {
    fontSize: 11.5,
    fontWeight: "500",
    textDecorationLine: "underline",
  },
  cornerPickerRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 6,
  },
  cornerPickChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  cornerPickChipText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  blendCollapseButton: {
    position: "absolute",
    top: 0,
    right: 16,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  blendCollapsedRow: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    alignItems: "center",
  },
  blendSummaryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  blendSummaryChipText: {
    fontSize: 11.5,
    fontWeight: "500",
  },
  stopButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
    alignSelf: "flex-end",
    marginBottom: 4,
  },
  stopButtonSquare: {
    width: 10,
    height: 10,
    borderRadius: 2,
  },
  speakerChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
    paddingHorizontal: 2,
  },
  speakerName: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.1,
  },
  speakerModel: {
    fontSize: 11.5,
    flexShrink: 1,
  },
  debateFailedNote: {
    fontSize: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
  },
  emptyAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  emptyText: {
    fontSize: 20,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  inputContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  unsyncedNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 8,
  },
  unsyncedNoticeText: {
    flex: 1,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: "Inter_500Medium",
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 28,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    paddingTop: 8,
    paddingBottom: 8,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  voiceButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  filingNotices: {
    paddingHorizontal: 16,
    gap: 6,
    marginBottom: 6,
  },
  filingNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filingNoticeText: {
    flex: 1,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    lineHeight: 16,
  },
  filingNoticeAction: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
});

// Composed so existing `styles.<key>` references keep working for the few
// primitives every workspace shares.
export const styles = { ...sharedWorkspaceStyles, ...ownStyles };
