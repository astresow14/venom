/**
 * nativeVoiceAudio.ts — web-bundle stand-in for the native audio backend.
 *
 * Metro resolves `nativeVoiceAudio.native.ts` on iOS/Android, which talks to
 * the Expo audio APIs. This file exists so web bundles never import native
 * modules; anything that lands here reports itself as unsupported.
 */

import type { VoiceAudioAdapter } from './types.ts';

export const nativeVoiceAudioAdapter: VoiceAudioAdapter = {
  kind: 'native',
  isSupported() {
    return {
      supported: false,
      reason: 'Native voice audio is not available in a web build.',
    };
  },
  createCapture(onEvent) {
    return {
      async start() {
        onEvent({
          type: 'error',
          code: 'unsupported',
          message: 'Native voice audio is not available in a web build.',
        });
      },
      pause() {},
      resume() {},
      stop() {},
    };
  },
  createPlayback() {
    return {
      begin() {},
      enqueueChunk() {},
      end() {},
      stop() {},
    };
  },
};
