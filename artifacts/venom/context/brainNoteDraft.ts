export const BRAIN_NOTE_DRAFT_MAX_LENGTH = 5000;
export const BRAIN_NOTE_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CHANGE_NOTES = 6;
const MAX_CHANGE_NOTE_LENGTH = 160;

export type BrainNoteDraft = {
  originalDraft: string;
  suggestedDraft: string;
  changeNotes: string[];
  selectedVersion: "original" | "suggestion";
};

export type StoredBrainNoteDraft = {
  version: 1;
  updatedAt: number;
  draft: BrainNoteDraft;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function brainNoteDraftStorageKey(userId: string, projectId: string) {
  return `@venom/brain-note-draft:${encodeURIComponent(userId)}:${encodeURIComponent(projectId)}`;
}

export function sanitizeBrainNoteDraft(value: unknown): BrainNoteDraft | null {
  if (!isRecord(value)) return null;
  const originalDraft =
    typeof value.originalDraft === "string"
      ? value.originalDraft.slice(0, BRAIN_NOTE_DRAFT_MAX_LENGTH)
      : "";
  const suggestedDraft =
    typeof value.suggestedDraft === "string"
      ? value.suggestedDraft.slice(0, BRAIN_NOTE_DRAFT_MAX_LENGTH)
      : "";
  const changeNotes = Array.isArray(value.changeNotes)
    ? value.changeNotes
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, MAX_CHANGE_NOTE_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_CHANGE_NOTES)
    : [];
  const selectedVersion =
    value.selectedVersion === "suggestion" && suggestedDraft
      ? "suggestion"
      : "original";

  if (!originalDraft && !suggestedDraft) return null;
  return {
    originalDraft,
    suggestedDraft,
    changeNotes,
    selectedVersion,
  };
}

export function parseStoredBrainNoteDraft(
  value: string | null,
  now: number,
): BrainNoteDraft | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.updatedAt !== "number" ||
    now - parsed.updatedAt > BRAIN_NOTE_DRAFT_TTL_MS
  ) {
    return null;
  }
  return sanitizeBrainNoteDraft(parsed.draft);
}

export class BrainNoteDraftPersistenceQueue {
  private pending: Promise<void> = Promise.resolve();
  private isFinished = false;

  enqueue(operation: () => Promise<void>) {
    if (this.isFinished) return Promise.resolve();
    const queued = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (this.isFinished) return;
        await operation();
      });
    this.pending = queued;
    return queued;
  }

  async finish(clear: () => Promise<void>) {
    this.isFinished = true;
    await this.pending.catch(() => undefined);
    await clear();
  }
}
