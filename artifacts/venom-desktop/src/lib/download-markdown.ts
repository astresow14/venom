/**
 * Browser-side markdown download: the export endpoints return the file body
 * as a string (the response is text/markdown), so the client wraps it in a
 * Blob and clicks a temporary anchor. File naming mirrors the server's
 * Content-Disposition pattern so a saved file looks the same either way.
 */

export function markdownExportFileName(
  scope: string,
  kind: "brain" | "sops",
  now: Date = new Date(),
): string {
  const safeScope =
    scope
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "export";
  const day = now.toISOString().slice(0, 10);
  return `venom-${safeScope}-${kind}-${day}.md`;
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
