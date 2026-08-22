/**
 * webVoiceAudio.ts — browser implementation of the voice audio interface.
 *
 * Capture: getUserMedia + AnalyserNode levels animate the recorder. The user
 * explicitly stops each MediaRecorder window, which is emitted as one base64
 * blob (webm/opus where supported, mp4 on Safari).
 *
 * Playback: base64 PCM16 chunks are decoded into AudioBuffers and scheduled
 * back-to-back on a cursor, so streamed sentences play gaplessly and can be
 * cut instantly on interrupt.
 */

import type {
  VoiceAudioAdapter,
  VoiceAudioSupport,
  VoiceCaptureEvent,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types.ts';

const LEVEL_INTERVAL_MS = 50;
type AnyWindow = typeof globalThis & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
  MediaRecorder?: typeof MediaRecorder;
};

function resolveAudioContextCtor(): typeof AudioContext | null {
  const w = globalThis as AnyWindow;
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function webVoiceSupport(): VoiceAudioSupport {
  const w = globalThis as AnyWindow;
  const hasMedia =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  if (!hasMedia) {
    return {
      supported: false,
      reason: 'This browser does not allow microphone access.',
    };
  }
  if (!w.MediaRecorder) {
    return {
      supported: false,
      reason: 'This browser cannot record audio.',
    };
  }
  if (!resolveAudioContextCtor()) {
    return {
      supported: false,
      reason: 'This browser cannot process audio.',
    };
  }
  return { supported: true };
}

function pickRecorderMimeType(): string | undefined {
  const w = globalThis as AnyWindow;
  if (!w.MediaRecorder || typeof w.MediaRecorder.isTypeSupported !== 'function') {
    return undefined;
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => w.MediaRecorder!.isTypeSupported(type));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function createWebCapture(
  onEvent: (event: VoiceCaptureEvent) => void,
): VoiceCaptureHandle {
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let recorder: MediaRecorder | null = null;
  let recorderChunks: BlobPart[] = [];
  let utteranceStartedAt = 0;
  let paused = false;
  let stopped = false;
  /** What to do when the in-flight recorder stop completes. */
  let onRecorderStop: 'discard' | 'emit' = 'discard';

  const startRecorder = () => {
    if (stopped || paused || !stream) return;
    if (recorder && recorder.state !== 'inactive') return;
    recorderChunks = [];
    const mimeType = pickRecorderMimeType();
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      onEvent({
        type: 'error',
        code: 'capture_failed',
        message: 'Recording could not start in this browser.',
      });
      return;
    }
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) recorderChunks.push(event.data);
    };
    recorder.onstop = () => {
      const mode = onRecorderStop;
      onRecorderStop = 'discard';
      const blob = new Blob(recorderChunks, {
        type: recorder?.mimeType || 'audio/webm',
      });
      recorderChunks = [];
      if (mode === 'emit' && blob.size > 0) {
        const durationMs = Math.max(0, Date.now() - utteranceStartedAt);
        blob
          .arrayBuffer()
          .then((buffer) => {
            onEvent({
              type: 'utterance',
              audioBase64: bytesToBase64(new Uint8Array(buffer)),
              durationMs,
            });
          })
          .catch(() => {
            onEvent({
              type: 'error',
              code: 'capture_failed',
              message: 'The recording could not be read.',
            });
          });
      }
      // Keep listening for the next turn unless paused/stopped meanwhile.
      if (!stopped && !paused) startRecorder();
    };
    utteranceStartedAt = Date.now();
    recorder.start();
  };

  const stopRecorder = (mode: 'discard' | 'emit') => {
    if (!recorder || recorder.state === 'inactive') return;
    onRecorderStop = mode;
    try {
      recorder.stop();
    } catch {
      onRecorderStop = 'discard';
    }
  };

  const readLevel = (): number => {
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const centered = (data[i] - 128) / 128;
      sum += centered * centered;
    }
    // RMS, boosted a touch so normal speech lands in a usable 0..1 range.
    return Math.min(1, Math.sqrt(sum / data.length) * 2.4);
  };

  const tick = () => {
    if (stopped) return;
    const level = readLevel();
    const atMs = Date.now();
    onEvent({ type: 'level', level, atMs });
  };

  return {
    async start() {
      if (stream) return;
      stopped = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (error) {
        const name = error instanceof DOMException ? error.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          onEvent({
            type: 'error',
            code: 'permission_denied',
            message: 'Microphone access was declined.',
          });
        } else {
          onEvent({
            type: 'error',
            code: 'capture_failed',
            message:
              name === 'NotFoundError'
                ? 'No microphone was found on this device.'
                : 'The microphone could not be started.',
          });
        }
        return;
      }
      if (stopped) {
        // stop() raced the permission prompt.
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        return;
      }
      const Ctor = resolveAudioContextCtor();
      if (!Ctor) {
        onEvent({
          type: 'error',
          code: 'unsupported',
          message: 'This browser cannot process audio.',
        });
        return;
      }
      audioContext = new Ctor();
      await audioContext.resume().catch(() => {});
      const source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      paused = false;
      startRecorder();
      levelTimer = setInterval(tick, LEVEL_INTERVAL_MS);
    },
    pause() {
      if (paused || stopped) return;
      paused = true;
      stopRecorder('discard');
    },
    finish() {
      if (paused || stopped) return;
      paused = true;
      stopRecorder('emit');
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      startRecorder();
    },
    // Explicit recordings never run during playback, so ducking is inactive.
    setDucking() {},
    stop() {
      stopped = true;
      paused = false;
      if (levelTimer) {
        clearInterval(levelTimer);
        levelTimer = null;
      }
      stopRecorder('discard');
      recorder = null;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
        audioContext = null;
      }
      analyser = null;
    },
  };
}

