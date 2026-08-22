/**
 * VoicePreferencesDialog – the desktop surface for Venom's synced voice
 * preferences: which voice speaks in hands-free sessions, and the
 * chatty ↔ reserved talkativeness dial that tunes how eager Venom is to
 * answer remarks that don't clearly call for one.
 *
 * Voice mode runs on the phone and on desktop (the composer's mic button);
 * this dialog edits the same synced `voicePreferences` block of the
 * workspace state, so a choice made here follows the account onto every
 * device. The copy is shared with the voice-mode picker so the dial reads
 * the same everywhere.
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';
import {
  ALL_VOICE_PRESET_IDS,
  ALL_VOICE_TALKATIVENESS_LEVELS,
  createDefaultVoicePreferences,
  DEFAULT_VOICE_TALKATIVENESS,
} from '@/lib/workspaceState';
import { PRESET_LABELS, TALKATIVENESS_COPY } from '@/lib/voice/voiceCopy';

export default function VoicePreferencesDialog({
  trigger,
}: {
  trigger: React.ReactNode;
}) {
  const { state, setVoicePreferences } = useVenomWorkspace();
  const prefs = state.voicePreferences ?? createDefaultVoicePreferences();
  // Synced snapshots keep these fields optional; normalization fills them on
  // load, so the fallbacks only guard the type, not a real runtime path.
  const talkativeness = prefs.talkativeness ?? DEFAULT_VOICE_TALKATIVENESS;

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="max-w-md"
        data-testid="dialog-voice-preferences"
      >
        <DialogHeader>
          <DialogTitle>Voice mode</DialogTitle>
          <DialogDescription>
            How Venom sounds — and how eager it is to speak — in hands-free
            voice chats. Synced across your devices.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Voice preset picker */}
          <div>
            <div className="mb-2 text-sm font-semibold">Voice</div>
            <div
              role="radiogroup"
              aria-label="Voice"
              className="grid grid-cols-3 gap-2"
            >
              {ALL_VOICE_PRESET_IDS.map((id) => {
                const selected = id === prefs.presetId;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`voice-preset-${id}`}
                    onClick={() => setVoicePreferences({ presetId: id })}
                    className={cn(
                      'rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/60 bg-transparent text-foreground/80 hover:bg-muted',
                    )}
                  >
                    {PRESET_LABELS[id]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Talkativeness dial */}
          <div>
            <div className="mb-1 text-sm font-semibold">Talkativeness</div>
            <p className="mb-2 text-xs leading-5 text-muted-foreground">
              How eager Venom is to speak when a remark doesn&rsquo;t clearly
              call for an answer. Direct questions always get a full reply.
            </p>
            <div
              role="radiogroup"
              aria-label="Talkativeness"
              className="grid grid-cols-3 gap-2"
            >
              {ALL_VOICE_TALKATIVENESS_LEVELS.map((level) => {
                const selected = level === talkativeness;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${TALKATIVENESS_COPY[level].label}. ${TALKATIVENESS_COPY[level].description}`}
                    data-testid={`voice-talkativeness-${level}`}
                    onClick={() => setVoicePreferences({ talkativeness: level })}
                    className={cn(
                      'rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/60 bg-transparent text-foreground/80 hover:bg-muted',
                    )}
                  >
                    {TALKATIVENESS_COPY[level].label}
                  </button>
                );
              })}
            </div>
            <p
              className="mt-2 text-xs leading-5 text-muted-foreground"
              data-testid="voice-talkativeness-description"
            >
              {TALKATIVENESS_COPY[talkativeness].description}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
