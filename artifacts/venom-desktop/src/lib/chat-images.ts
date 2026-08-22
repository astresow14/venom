/**
 * Image handling for chat attachments, browser side.
 *
 * Two canvas passes with different jobs:
 * - a tiny JPEG thumbnail (data URL) that rides the attachment stamp through
 *   synced history, hard-bounded because stamps live in the workspace blob;
 * - an upload rendition that downscales huge photos before the storage PUT
 *   so a 40-megapixel shot doesn't burn the 10 MB cap or provider budgets.
 *
 * GIFs are exempt from re-encoding (a canvas pass would freeze the first
 * frame); they upload as-is under the ordinary size cap. Every failure path
 * degrades to "no thumbnail" / "original file" — pixels are never required
 * for the attach flow to work.
 */

/** Mirrors the contract bound on VenomMessageAttachment.thumbnail. */
export const MAX_THUMBNAIL_CHARS = 24_000;

const THUMBNAIL_EDGE_PX = 144;
const UPLOAD_MAX_EDGE_PX = 2048;
/** Above this byte count a non-GIF image is worth re-encoding for upload. */
const UPLOAD_RECODE_THRESHOLD_BYTES = 2_500_000;

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The image could not be decoded."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dimensionsOf(source: ImageBitmap | HTMLImageElement): {
  width: number;
  height: number;
} {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

function drawScaled(
  source: ImageBitmap | HTMLImageElement,
  maxEdge: number,
): HTMLCanvasElement | null {
  const { width, height } = dimensionsOf(source);
  if (!width || !height) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  // A solid backdrop keeps transparent PNGs legible once flattened to JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function releaseDecoded(source: ImageBitmap | HTMLImageElement): void {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    source.close();
  }
}

/**
 * Tiny JPEG data-URL preview for an image attachment, or null when the
 * browser cannot decode the file. Steps down quality/size until the result
 * fits the synced-stamp bound.
 */
export async function makeImageThumbnail(file: File): Promise<string | null> {
  try {
    const source = await decodeImage(file);
    try {
      for (const [edge, quality] of [
        [THUMBNAIL_EDGE_PX, 0.55],
        [96, 0.45],
        [64, 0.35],
      ] as const) {
        const canvas = drawScaled(source, edge);
        if (!canvas) return null;
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (
          dataUrl.startsWith("data:image/jpeg;base64,") &&
          dataUrl.length <= MAX_THUMBNAIL_CHARS
        ) {
          return dataUrl;
        }
      }
      return null;
    } finally {
      releaseDecoded(source);
    }
  } catch {
    return null;
  }
}

/**
 * The file that should actually be uploaded for an image attachment:
 * oversized photos are downscaled to a JPEG rendition; small images and
 * GIFs pass through untouched. Falls back to the original on any failure.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (file.type === "image/gif" || /\.gif$/i.test(file.name)) return file;
  try {
    const source = await decodeImage(file);
    try {
      const { width, height } = dimensionsOf(source);
      const oversizedPixels = Math.max(width, height) > UPLOAD_MAX_EDGE_PX;
      const oversizedBytes = file.size > UPLOAD_RECODE_THRESHOLD_BYTES;
      if (!oversizedPixels && !oversizedBytes) return file;
      const canvas = drawScaled(source, UPLOAD_MAX_EDGE_PX);
      if (!canvas) return file;
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      // A rendition that failed, or somehow grew, is not an improvement.
      if (!blob || blob.size === 0 || blob.size >= file.size) return file;
      const stem = file.name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
      return new File([blob], `${stem || "image"}.jpg`, {
        type: "image/jpeg",
      });
    } finally {
      releaseDecoded(source);
    }
  } catch {
    return file;
  }
}
