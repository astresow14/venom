import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  brainNoteDraftStorageKey,
  parseStoredBrainNoteDraft,
  sanitizeBrainNoteDraft,
  type BrainNoteDraft,
  type StoredBrainNoteDraft,
} from "./brainNoteDraft";

export async function loadBrainNoteDraft(userId: string, projectId: string) {
  const key = brainNoteDraftStorageKey(userId, projectId);
  const value = await AsyncStorage.getItem(key);
  const draft = parseStoredBrainNoteDraft(value, Date.now());
  if (value && !draft) {
    await AsyncStorage.removeItem(key);
  }
  return draft;
}

export async function saveBrainNoteDraft(
  userId: string,
  projectId: string,
  draft: BrainNoteDraft,
) {
  const key = brainNoteDraftStorageKey(userId, projectId);
  const safeDraft = sanitizeBrainNoteDraft(draft);
  if (!safeDraft) {
    await AsyncStorage.removeItem(key);
    return;
  }
  const stored: StoredBrainNoteDraft = {
    version: 1,
    updatedAt: Date.now(),
    draft: safeDraft,
  };
  await AsyncStorage.setItem(key, JSON.stringify(stored));
}

export async function clearBrainNoteDraft(userId: string, projectId: string) {
  await AsyncStorage.removeItem(brainNoteDraftStorageKey(userId, projectId));
}
