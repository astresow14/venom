/**
 * audio/index.ts — picks the voice audio adapter for this environment.
 *
 * Browser UI tests swap in the deterministic harness; everything else uses
 * the real Web Audio adapter. Desktop is web-only, so unlike the mobile
 * sibling there is no native branch here.
 */

import { IS_UI_TEST } from '@/lib/ui-test';
import type { VoiceAudioAdapter } from './types';
import { webVoiceAudioAdapter } from './webVoiceAudio';
import { voiceTestHarnessAdapter } from './voiceTestHarness';

export function getVoiceAudioAdapter(): VoiceAudioAdapter {
  if (IS_UI_TEST) return voiceTestHarnessAdapter;
  return webVoiceAudioAdapter;
}

export type {
  VoiceAudioAdapter,
  VoiceAudioSupport,
  VoiceCaptureErrorCode,
  VoiceCaptureEvent,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types';
