import { StyleSheet } from "react-native";

// Style primitives shared by more than one workspace tab. Keep this file
// small: a key belongs here only while several workspaces genuinely use it.
export const sharedWorkspaceStyles = StyleSheet.create({
  workspaceContainer: {
    flex: 1,
  },
  settingsIconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
});
