/**
 * voiceTestHarness.ts — deterministic fake audio backend for UI tests.
 *
 * Browser UI tests cannot grant a real microphone or hear real audio, so in
 * UI-test mode the voice loop runs against this adapter. Tests drive capture
 * through window events and read playback activity from a window-scoped log:
 *
 *   window.dispatchEvent(new CustomEvent('venom-voice:utterance',
 *     { detail: { durationMs: 1200 } }))          → speech-start + utterance
 *   window.dispatchEvent(new CustomEvent('venom-voice:level',
 *     { detail: { level: 0.9, atMs } }))          → runs the real speech
 *     detector, so sustained loud levels produce speech-start and a later
 *     quiet stretch produces an utterance (synthetic barge-in included)
 *   window.dispatchEvent(new Event('venom-voice:deny-mic'))
 *     or set (window).__venomVoiceDenyMic = true  → permission_denied
 *   (window).__venomVoiceHoldPlayback = true      → 'finished' waits for
 *   window.dispatchEvent(new Event('venom-voice:finish-playback'))
 *
 * Assertions read (window).__venomVoicePlaybackLog,
 * (window).__venomVoiceCaptureState and (window).__venomVoiceCaptureDucking
 * (the playback level the capture is currently gated against, null outside
 * the ducking window).
 */

