import { StyleSheet } from "react-native";
import { sharedWorkspaceStyles } from "@/components/sharedWorkspaceStyles";

const ownStyles = StyleSheet.create({
  feedScrollContent: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40,
  },
  feedSuggestionCard: {
    borderRadius: 16,
    gap: 5,
    marginBottom: 14,
    padding: 16,
  },
  feedSuggestionTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  feedSuggestionLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    opacity: 0.7,
  },
  feedSuggestionTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  feedSuggestionCopy: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 18,
    opacity: 0.78,
  },
  feedSuggestionHint: {
    fontFamily: "Inter_500Medium",
    fontSize: 9,
    letterSpacing: 0.6,
    marginTop: 3,
    opacity: 0.55,
    textTransform: "uppercase",
  },
  feedHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  feedEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0,
    marginBottom: 6,
  },
  feedTitle: {
    fontSize: 30,
    fontFamily: "Inter_700Bold",
    letterSpacing: -1,
  },
  feedList: {
    gap: 10,
  },
  feedCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  feedIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  feedCardBody: {
    flex: 1,
    minWidth: 0,
  },
  feedCardMeta: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 5,
  },
  feedCardLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0,
  },
  feedCardTime: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
  feedCardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 21,
    marginBottom: 4,
  },
  feedCardDetail: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
  },
  feedEmpty: {
    alignItems: "center",
    paddingTop: 110,
    paddingHorizontal: 28,
  },
  feedEmptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  feedEmptyTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 8,
  },
  feedEmptyText: {
    textAlign: "center",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 21,
  },
});

// Composed so existing `styles.<key>` references keep working for the few
// primitives every workspace shares.
export const styles = { ...sharedWorkspaceStyles, ...ownStyles };
