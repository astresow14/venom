/**
 * nativeVoiceAudio.native.ts — Expo audio backend for iOS/Android builds.
 *
 * Same interface as the web backend, implemented with expo-audio:
 * - Capture: AudioRecorder with metering; the shared speech detector decides
 *   end-of-speech from metering levels, then the recorded file (m4a/mp4) is
 *   read as base64 and deleted. The server transcodes containers via ffmpeg.
 * - Playback: streamed PCM16 chunks are grouped into short WAV segments in
 *   the cache directory and played back-to-back, so speech starts before the
 *   full reply exists. Segment files are deleted as they finish.
 *
 * Metro resolves this file only for native platforms; web bundles use the
 * stub in nativeVoiceAudio.ts.
 */

import {
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import {
  createSpeechDetector,
  type SpeechDetector,
} from '../context/voiceActivity.ts';
import type {
  VoiceAudioAdapter,
  VoiceCaptureEvent,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types.ts';

const METER_INTERVAL_MS = 100;
/** Cut a playable WAV segment once this much audio has buffered. */
const SEGMENT_SECONDS = 1.6;

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const lookup = new Uint8Array(128);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    lookup[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  let padding = 0;
  for (let i = clean.length - 1; i >= 0 && clean[i] === '='; i -= 1) {
    padding += 1;
  }
  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(Math.max(0, byteLength));
  let out = 0;
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const a = lookup[clean.charCodeAt(i)];
    const b = lookup[clean.charCodeAt(i + 1)];
    const c = lookup[clean.charCodeAt(i + 2)];
    const d = lookup[clean.charCodeAt(i + 3)];
    if (out < bytes.length) bytes[out++] = (a << 2) | (b >> 4);
    if (out < bytes.length) bytes[out++] = ((b & 15) << 4) | (c >> 2);
    if (out < bytes.length) bytes[out++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

/** Recorder metering arrives in dBFS (≈ -160..0); map to the 0..1 scale. */
function meteringToLevel(dbfs: number | undefined): number {
  if (typeof dbfs !== 'number' || !Number.isFinite(dbfs)) return 0;
  return Math.max(0, Math.min(1, Math.pow(10, dbfs / 20) * 2.2));
}

function buildWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  const wav = new Uint8Array(44 + pcm.byteLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcm, 44);
  return wav;
}

function deleteQuietly(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {
    // Transient files; best-effort cleanup.
  }
}

function createNativeCapture(
  onEvent: (event: VoiceCaptureEvent) => void,
): VoiceCaptureHandle {
  let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  let meterTimer: ReturnType<typeof setInterval> | null = null;
  let detector: SpeechDetector = createSpeechDetector();
  let paused = false;
  let stopped = false;
  /** Serializes stop/restart transitions of the underlying recorder. */
  let transition: Promise<void> = Promise.resolve();

  const queueTransition = (work: () => Promise<void>) => {
    transition = transition.then(work).catch(() => {});
    return transition;
  };

  const beginRecording = async () => {
    if (!recorder || stopped || paused) return;
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const finishUtterance = () =>
    queueTransition(async () => {
      if (!recorder || stopped) return;
      const durationMs = recorder.getStatus().durationMillis ?? 0;
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) {
        try {
          const audioBase64 = await new File(uri).base64();
          if (audioBase64 && !stopped && !paused) {
            onEvent({ type: 'utterance', audioBase64, durationMs });
          }
        } catch {
          onEvent({
            type: 'error',
            code: 'capture_failed',
            message: 'The recording could not be read.',
          });
        } finally {
          deleteQuietly(uri);
        }
      }
      if (!stopped && !paused) await beginRecording();
    });

  const tick = () => {
    if (!recorder || stopped || paused) return;
    const status = recorder.getStatus();
    const level = meteringToLevel(status.metering);
    const atMs = Date.now();
    onEvent({ type: 'level', level, atMs });
    const transitionEvent = detector.push(level, atMs);
    if (transitionEvent === 'speech-start') {
      onEvent({ type: 'speech-start' });
    } else if (transitionEvent === 'speech-end') {
      void finishUtterance();
    }
  };

  return {
    async start() {
      if (recorder) return;
      stopped = false;
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        onEvent({
          type: 'error',
          code: 'permission_denied',
          message: 'Microphone access was declined.',
        });
        return;
      }
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        recorder = new AudioModule.AudioRecorder({
          ...RecordingPresets.HIGH_QUALITY,
          isMeteringEnabled: true,
        });
        detector = createSpeechDetector();
        paused = false;
        await queueTransition(beginRecording);
        meterTimer = setInterval(tick, METER_INTERVAL_MS);
      } catch {
        onEvent({
          type: 'error',
          code: 'capture_failed',
          message: 'The microphone could not be started.',
        });
      }
    },
    pause() {
      if (paused || stopped) return;
      paused = true;
      detector.reset();
      void queueTransition(async () => {
        if (!recorder) return;
        if (recorder.isRecording) {
          await recorder.stop();
          deleteQuietly(recorder.uri);
        }
      });
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      detector.reset();
      void queueTransition(beginRecording);
    },
    stop() {
      stopped = true;
      paused = false;
      if (meterTimer) {
        clearInterval(meterTimer);
        meterTimer = null;
      }
      void queueTransition(async () => {
        if (!recorder) return;
        if (recorder.isRecording) {
          await recorder.stop();
        }
        deleteQuietly(recorder.uri);
        recorder = null;
        await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      });
    },
  };
}

function createNativePlayback(
  onEvent: (event: VoicePlaybackEvent) => void,
): VoicePlaybackHandle {
  let sampleRate = 24_000;
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let segmentQueue: string[] = [];
  let player: AudioPlayer | null = null;
  let playerSubscription: { remove(): void } | null = null;
  let playing = false;
  let ended = false;
  let stoppedFlag = false;
  let startedEmitted = false;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let segmentIndex = 0;
  const sessionId = `${Date.now().toString(36)}${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;

  const clearLevelTimer = () => {
    if (levelTimer) {
      clearInterval(levelTimer);
      levelTimer = null;
    }
  };

  const cleanupPlayer = () => {
    if (playerSubscription) {
      playerSubscription.remove();
      playerSubscription = null;
    }
    if (player) {
      try {
        player.remove();
      } catch {
        // already released
      }
      player = null;
    }
  };

  const maybeFinish = () => {
    if (
      ended &&
      !playing &&
      segmentQueue.length === 0 &&
      bufferedBytes === 0 &&
      !stoppedFlag
    ) {
      clearLevelTimer();
      onEvent({ type: 'finished' });
    }
  };

  const pump = () => {
    if (playing || stoppedFlag) return;
    const nextUri = segmentQueue.shift();
    if (!nextUri) {
      maybeFinish();
      return;
    }
    playing = true;
    cleanupPlayer();
    player = createAudioPlayer({ uri: nextUri });
    playerSubscription = player.addListener(
      'playbackStatusUpdate',
      (status) => {
        if (status.didJustFinish) {
          playing = false;
          deleteQuietly(nextUri);
          cleanupPlayer();
          pump();
        }
      },
    );
    player.play();
    if (!startedEmitted) {
      startedEmitted = true;
      onEvent({ type: 'started' });
      // No cheap output metering on native players; synthesize a gentle
      // level pulse so the orb still breathes with speech.
      clearLevelTimer();
      let phase = 0;
      levelTimer = setInterval(() => {
        if (playing) {
          phase += 0.9;
          onEvent({
            type: 'level',
            level: 0.35 + 0.2 * Math.abs(Math.sin(phase)),
          });
        }
      }, 120);
    }
  };

  const cutSegment = () => {
    if (bufferedBytes === 0) return;
    const pcm = new Uint8Array(bufferedBytes);
    let offset = 0;
    for (const chunk of buffered) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffered = [];
    bufferedBytes = 0;
    const wav = buildWav(pcm, sampleRate);
    try {
      const file = new File(
        Paths.cache,
        `venom-voice-${sessionId}-${segmentIndex++}.wav`,
      );
      try {
        file.create({ overwrite: true });
      } catch {
        // May already exist; write() below still replaces content.
      }
      file.write(wav);
      segmentQueue.push(file.uri);
      pump();
    } catch {
      onEvent({ type: 'error', message: 'Audio playback failed.' });
    }
  };

  return {
    begin(format: { sampleRate: number }) {
      sampleRate =
        Number.isFinite(format.sampleRate) && format.sampleRate >= 8000
          ? format.sampleRate
          : 24_000;
      buffered = [];
      bufferedBytes = 0;
      segmentQueue = [];
      ended = false;
      stoppedFlag = false;
      startedEmitted = false;
      segmentIndex = 0;
    },
    enqueueChunk(base64Pcm16: string) {
      if (stoppedFlag) return;
      const bytes = decodeBase64(base64Pcm16);
      if (bytes.byteLength === 0) return;
      buffered.push(bytes);
      bufferedBytes += bytes.byteLength;
      const bufferedSeconds = bufferedBytes / (sampleRate * 2);
      if (bufferedSeconds >= SEGMENT_SECONDS) cutSegment();
    },
    end() {
      ended = true;
      cutSegment();
      maybeFinish();
    },
    stop() {
      stoppedFlag = true;
      ended = false;
      buffered = [];
      bufferedBytes = 0;
      for (const uri of segmentQueue) deleteQuietly(uri);
      segmentQueue = [];
      clearLevelTimer();
      if (player) {
        try {
          player.pause();
        } catch {
          // already stopped
        }
      }
      cleanupPlayer();
      playing = false;
    },
  };
}

export const nativeVoiceAudioAdapter: VoiceAudioAdapter = {
  kind: 'native',
  isSupported() {
    return { supported: true };
  },
  createCapture: createNativeCapture,
  createPlayback: createNativePlayback,
};