import { createSpeechDetector, type SpeechDetector } from '../voiceActivity';
import type {
  VoiceAudioAdapter,
  VoiceCaptureEvent,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types';

type HarnessWindow = typeof globalThis & {
  __venomVoiceDenyMic?: boolean;
  __venomVoiceUnsupported?: boolean;
  __venomVoiceHoldPlayback?: boolean;
  __venomVoiceCaptureState?: 'idle' | 'listening' | 'paused' | 'stopped';
  __venomVoiceCaptureDucking?: number | null;
  __venomVoicePlaybackLog?: {
    begun: Array<{ sampleRate: number }>;
    chunks: string[];
    ends: number;
    stops: number;
    finishes: number;
  };
};

const harnessWindow = globalThis as HarnessWindow;

function playbackLog() {
  if (!harnessWindow.__venomVoicePlaybackLog) {
    harnessWindow.__venomVoicePlaybackLog = {
      begun: [],
      chunks: [],
      ends: 0,
      stops: 0,
      finishes: 0,
    };
  }
  return harnessWindow.__venomVoicePlaybackLog;
}

const DEFAULT_UTTERANCE_BASE64 = 'dGVzdC12b2ljZS11dHRlcmFuY2U=';

function createTestCapture(
  onEvent: (event: VoiceCaptureEvent) => void,
): VoiceCaptureHandle {
  let running = false;
  let paused = false;
  let detector: SpeechDetector = createSpeechDetector();
  let utteranceStartedAt = 0;

  const setState = (state: 'idle' | 'listening' | 'paused' | 'stopped') => {
    harnessWindow.__venomVoiceCaptureState = state;
  };

  const onUtterance = (event: Event) => {
    if (!running || paused) return;
    const detail = (event as CustomEvent).detail as
      | { audioBase64?: string; durationMs?: number }
      | undefined;
    onEvent({ type: 'speech-start' });
    onEvent({
      type: 'utterance',
      audioBase64: detail?.audioBase64 ?? DEFAULT_UTTERANCE_BASE64,
      durationMs: detail?.durationMs ?? 1200,
    });
  };

  const onSpeechStart = () => {
    if (!running || paused) return;
    onEvent({ type: 'speech-start' });
  };

  const onLevel = (event: Event) => {
    if (!running) return;
    const detail = (event as CustomEvent).detail as
      | { level?: number; atMs?: number }
      | undefined;
    const level = detail?.level ?? 0.5;
    const atMs = detail?.atMs ?? Date.now();
    onEvent({ type: 'level', level, atMs });
    if (paused) return;
    // Mirror the web backend: levels feed the real detector, so tests can
    // prove what sustained loudness does — including during playback, when
    // the detector is ducked against the reported output level.
    const transition = detector.push(level, atMs);
    if (transition === 'speech-start') {
      utteranceStartedAt = atMs;
      onEvent({ type: 'speech-start' });
    } else if (transition === 'speech-end') {
      onEvent({
        type: 'utterance',
        audioBase64: DEFAULT_UTTERANCE_BASE64,
        durationMs: Math.max(0, atMs - utteranceStartedAt),
      });
    }
  };

  const onDeny = () => {
    onEvent({
      type: 'error',
      code: 'permission_denied',
      message: 'Microphone access was declined.',
    });
  };

  return {
    async start() {
      if (harnessWindow.__venomVoiceDenyMic) {
        setState('idle');
        onEvent({
          type: 'error',
          code: 'permission_denied',
          message: 'Microphone access was declined.',
        });
        return;
      }
      running = true;
      paused = false;
      detector = createSpeechDetector();
      harnessWindow.__venomVoiceCaptureDucking = null;
      setState('listening');
      addEventListener('venom-voice:utterance', onUtterance);
      addEventListener('venom-voice:speech-start', onSpeechStart);
      addEventListener('venom-voice:level', onLevel);
      addEventListener('venom-voice:deny-mic', onDeny);
    },
    pause() {
      if (!running) return;
      paused = true;
      detector.reset();
      setState('paused');
    },
    resume() {
      // Web parity: resuming a capture that never paused is a no-op, so a
      // barge-in finalize cannot reset the detector mid-utterance.
      if (!running || !paused) return;
      paused = false;
      detector.reset();
      setState('listening');
    },
    setDucking(playbackLevel: number | null) {
      detector.setDucking(playbackLevel);
      harnessWindow.__venomVoiceCaptureDucking = playbackLevel;
    },
    stop() {
      running = false;
      paused = false;
      setState('stopped');
      harnessWindow.__venomVoiceCaptureDucking = null;
      removeEventListener('venom-voice:utterance', onUtterance);
      removeEventListener('venom-voice:speech-start', onSpeechStart);
      removeEventListener('venom-voice:level', onLevel);
      removeEventListener('venom-voice:deny-mic', onDeny);
    },
  };
}

function createTestPlayback(
  onEvent: (event: VoicePlaybackEvent) => void,
): VoicePlaybackHandle {
  let active = false;
  let sawChunk = false;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForRelease = false;

  const finish = () => {
    if (!active) return;
    active = false;
    playbackLog().finishes += 1;
    onEvent({ type: 'finished' });
  };

  const onRelease = () => {
    if (waitingForRelease) {
      waitingForRelease = false;
      removeEventListener('venom-voice:finish-playback', onRelease);
      finish();
    }
  };

  return {
    begin(format: { sampleRate: number }) {
      active = true;
      sawChunk = false;
      playbackLog().begun.push({ sampleRate: format.sampleRate });
    },
    enqueueChunk(base64Pcm16: string) {
      if (!active) return;
      playbackLog().chunks.push(base64Pcm16);
      if (!sawChunk) {
        sawChunk = true;
        onEvent({ type: 'started' });
      }
      onEvent({ type: 'level', level: 0.6 });
    },
    end() {
      playbackLog().ends += 1;
      if (!active) return;
      if (harnessWindow.__venomVoiceHoldPlayback) {
        waitingForRelease = true;
        addEventListener('venom-voice:finish-playback', onRelease);
        return;
      }
      // A short drain delay keeps the 'speaking' state observable in tests.
      finishTimer = setTimeout(finish, 120);
    },
    stop() {
      playbackLog().stops += 1;
      active = false;
      waitingForRelease = false;
      removeEventListener('venom-voice:finish-playback', onRelease);
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    },
  };
}

export const voiceTestHarnessAdapter: VoiceAudioAdapter = {
  kind: 'test',
  isSupported() {
    if (harnessWindow.__venomVoiceUnsupported) {
      return {
        supported: false,
        reason: 'Voice is not supported in this test run.',
      };
    }
    return { supported: true };
  },
  createCapture: createTestCapture,
  createPlayback: createTestPlayback,
};
