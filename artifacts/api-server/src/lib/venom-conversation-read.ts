/**
 * Read-only conversation lookups against a stored workspace snapshot.
 *
 * Brain evidence cites conversations by id, but a device only holds the
 * slice of the workspace it has synced. The per-conversation GET serves the
 * cloud copy for read-only viewing, so its lookup lives here as a pure
 * function over the stored state blob — testable without a database.
 *
 * Snapshots are schema-validated on write, so the defensive guards here
 * only matter for blobs saved before validation tightened. Unknown fields
 * are dropped and known ones bounded so the response always matches the
 * VenomRemoteConversation contract. Heavy per-message internals
 * (deliberation transcripts, model ids, response modes) are intentionally
 * omitted: the payload is the readable exchange.
 */

const MAX_ID_LENGTH = 120;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_NAME_LENGTH = 80;
const MAX_SPEAKER_ID_LENGTH = 64;
const MAX_MESSAGES = 1_000;

const MESSAGE_ROLES = new Set(["user", "assistant"]);
const MESSAGE_STATUSES = new Set(["sending", "sent", "error"]);

export type RemoteConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "sending" | "sent" | "error";
  modelName?: string;
  speakerId?: string;
  speakerName?: string;
};

export type RemoteConversationRead = {
  conversation: {
    id: string;
    title: string;
    projectId: string | null;
    updatedAt: number;
    messages: RemoteConversationMessage[];
  };
  projectName: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.slice(0, maxLength);
}

function epochMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeMessage(value: unknown): RemoteConversationMessage | null {
  const record = asRecord(value);
  if (!record) return null;

  const id = boundedString(record.id, MAX_ID_LENGTH);
  const role = record.role;
  if (
    !id ||
    typeof record.content !== "string" ||
    typeof role !== "string" ||
    !MESSAGE_ROLES.has(role)
  ) {
    return null;
  }

  const message: RemoteConversationMessage = {
    id,
    role: role as RemoteConversationMessage["role"],
    content: record.content.slice(0, MAX_CONTENT_LENGTH),
    createdAt: epochMs(record.createdAt),
    // Status is presentational; a cloud copy captured mid-send still reads
    // fine, and anything unrecognized degrades to the neutral "sent".
    status: (typeof record.status === "string" &&
    MESSAGE_STATUSES.has(record.status)
      ? record.status
      : "sent") as RemoteConversationMessage["status"],
  };

  const modelName = boundedString(record.modelName, MAX_NAME_LENGTH);
  if (modelName) message.modelName = modelName;
  const speakerId = boundedString(record.speakerId, MAX_SPEAKER_ID_LENGTH);
  if (speakerId) message.speakerId = speakerId;
  const speakerName = boundedString(record.speakerName, MAX_NAME_LENGTH);
  if (speakerName) message.speakerName = speakerName;

  return message;
}

/**
 * Finds one conversation in a stored workspace state and returns it in the
 * shape the conversation GET promises. The project name is resolved from the
 * same snapshot because the requesting device may not hold the project
 * either. Returns null when the snapshot holds no such conversation.
 */
export function readWorkspaceConversation(
  state: unknown,
  conversationId: string,
): RemoteConversationRead | null {
  const stateRecord = asRecord(state);
  if (!stateRecord) return null;

  const conversations = Array.isArray(stateRecord.conversations)
    ? stateRecord.conversations
    : [];
  const found = conversations
    .map(asRecord)
    .find((record) => record?.id === conversationId);
  if (!found) return null;

  const projectId = boundedString(found.projectId, MAX_ID_LENGTH);

  let projectName: string | null = null;
  if (projectId) {
    const projects = Array.isArray(stateRecord.projects)
      ? stateRecord.projects
      : [];
    const project = projects
      .map(asRecord)
      .find((record) => record?.id === projectId);
    projectName = project ? boundedString(project.name, MAX_TITLE_LENGTH) : null;
  }

  const rawMessages = Array.isArray(found.messages) ? found.messages : [];
  const messages = rawMessages
    .map(normalizeMessage)
    .filter((message): message is RemoteConversationMessage => message !== null)
    // Legacy blobs may exceed today's write cap; keep the newest exchange.
    .slice(-MAX_MESSAGES);

  return {
    conversation: {
      id: conversationId,
      title:
        boundedString(found.title, MAX_TITLE_LENGTH) ?? "Untitled conversation",
      projectId,
      updatedAt: epochMs(found.updatedAt),
      messages,
    },
    projectName,
  };
}
