/**
 * Composer dictation: one bounded microphone take, transcribed through the
 * existing server endpoint, landing as editable text in the input box.
 *
 * Deliberately much smaller than the hands-free voice loop — no speech
 * detection, no playback, no turn-taking. The user starts and stops the
 * take; the recorder rolls until stopped or the safety cap fires.
 */

export type DictationTake = {
  audioBase64: string;
};

export class MicPermissionError extends Error {
  constructor() {
    super("Microphone access was declined.");
    this.name = "MicPermissionError";
  }
}

/** Longest single take; the transcription request body is capped too. */
export const MAX_DICTATION_MS = 60_000;

type AnyWindow = typeof globalThis & { MediaRecorder?: typeof MediaRecorder };

export function dictationSupported(): boolean {
  const w = globalThis as AnyWindow;
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(w.MediaRecorder)
  );
}

function pickRecorderMimeType(): string | undefined {
  const w = globalThis as AnyWindow;
  if (
    !w.MediaRecorder ||
    typeof w.MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => w.MediaRecorder!.isTypeSupported(type));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export type DictationRecorder = {
  /** Stop the take and resolve its audio; null when nothing was captured. */
  stop: () => Promise<DictationTake | null>;
  /** Tear everything down without resolving audio (route change, unmount). */
  cancel: () => void;
};

/**
 * Ask for the microphone and start recording immediately. Rejects with
 * MicPermissionError when the browser refuses the microphone.
 */
export async function startDictation(): Promise<DictationRecorder> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicPermissionError();
    }
    throw new Error("The microphone could not be started.");
  }

  const releaseStream = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const mimeType = pickRecorderMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
  } catch {
    releaseStream();
    throw new Error("Recording could not start in this browser.");
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  let settled = false;
  let takeResolve: (take: DictationTake | null) => void = () => {};
  let takeReject: (error: Error) => void = () => {};
  const take = new Promise<DictationTake | null>((resolve, reject) => {
    takeResolve = resolve;
    takeReject = reject;
  });

  recorder.onstop = () => {
    releaseStream();
    if (settled) return;
    settled = true;
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    if (blob.size === 0) {
      takeResolve(null);
      return;
    }
    blob
      .arrayBuffer()
      .then((buffer) => {
        takeResolve({ audioBase64: bytesToBase64(new Uint8Array(buffer)) });
      })
      .catch(() => takeReject(new Error("The recording could not be read.")));
  };

  // Safety cap: a forgotten take must not roll forever.
  const capTimer = setTimeout(() => {
    if (recorder.state !== "inactive") recorder.stop();
  }, MAX_DICTATION_MS);

  recorder.start();

  return {
    stop: () => {
      clearTimeout(capTimer);
      if (recorder.state !== "inactive") recorder.stop();
      else if (!settled) {
        settled = true;
        releaseStream();
        takeResolve(null);
      }
      return take;
    },
    cancel: () => {
      clearTimeout(capTimer);
      settled = true;
      if (recorder.state !== "inactive") recorder.stop();
      releaseStream();
      takeResolve(null);
    },
  };
}

/**
 * Send one take to the existing transcription endpoint (which sniffs the
 * audio container itself). A raw fetch on purpose: the endpoint predates
 * the generated client and rides cookie auth like the rest of the app.
 */
export async function transcribeDictation(
  take: DictationTake,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch("/api/venom/voice/transcribe", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audioBase64: take.audioBase64 }),
    signal,
  });
  if (!response.ok) {
    let message = "The recording could not be transcribed.";
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the fixed copy.
    }
    throw new Error(message);
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}
