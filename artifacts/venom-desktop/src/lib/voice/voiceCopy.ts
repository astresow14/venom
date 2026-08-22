/**
 * voiceCopy.ts — user-facing strings for Venom's voice preferences, shared by
 * the voice-mode overlay picker and the workspace VoicePreferencesDialog so
 * the two surfaces can never drift.
 *
 * Mirrored 1:1 from the mobile picker; the dial must read the same on every
 * device because the preference itself is synced.
 */

import type {
  VenomVoicePresetId,
  VenomVoiceTalkativeness,
} from '@workspace/api-client-react';

export const PRESET_LABELS: Record<VenomVoicePresetId, string> = {
  sam: 'Sam',
  marcus: 'Marcus',
  rowan: 'Rowan',
  elijah: 'Elijah',
  maya: 'Maya',
  isla: 'Isla',
};

export const TALKATIVENESS_COPY: Record<
  VenomVoiceTalkativeness,
  { label: string; description: string }
> = {
  chatty: {
    label: 'Chatty',
    description: 'Answers almost everything — even a stray “okay” gets a nod.',
  },
  balanced: {
    label: 'Balanced',
    description: 'Answers real questions, lets throwaway remarks pass quietly.',
  },
  reserved: {
    label: 'Reserved',
    description: 'Speaks when spoken to. Asides and musings are left alone.',
  },
};
