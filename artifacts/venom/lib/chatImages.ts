import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/**
 * Image handling for chat attachments, mobile side. Mirrors the desktop
 * split: a tiny JPEG thumbnail (data URL) that rides the attachment stamp
 * through synced history, and an upload rendition that downscales huge
 * photos (and converts HEIC) before the storage PUT.
 *
 * GIFs skip the upload re-encode — a manipulator pass would freeze the
 * first frame. Every failure path degrades to "no thumbnail" / "original
 * file"; pixels are never required for the attach flow to work.
 */

/** Mirrors the contract bound on VenomMessageAttachment.thumbnail. */
export const MAX_THUMBNAIL_CHARS = 24_000;

const UPLOAD_MAX_EDGE_PX = 2048;
/** Above this byte count a non-GIF image is worth re-encoding for upload. */
const UPLOAD_RECODE_THRESHOLD_BYTES = 2_500_000;

/** What the photo/document pickers hand us, reduced to what images need. */
export type PickedImageSource = {
  uri: string;
  name?: string | null;
  size?: number | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  /** Web pickers may carry the real File; uploads prefer it. */
  file?: File;
};

function extensionOf(name: string | null | undefined): string {
  if (!name) return "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isGif(source: PickedImageSource): boolean {
  return (
    source.mimeType === "image/gif" || extensionOf(source.name) === "gif"
  );
}

function needsJpegConversion(source: PickedImageSource): boolean {
  const extension = extensionOf(source.name);
  return (
    extension === "heic" ||
    extension === "heif" ||
    source.mimeType === "image/heic" ||
    source.mimeType === "image/heif"
  );
}

/**
 * Bound the long edge: resize({width}) preserves ratio, so pick the axis
 * that is actually the long one when dimensions are known.
 */
function boundedResize(
  source: PickedImageSource,
  edge: number,
): { width?: number; height?: number } {
  const width = source.width ?? 0;
  const height = source.height ?? 0;
  if (width > 0 && height > 0 && height > width) return { height: edge };
  return { width: edge };
}

async function renderJpeg(
  source: PickedImageSource,
  edge: number | null,
  compress: number,
  base64: boolean,
): Promise<{ uri: string; base64?: string }> {
  const context = ImageManipulator.manipulate(source.uri);
  if (edge != null) context.resize(boundedResize(source, edge));
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress,
    base64,
  });
  return { uri: saved.uri, base64: saved.base64 ?? undefined };
}

/**
 * Tiny JPEG data-URL preview for an image attachment, or null when the
 * platform cannot decode the file. Steps down until it fits the bound
 * the synced stamp enforces.
 */
export async function makeImageThumbnail(
  source: PickedImageSource,
): Promise<string | null> {
  try {
    for (const [edge, quality] of [
      [144, 0.55],
      [96, 0.45],
      [64, 0.35],
    ] as const) {
      const { base64 } = await renderJpeg(source, edge, quality, true);
      if (!base64) return null;
      const dataUrl = `data:image/jpeg;base64,${base64}`;
      if (dataUrl.length <= MAX_THUMBNAIL_CHARS) return dataUrl;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The source that should actually be uploaded: HEIC always converts to
 * JPEG (the server does not accept it), oversized photos downscale, GIFs
 * and small images pass through. Falls back to the original on failure.
 */
export async function prepareImageForUpload(
  source: PickedImageSource,
): Promise<PickedImageSource> {
  if (isGif(source)) return source;
  const longEdge = Math.max(source.width ?? 0, source.height ?? 0);
  const oversizedPixels = longEdge > UPLOAD_MAX_EDGE_PX;
  const oversizedBytes = (source.size ?? 0) > UPLOAD_RECODE_THRESHOLD_BYTES;
  const convert = needsJpegConversion(source);
  if (!oversizedPixels && !oversizedBytes && !convert) return source;
  try {
    const { uri } = await renderJpeg(
      source,
      oversizedPixels ? UPLOAD_MAX_EDGE_PX : null,
      0.85,
      false,
    );
    const stem =
      (source.name ?? "image").replace(/\.[A-Za-z0-9]{1,8}$/, "") || "image";
    return {
      uri,
      name: `${stem}.jpg`,
      mimeType: "image/jpeg",
      // Size is unknown until the bytes are read; the upload computes it.
      size: null,
    };
  } catch {
    return source;
  }
}
