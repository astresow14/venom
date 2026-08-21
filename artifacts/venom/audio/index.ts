/**
 * index.ts — picks the voice audio backend for the current runtime.
 *
 * UI-test builds get the deterministic fake; web gets WebAudio; native gets
 * the Expo-audio backend (resolved via the .native.ts module suffix so web
 * bundles never touch native modules).
 */

import { Platform } from 'react-native';
import { IS_UI_TEST } from '../context/VenomContext';
import type { VoiceAudioAdapter } from './types.ts';
import { webVoiceAudioAdapter } from './webVoiceAudio.ts';
import { nativeVoiceAudioAdapter } from './nativeVoiceAudio';
import { voiceTestHarnessAdapter } from './voiceTestHarness.ts';

export type {
  VoiceAudioAdapter,
  VoiceAudioSupport,
  VoiceCaptureEvent,
  VoiceCaptureErrorCode,
  VoiceCaptureHandle,
  VoicePlaybackEvent,
  VoicePlaybackHandle,
} from './types.ts';

export function getVoiceAudioAdapter(): VoiceAudioAdapter {
  if (IS_UI_TEST) return voiceTestHarnessAdapter;
  if (Platform.OS === 'web') return webVoiceAudioAdapter;
  return nativeVoiceAudioAdapter;
}
