/**
 * nativeVoiceAudio.native.ts — Expo audio backend for iOS/Android builds.
 *
 * Same interface as the web backend, implemented with expo-audio:
 * - Capture: AudioRecorder with metering; the user explicitly stops each
 *   recording, then its file (m4a/mp4) is read as base64 and deleted. The
 *   server transcodes containers via ffmpeg.
 * - Playback: streamed PCM16 chunks are grouped into short WAV segments in
 *   the cache directory and played back-to-back, so speech starts before the
 *   full reply exists. Segment files are deleted as they finish.
 *
 * Device-specific behavior handled here (not needed on web):
 * - iOS routes play-and-record audio to the quiet earpiece receiver, and
 *   expo-audio never adds `.defaultToSpeaker`. The session therefore drops
 *   `allowsRecording` while capture is paused (exactly the transcribe →
 *   think → speak window), which puts playback on the loud speaker, then
 *   re-enters record mode when listening resumes.
 * - Diagnostics: in dev builds every notable transition logs with a
 *   `[voice-native]` prefix. Expo Go forwards these to Metro, so a phone
 *   session leaves a tunable trace in the workflow console.
 *
 * Metro resolves this file only for native platforms; web bundles use the
 * stub in nativeVoiceAudio.ts.
 */

import {
  AudioModule,
  AudioQuality,
  IOSOutputFormat,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioMode,
  type AudioPlayer,
  type RecordingOptions,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type {
  VoiceAudioAdapter,
  VoiceCaptureEvent,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types.ts';

const METER_INTERVAL_MS = 100;

/**
 * WAV segment sizes: the first cut is small so the reply starts fast, later
 * cuts grow so steady-state playback has fewer seams to gap on.
 */
const SEGMENT_SCHEDULE_SECONDS = [0.9, 1.6, 2.4] as const;
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
  let paused = false;
  let stopped = false;
  /** Serializes stop/restart transitions of the underlying recorder. */
  let transition: Promise<void> = Promise.resolve();

  // Aggregated once-per-second level trace for on-device tuning.
  let statWindow = {
    startedAt: 0,
    count: 0,
    minDb: Infinity,
    maxDb: -Infinity,
    minLevel: Infinity,
    maxLevel: 0,
  };

  const traceLevels = (dbfs: number | undefined, level: number, atMs: number) => {
    if (!__DEV__) return;
    const db = typeof dbfs === 'number' && Number.isFinite(dbfs) ? dbfs : -160;
    if (statWindow.startedAt === 0) statWindow.startedAt = atMs;
    statWindow.count += 1;
    statWindow.minDb = Math.min(statWindow.minDb, db);
    statWindow.maxDb = Math.max(statWindow.maxDb, db);
    statWindow.minLevel = Math.min(statWindow.minLevel, level);
    statWindow.maxLevel = Math.max(statWindow.maxLevel, level);
    if (atMs - statWindow.startedAt >= 1000) {
      voiceLog(
        `levels 1s: n=${statWindow.count} db ${statWindow.minDb.toFixed(
          1,
        )}..${statWindow.maxDb.toFixed(1)} lvl ${statWindow.minLevel.toFixed(
          3,
          )}..${statWindow.maxLevel.toFixed(3)}`,
      );
      statWindow = {
        startedAt: atMs,
        count: 0,
        minDb: Infinity,
        maxDb: -Infinity,
        minLevel: Infinity,
        maxLevel: 0,
      };
    }
  };

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
      if (!recorder || stopped || paused) return;
      paused = true;
      const durationMs = recorder.getStatus().durationMillis ?? 0;
      await recorder.stop();
      const uri = recorder.uri;
      if (uri) {
        try {
          const audioBase64 = await new File(uri).base64();
          if (audioBase64 && !stopped) {
            await setAudioModeAsync(SPEAK_AUDIO_MODE).catch(() => {});
            voiceLog('audio mode -> speak');
            voiceLog(
              `recording sent: ${durationMs}ms recorded, ${Math.round(
                audioBase64.length / 1024,
              )}KB base64`,
            );
            onEvent({ type: 'utterance', audioBase64, durationMs });
          }
        } catch {
          voiceLog('utterance read failed');
          onEvent({
            type: 'error',
            code: 'capture_failed',
            message: 'The recording could not be read.',
          });
        } finally {
          deleteQuietly(uri);
        }
      }
    });

  const tick = () => {
    if (!recorder || stopped || paused) return;
    const status = recorder.getStatus();
    const level = meteringToLevel(status.metering);
    const atMs = Date.now();
    traceLevels(status.metering, level, atMs);
    onEvent({ type: 'level', level, atMs });
  };

  return {
    async start() {
      if (recorder) return;
      stopped = false;
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      voiceLog(
        `mic permission: granted=${permission.granted} status=${permission.status}`,
      );
      if (!permission.granted) {
        onEvent({
          type: 'error',
          code: 'permission_denied',
          message: 'Microphone access was declined.',
        });
        return;
      }
      try {
        await setAudioModeAsync(RECORD_AUDIO_MODE);
        voiceLog('audio mode -> record');
        recorder = new AudioModule.AudioRecorder({
          ...VOICE_RECORDING_OPTIONS,
          isMeteringEnabled: true,
        });
        paused = false;
        await queueTransition(beginRecording);
        meterTimer = setInterval(tick, METER_INTERVAL_MS);
      } catch {
        voiceLog('capture start failed');
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
      void queueTransition(async () => {
        if (!recorder) return;
        if (recorder.isRecording) {
          await recorder.stop();
          deleteQuietly(recorder.uri);
        }
        // Leaving record mode routes iOS playback to the loud speaker
        // instead of the earpiece for the upcoming assistant reply.
        await setAudioModeAsync(SPEAK_AUDIO_MODE).catch(() => {});
        voiceLog('audio mode -> speak');
      });
    },
    finish() {
      void finishUtterance();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      void queueTransition(async () => {
        if (!recorder || stopped || paused) return;
        await setAudioModeAsync(RECORD_AUDIO_MODE).catch(() => {});
        voiceLog('audio mode -> record');
        await beginRecording();
      });
    },
    // Explicit recordings never run during playback, so ducking is inactive.
    setDucking() {},
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
        voiceLog('capture stopped');
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
  let segmentQueue: Array<{ uri: string; index: number }> = [];
  let player: AudioPlayer | null = null;
  let playerSubscription: { remove(): void } | null = null;
  let playing = false;
  let currentUri: string | null = null;
  let ended = false;
  let stoppedFlag = false;
  let startedEmitted = false;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let segmentIndex = 0;
  let playedSegments = 0;
  let lastSegmentFinishedAt = 0;
  const sessionId = `${Date.now().toString(36)}${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;

  const segmentTargetSeconds = () =>
    SEGMENT_SCHEDULE_SECONDS[
      Math.min(segmentIndex, SEGMENT_SCHEDULE_SECONDS.length - 1)
    ];

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
      voiceLog(`playback finished (${playedSegments} segments)`);
      onEvent({ type: 'finished' });
    }
  };

  const pump = () => {
    if (playing || stoppedFlag) return;
    const next = segmentQueue.shift();
    if (!next) {
      maybeFinish();
      return;
    }
    playing = true;
    currentUri = next.uri;
    if (__DEV__) {
      const gap =
        lastSegmentFinishedAt > 0
          ? `${Date.now() - lastSegmentFinishedAt}ms gap`
          : 'first';
      voiceLog(`segment #${next.index} play (${gap})`);
    }
    cleanupPlayer();
    player = createAudioPlayer({ uri: next.uri });
    playerSubscription = player.addListener(
      'playbackStatusUpdate',
      (status) => {
        if (status.didJustFinish) {
          playing = false;
          playedSegments += 1;
          lastSegmentFinishedAt = Date.now();
          if (currentUri === next.uri) currentUri = null;
          deleteQuietly(next.uri);
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
      const index = segmentIndex++;
      const file = new File(
        Paths.cache,
        `venom-voice-${sessionId}-${index}.wav`,
      );
      try {
        file.create({ overwrite: true });
      } catch {
        // May already exist; write() below still replaces content.
      }
      file.write(wav);
      voiceLog(
        `segment #${index} cut: ${(pcm.byteLength / (sampleRate * 2)).toFixed(
          2,
        )}s, queue=${segmentQueue.length + 1}`,
      );
      segmentQueue.push({ uri: file.uri, index });
      pump();
    } catch {
      voiceLog('segment write failed');
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
      playedSegments = 0;
      lastSegmentFinishedAt = 0;
      voiceLog(`playback begin (${sampleRate}Hz)`);
    },
    enqueueChunk(base64Pcm16: string) {
      if (stoppedFlag) return;
      const bytes = decodeBase64(base64Pcm16);
      if (bytes.byteLength === 0) return;
      buffered.push(bytes);
      bufferedBytes += bytes.byteLength;
      const bufferedSeconds = bufferedBytes / (sampleRate * 2);
      if (bufferedSeconds >= segmentTargetSeconds()) cutSegment();
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
      for (const segment of segmentQueue) deleteQuietly(segment.uri);
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
      deleteQuietly(currentUri);
      currentUri = null;
      playing = false;
      voiceLog('playback stopped (interrupt)');
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

/** Session mode while listening: mic active, silent-switch ignored. */
const RECORD_AUDIO_MODE: Partial<AudioMode> = {
  allowsRecording: true,
  playsInSilentMode: true,
  shouldRouteThroughEarpiece: false,
  interruptionMode: 'doNotMix',
};

/**
 * Session mode while the assistant speaks: leaving record mode puts iOS in
 * the plain `.playback` category, which routes to the main speaker (the
 * play-and-record category defaults to the earpiece receiver).
 */
const SPEAK_AUDIO_MODE: Partial<AudioMode> = {
  allowsRecording: false,
  playsInSilentMode: true,
  shouldRouteThroughEarpiece: false,
  interruptionMode: 'doNotMix',
};

/** Dev-only diagnostics; Expo Go streams these into the Metro console. */
function voiceLog(message: string) {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log(`[voice-native] ${message}`);
  }
}

/**
 * iOS gives us reliable, standard WAV from AVAudioRecorder. It avoids an
 * unnecessary server-side M4A → WAV conversion before transcription and keeps
 * every stopped turn small enough to upload. Android stays on compact AAC.
 */
const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.wav',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 256_000,
  ios: {
    extension: '.wav',
    sampleRate: 16_000,
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.LOW,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: '.m4a',
    sampleRate: 16_000,
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 128_000,
  },
};