function createWebPlayback(
  onEvent: (event: VoicePlaybackEvent) => void,
): VoicePlaybackHandle {
  let audioContext: AudioContext | null = null;
  let sampleRate = 24_000;
  let cursor = 0;
  let endRequested = false;
  let startedEmitted = false;
  let finishedEmitted = false;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  const liveSources = new Set<AudioBufferSourceNode>();
  /** [endsAt, rms] per scheduled chunk, for coarse output level events. */
  let chunkLevels: Array<{ endsAt: number; level: number }> = [];

  const clearWatch = () => {
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  };

  const watch = () => {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    if (!startedEmitted && liveSources.size > 0 && now >= chunkStartFloor) {
      startedEmitted = true;
      onEvent({ type: 'started' });
    }
    if (startedEmitted && now < cursor) {
      const current = chunkLevels.find((entry) => entry.endsAt > now);
      onEvent({ type: 'level', level: current ? current.level : 0 });
    }
    if (endRequested && !finishedEmitted && now >= cursor) {
      finishedEmitted = true;
      clearWatch();
      onEvent({ type: 'finished' });
    }
  };
  let chunkStartFloor = 0;

  return {
    begin(format: { sampleRate: number }) {
      const Ctor = resolveAudioContextCtor();
      if (!Ctor) {
        onEvent({ type: 'error', message: 'This browser cannot play audio.' });
        return;
      }
      if (!audioContext) audioContext = new Ctor();
      audioContext.resume().catch(() => {});
      sampleRate =
        Number.isFinite(format.sampleRate) && format.sampleRate >= 8000
          ? format.sampleRate
          : 24_000;
      cursor = audioContext.currentTime;
      chunkStartFloor = 0;
      endRequested = false;
      startedEmitted = false;
      finishedEmitted = false;
      chunkLevels = [];
      clearWatch();
      watchTimer = setInterval(watch, 60);
    },
    enqueueChunk(base64Pcm16: string) {
      if (!audioContext || finishedEmitted) return;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(base64Pcm16);
      } catch {
        return;
      }
      // PCM16 little-endian mono → Float32.
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount === 0) return;
      const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
      const floats = new Float32Array(sampleCount);
      let sumSquares = 0;
      for (let i = 0; i < sampleCount; i += 1) {
        const sample = view.getInt16(i * 2, true) / 32768;
        floats[i] = sample;
        sumSquares += sample * sample;
      }
      const buffer = audioContext.createBuffer(1, sampleCount, sampleRate);
      buffer.getChannelData(0).set(floats);
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      const startAt = Math.max(audioContext.currentTime + 0.06, cursor);
      if (chunkStartFloor === 0) chunkStartFloor = startAt;
      cursor = startAt + buffer.duration;
      chunkLevels.push({
        endsAt: cursor,
        level: Math.min(1, Math.sqrt(sumSquares / sampleCount) * 2.2),
      });
      if (chunkLevels.length > 400) chunkLevels.splice(0, 100);
      liveSources.add(source);
      source.onended = () => {
        liveSources.delete(source);
      };
      source.start(startAt);
    },
    end() {
      endRequested = true;
      // If nothing was ever scheduled, finish immediately.
      if (!audioContext || (liveSources.size === 0 && audioContext.currentTime >= cursor)) {
        if (!finishedEmitted) {
          finishedEmitted = true;
          clearWatch();
          onEvent({ type: 'finished' });
        }
      }
    },
    stop() {
      endRequested = false;
      startedEmitted = false;
      finishedEmitted = true; // suppress any late 'finished'
      clearWatch();
      for (const source of liveSources) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
      liveSources.clear();
      chunkLevels = [];
      if (audioContext) cursor = audioContext.currentTime;
    },
  };
}

export const webVoiceAudioAdapter: VoiceAudioAdapter = {
  kind: 'web',
  isSupported: webVoiceSupport,
  createCapture: createWebCapture,
  createPlayback: createWebPlayback,
};
