/**
 * Chat file exchange, presentational side: pending upload chips in the
 * composer, attachment chips on sent user messages, and the document card
 * an assistant turn shows while writing and after delivering a file.
 */
import { useState } from "react";
import {
  AlertTriangle,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  chatFileErrorMessage,
  downloadChatFile,
  formatFileSize,
  isImageAttachment,
  type PendingChatFile,
} from "@/lib/chat-files";
import type { VenomMessageAttachment } from "@workspace/api-client-react";

/** Chips above the composer while files upload, wait, or fail. */
export function ComposerAttachmentRow({
  items,
  onRemove,
}: {
  items: PendingChatFile[];
  onRemove: (localId: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 pt-2"
      data-testid="row-composer-attachments"
    >
      {items.map((item) => (
        <span
          key={item.localId}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs",
            item.status === "error"
              ? "border-destructive/50 text-destructive"
              : "border-border/60 text-muted-foreground",
          )}
          title={item.error}
          data-testid={`chip-pending-file-${item.status}`}
        >
          {item.thumbnail ? (
            <img
              src={item.thumbnail}
              alt=""
              className="h-7 w-7 shrink-0 rounded-md border border-border/40 object-cover"
              data-testid="img-pending-thumbnail"
            />
          ) : null}
          {item.status === "uploading" ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : item.status === "error" ? (
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          ) : item.thumbnail ? null : (
            <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          <span className="max-w-[180px] truncate">{item.name}</span>
          <span className="text-muted-foreground/60">
            {formatFileSize(item.size)}
          </span>
          <button
            type="button"
            onClick={() => onRemove(item.localId)}
            aria-label={`Remove ${item.name}`}
            className="rounded p-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="button-remove-attachment"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** Compact chips under a sent user message naming what rode along. */
export function MessageAttachmentChips({
  attachments,
}: {
  attachments: VenomMessageAttachment[];
}) {
  return (
    <div
      className="mt-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5"
      data-testid="row-message-attachments"
    >
      {attachments.map((attachment) =>
        attachment.thumbnail ? (
          <span
            key={attachment.id}
            className="flex flex-col items-end gap-1"
            data-testid="chip-message-attachment"
          >
            <img
              src={attachment.thumbnail}
              alt={attachment.name}
              title={attachment.name}
              className="h-24 max-w-[180px] rounded-lg border border-border/60 object-cover"
              data-testid="img-message-attachment"
            />
            <span className="max-w-[180px] truncate text-[11px] text-muted-foreground/70">
              {attachment.name}
            </span>
          </span>
        ) : (
          <span
            key={attachment.id}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1 text-xs text-muted-foreground"
            data-testid="chip-message-attachment"
          >
            {isImageAttachment(attachment) ? (
              <ImageIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <span className="max-w-[200px] truncate">{attachment.name}</span>
            <span className="text-muted-foreground/60">
              {formatFileSize(attachment.size)}
            </span>
          </span>
        ),
      )}
    </div>
  );
}

const FORMAT_LABELS: Record<string, string> = {
  pdf: "PDF",
  md: "Markdown",
  txt: "text",
  csv: "CSV",
};

const MODE_LABELS: Record<string, string> = {
  verify: "Verify",
  debate: "Debate",
};

/** Live card while the model is still writing the document body. */
export function FileWritingCard({
  title,
  format,
  chars,
  switchedFrom,
}: {
  title: string;
  format: string;
  chars?: number;
  switchedFrom?: string;
}) {
  return (
    <div
      className="mt-3 w-full max-w-md rounded-xl border border-border/60 p-3"
      data-testid="card-file-writing"
    >
      <div className="flex items-center gap-2.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full bg-foreground motion-safe:animate-pulse"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Writing {title}
          </div>
          <div className="text-xs text-muted-foreground" aria-live="polite">
            {FORMAT_LABELS[format] ?? format} document
            {typeof chars === "number" && chars > 0
              ? ` · ${chars.toLocaleString()} characters so far`
              : "…"}
          </div>
        </div>
      </div>
      {switchedFrom && (
        <p
          className="mt-2 border-t border-border/40 pt-2 text-xs text-muted-foreground"
          data-testid="text-file-mode-note"
        >
          {MODE_LABELS[switchedFrom] ?? switchedFrom} stepped aside — a single
          voice authors a file.
        </p>
      )}
    </div>
  );
}

/** Delivered document: name, size, and an authenticated download. */
export function FileDeliveryCard({
  attachment,
}: {
  attachment: VenomMessageAttachment;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const handleDownload = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await downloadChatFile(attachment);
    } catch (error) {
      setProblem(chatFileErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mt-3 flex w-full max-w-md items-center gap-3 rounded-xl border border-border/60 p-3"
      data-testid="card-file-delivery"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-foreground/[0.04]"
        aria-hidden="true"
      >
        <FileText className="h-4 w-4 text-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-medium text-foreground"
          data-testid="text-file-name"
        >
          {attachment.name}
        </div>
        <div className="text-xs text-muted-foreground">
          {formatFileSize(attachment.size)}
          {problem && (
            <span className="text-destructive"> · {problem}</span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 rounded-lg text-sm font-normal"
        onClick={handleDownload}
        disabled={busy}
        data-testid="button-file-download"
      >
        {busy ? (
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
        )}
        Download
      </Button>
    </div>
  );
}
