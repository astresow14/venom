import { Platform, Share } from "react-native";

/**
 * Delivering a markdown export on mobile. The export endpoints return the
 * file body as a string; on web we hand it to the browser as a real .md
 * download, and on native we open the OS share sheet so the user picks
 * where the file goes (Files, mail, another app). File naming mirrors the
 * server's Content-Disposition pattern so saved files look the same
 * regardless of which client produced them.
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

type WebDocument = {
  createElement: (tag: string) => {
    href: string;
    download: string;
    click: () => void;
    remove: () => void;
  };
  body: { appendChild: (node: unknown) => void };
};

type WebUrl = {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (href: string) => void;
};

export async function deliverMarkdown(
  filename: string,
  content: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const doc = (globalThis as { document?: WebDocument }).document;
    const webUrl = (globalThis as { URL?: WebUrl }).URL;
    if (doc && typeof webUrl?.createObjectURL === "function") {
      const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
      const href = webUrl.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      doc.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      webUrl.revokeObjectURL(href);
      return;
    }
  }
  await Share.share({ title: filename, message: content });
}
