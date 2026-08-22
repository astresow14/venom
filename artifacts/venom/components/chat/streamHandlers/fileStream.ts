import type { VenomMessageAttachment } from "@workspace/api-client-react";
import type { FileActivity } from "@/components/ChatFileCards";

/**
 * File-authoring SSE events, isolated from the response modes: the plan
 * announcement, growth ticks, and the stored file. `handleEvent` never
 * consumes the event — attribution and content can ride the same event — so
 * it always returns false and the pipeline continues.
 */
export function createFileStreamHandler(deps: {
  /** Mirrors the live writing card into transient UI state. */
  publish: (activity: FileActivity | null) => void;
  setShowTyping: (value: boolean) => void;
}) {
  let activity: FileActivity | null = null;
  let deliveredFile: VenomMessageAttachment | null = null;
  let renderFailed = false;

  return {
    /**
     * The answer already streamed; only the document failed. Keep the reply
     * and drop the writing card — the miss is announced once the turn
     * persists.
     */
    markRenderFailed() {
      renderFailed = true;
      activity = null;
      deps.publish(null);
    },
    handleEvent(parsed: any): boolean {
      if (parsed.filePlan && typeof parsed.filePlan === "object") {
        activity = {
          title: String(parsed.filePlan.title ?? "Document"),
          format: String(parsed.filePlan.format ?? "pdf"),
          switchedFrom:
            typeof parsed.filePlan.switchedFrom === "string"
              ? parsed.filePlan.switchedFrom
              : undefined,
          chars: 0,
        };
        deps.setShowTyping(false);
        deps.publish({ ...activity });
      }
      if (parsed.fileProgress && activity) {
        activity.chars = Number(parsed.fileProgress.chars ?? 0) || 0;
        deps.publish({ ...activity });
      }
      if (
        parsed.file &&
        typeof parsed.file === "object" &&
        parsed.file.id
      ) {
        deliveredFile = {
          id: String(parsed.file.id),
          name: String(parsed.file.name ?? "document"),
          contentType: String(
            parsed.file.contentType ?? "application/octet-stream",
          ),
          size: Number(parsed.file.size ?? 0) || 0,
          kind: parsed.file.kind === "upload" ? "upload" : "generated",
        };
        activity = null;
        deps.publish(null);
      }
      return false;
    },
    /** The stored file this turn delivered, if any. */
    get deliveredFile() {
      return deliveredFile;
    },
    /** Whether the document render failed after the answer streamed. */
    get renderFailed() {
      return renderFailed;
    },
  };
}

export type FileStreamHandler = ReturnType<typeof createFileStreamHandler>;
