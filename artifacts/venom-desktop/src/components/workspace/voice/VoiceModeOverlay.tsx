/**
 * VoiceModeOverlay.tsx — full-screen hands-free voice conversation, desktop.
 *
 * Launched from the chat composer's mic button. Always the symbiote's own
 * near-black room regardless of theme: the living mass center stage, a quiet
 * status word, the live transcript below, and a voice picker sheet. Click the
 * orb to interrupt while it's thinking/speaking; the loop resumes listening
 * by itself after every reply.
 *
 * Failure states (mic denied, voice not configured, dropped connection) each
 * explain themselves and offer "Try again" / "Back to text" — voice mode
 * never hangs and never strands the conversation.
 *
 * Built on Radix Dialog primitives for the focus trap, focus restore and
 * Escape handling; the chrome is deliberately custom (no shadcn DialogContent
 * styling) because this surface is a room, not a dialog box.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Play, Square, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';
import {
  ALL_VOICE_TALKATIVENESS_LEVELS,
  DEFAULT_VOICE_TALKATIVENESS,
  normalizeVoicePreferences,
} from '@/lib/workspaceState';
import {
  useVoiceConversation,
  type VoicePhase,
} from '@/hooks/useVoiceConversation';
import { useVoiceSample } from '@/hooks/useVoiceSample';
import { TALKATIVENESS_COPY } from '@/lib/voice/voiceCopy';
import { VoiceOrb } from './VoiceOrb';

type ActiveProjectLike = {
  id: string;
  name?: string;
  description?: string;
} | null;

type VoiceModeOverlayProps = {
  open: boolean;
  activeProject: ActiveProjectLike;
  onClose: () => void;
};

function statusLine(
  phase: VoicePhase,
  voiceName: string | null,
  userSpeaking: boolean,
): string {
  switch (phase) {
    case 'connecting':
      return 'waking up…';
    case 'listening':
      return userSpeaking ? 'go on — listening' : 'listening';
    case 'transcribing':
      return 'got it…';
    case 'thinking':
      return 'thinking…';
    case 'speaking':
      return voiceName ? `${voiceName} is speaking` : 'speaking';
    case 'error':
      return 'voice paused';
    default:
      return '';
  }
}

export default function VoiceModeOverlay({
  open,
  activeProject,
  onClose,
}: VoiceModeOverlayProps) {
  const voice = useVoiceConversation(activeProject);
  const sample = useVoiceSample();
  const { state, setVoicePreferences } = useVenomWorkspace();
  const talkativeness =
    normalizeVoicePreferences(state.voicePreferences).talkativeness ??
    DEFAULT_VOICE_TALKATIVENESS;
  const [pickerOpen, setPickerOpen] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const reducedMotion = useReducedMotion();

  const {
    phase,
    error,
    notice,
    endedQuietly,
    userSpeaking,
    liveUserText,
    liveAssistantText,
    transcript,
    inputLevelRef,
    outputLevelRef,
    presets,
    activePresetId,
    activePreset,
    selectPreset,
    begin,
    end,
    interrupt,
    retry,
  } = voice;

  // One session per open. Closing tears the loop down and files partials.
  // begin/end are reached through refs: their identities change with every
  // context re-render (each filed message), and a dependency on them would
  // tear down and restart the session mid-conversation.
  const beginRef = useRef(begin);
  const endRef = useRef(end);
  useEffect(() => {
    beginRef.current = begin;
    endRef.current = end;
  });
  useEffect(() => {
    if (open) {
      closingRef.current = false;
      setPickerOpen(false);
      void beginRef.current();
      return () => {
        endRef.current();
      };
    }
    return undefined;
  }, [open]);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    sample.stopSample();
    end();
    onClose();
  }, [end, onClose, sample]);

  // Wind-down: after a goodbye and a stretch of quiet the session ends
  // itself; the overlay simply slips away — no "are you still there?".
  useEffect(() => {
    if (open && endedQuietly) handleClose();
  }, [open, endedQuietly, handleClose]);

  // Keep the transcript pinned to the latest words.
  useEffect(() => {
    const timer = setTimeout(() => {
      const el = transcriptRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }, 50);
    return () => clearTimeout(timer);
  }, [transcript, liveAssistantText, liveUserText]);

  const orbPressable = phase === 'speaking' || phase === 'thinking';
  const orbLabel = orbPressable
    ? 'Interrupt and take your turn'
    : statusLine(phase, activePreset?.name ?? null, userSpeaking) ||
      'Voice mode';

  const showLiveAssistant =
    liveAssistantText.length > 0 &&
    (phase === 'thinking' || phase === 'speaking');
  const showLiveUser =
    liveUserText !== null &&
    (phase === 'transcribing' || phase === 'thinking' || phase === 'speaking');

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) handleClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Escape peels one layer at a time: picker first, then the room.
            if (pickerOpen) {
              event.preventDefault();
              setPickerOpen(false);
            }
          }}
          onInteractOutside={(event) => event.preventDefault()}
          className="fixed inset-0 z-50 isolate flex flex-col bg-[#050505] text-[#f5f5f2] outline-none"
          data-testid="voice-mode-overlay"
        >
          <DialogPrimitive.Title className="sr-only">
            Voice mode
          </DialogPrimitive.Title>

          <motion.div
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5">
              <button
                type="button"
                onClick={handleClose}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-[#242424] text-[#f5f5f2] transition-colors hover:border-[#3a3a3a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                aria-label="Exit voice mode"
                data-testid="voice-mode-close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
              <span className="text-xs text-[#8f8f8b]">voice</span>
              <button
                type="button"
                onClick={() => setPickerOpen((prev) => !prev)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border bg-[#0d0d0d] px-3.5 py-2 text-sm font-medium text-[#f5f5f2] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                  pickerOpen
                    ? 'border-[#f5f5f2]'
                    : 'border-[#242424] hover:border-[#3a3a3a]',
                )}
                aria-expanded={pickerOpen}
                aria-label={`Voice: ${activePreset?.name ?? 'default'}. Change voice`}
                data-testid="voice-preset-chip"
              >
                {activePreset?.name ?? 'Voice'}
                <ChevronDown
                  className="h-3.5 w-3.5 text-[#8f8f8b]"
                  aria-hidden="true"
                />
              </button>
            </div>

            {/* Center stage */}
            {error ? (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
                data-testid="voice-error-panel"
              >
                <VoiceOrb
                  phase="error"
                  inputLevelRef={inputLevelRef}
                  outputLevelRef={outputLevelRef}
                  size={130}
                />
                <h2 className="mt-3 text-lg font-semibold">
                  {error.kind === 'mic'
                    ? 'Mic is off'
                    : error.kind === 'unavailable'
                      ? "Voice isn't set up"
                      : error.kind === 'unsupported'
                        ? 'No voice on this device'
                        : 'Connection dropped'}
                </h2>
                <p
                  className="max-w-sm text-sm leading-6 text-[#8f8f8b]"
                  data-testid="voice-error-message"
                >
                  {error.message}
                </p>
                <div className="mt-4 flex items-center gap-2.5">
                  {error.kind !== 'unsupported' && (
                    <button
                      type="button"
                      onClick={retry}
                      className="rounded-full bg-[#f5f5f2] px-6 py-2.5 text-sm font-semibold text-[#0a0a09] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                      data-testid="voice-error-retry"
                    >
                      Try again
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-full border border-[#242424] px-6 py-2.5 text-sm font-semibold text-[#f5f5f2] transition-colors hover:border-[#3a3a3a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    data-testid="voice-error-exit"
                  >
                    Back to text
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
                <button
                  type="button"
                  onClick={orbPressable ? interrupt : undefined}
                  disabled={!orbPressable}
                  className={cn(
                    'rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30',
                    orbPressable ? 'cursor-pointer' : 'cursor-default',
                  )}
                  aria-label={orbLabel}
                  data-testid="voice-orb-press"
                >
                  <VoiceOrb
                    phase={phase}
                    inputLevelRef={inputLevelRef}
                    outputLevelRef={outputLevelRef}
                  />
                </button>
                <p
                  className="mt-1 text-[15px] tracking-[0.01em]"
                  aria-live="polite"
                  data-testid="voice-status"
                >
                  {statusLine(phase, activePreset?.name ?? null, userSpeaking)}
                </p>
                {phase === 'speaking' && (
                  <p className="text-xs text-[#8f8f8b]">
                    click the mass to jump in
                  </p>
                )}
                {notice && (
                  <p
                    className="mt-1 max-w-md px-6 text-center text-[13px] text-[#8f8f8b]"
                    aria-live="polite"
                    data-testid="voice-notice"
                  >
                    {notice}
                  </p>
                )}
              </div>
            )}

            {/* Live transcript */}
            {!error && (
              <div className="max-h-[32%] border-t border-[#242424] bg-[#070707]">
                <div
                  ref={transcriptRef}
                  className="mx-auto h-full w-full max-w-2xl overflow-y-auto px-5"
                  role="log"
                  aria-label="Voice transcript"
                  data-testid="voice-transcript"
                >
                  <div className="flex flex-col gap-2 py-4">
                    {transcript.map((entry) => (
                      <div
                        key={entry.id}
                        className={cn(
                          'max-w-[84%] rounded-2xl px-3.5 py-2 text-[14.5px] leading-5',
                          entry.role === 'user'
                            ? 'self-end bg-[#f5f5f2] text-[#0a0a09]'
                            : 'self-start border border-[#242424] bg-[#0d0d0d] text-[#f5f5f2]',
                        )}
                        data-testid={`voice-transcript-${entry.role}`}
                      >
                        {entry.text}
                      </div>
                    ))}
                    {showLiveUser && (
                      <div
                        className="max-w-[84%] self-end rounded-2xl bg-[#f5f5f2] px-3.5 py-2 text-[14.5px] leading-5 text-[#0a0a09]"
                        data-testid="voice-live-user"
                      >
                        {liveUserText}
                      </div>
                    )}
                    {showLiveAssistant && (
                      <div
                        className="max-w-[84%] self-start rounded-2xl border border-[#242424] bg-[#0d0d0d] px-3.5 py-2 text-[14.5px] leading-5 text-[#f5f5f2]"
                        data-testid="voice-live-assistant"
                      >
                        {liveAssistantText}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Voice picker sheet */}
            <AnimatePresence>
              {pickerOpen && !error && (
                <>
                  <motion.button
                    key="voice-picker-backdrop"
                    type="button"
                    initial={reducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="absolute inset-0 z-10 bg-black/55"
                    onClick={() => setPickerOpen(false)}
                    aria-label="Close voice picker"
                    tabIndex={-1}
                  />
                  <motion.div
                    key="voice-picker-sheet"
                    initial={
                      reducedMotion ? false : { opacity: 0, y: 24 }
                    }
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 24 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute inset-x-0 bottom-0 z-20 mx-auto flex max-h-[62%] w-full max-w-xl flex-col rounded-t-2xl border border-b-0 border-[#242424] bg-[#0d0d0d] px-5 pt-4"
                    data-testid="voice-picker-sheet"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-base font-semibold">Voices</h3>
                      <button
                        type="button"
                        onClick={() => setPickerOpen(false)}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[#8f8f8b] transition-colors hover:text-[#f5f5f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                        aria-label="Close voice picker"
                        data-testid="voice-picker-close"
                      >
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                    <div className="min-h-0 overflow-y-auto pb-5">
                      <div
                        role="radiogroup"
                        aria-label="Voice"
                        className="flex flex-col gap-1.5"
                      >
                        {presets.map((preset) => {
                          const selected = preset.id === activePresetId;
                          const previewing = sample.previewingId === preset.id;
                          return (
                            <div
                              key={preset.id}
                              className={cn(
                                'flex items-center gap-3 rounded-xl border px-3.5 py-2.5 transition-colors',
                                selected
                                  ? 'border-[#f5f5f2]/70 bg-[#161616]'
                                  : 'border-[#242424]',
                                !preset.available && 'opacity-50',
                              )}
                            >
                              <button
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                disabled={!preset.available}
                                onClick={() => selectPreset(preset.id)}
                                className="flex min-w-0 flex-1 flex-col items-start text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed"
                                data-testid={`voice-preset-${preset.id}`}
                              >
                                <span className="text-sm font-semibold text-[#f5f5f2]">
                                  {preset.name}
                                </span>
                                <span className="truncate text-xs text-[#8f8f8b]">
                                  {preset.available
                                    ? preset.persona
                                    : (preset.availabilityText ??
                                      'Unavailable right now')}
                                </span>
                              </button>
                              <button
                                type="button"
                                disabled={!preset.available}
                                onClick={() =>
                                  sample.playSample(preset.id, preset.sampleText)
                                }
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#242424] text-[#f5f5f2] transition-colors hover:border-[#3a3a3a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed"
                                aria-label={
                                  previewing
                                    ? `Stop ${preset.name} preview`
                                    : `Preview ${preset.name}`
                                }
                                data-testid={`voice-preview-${preset.id}`}
                              >
                                {previewing ? (
                                  <Square
                                    className="h-3 w-3 fill-current"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      {sample.sampleError && (
                        <p
                          className="mt-2 text-xs text-[#8f8f8b]"
                          data-testid="voice-sample-error"
                        >
                          {sample.sampleError}
                        </p>
                      )}
                      <div
                        className="mt-4 border-t border-[#242424] pt-4"
                        data-testid="voice-talkativeness-control"
                      >
                        <h4 className="mb-2.5 text-[13px] font-semibold">
                          Talkativeness
                        </h4>
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
                                onClick={() =>
                                  setVoicePreferences({ talkativeness: level })
                                }
                                className={cn(
                                  'rounded-full border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40',
                                  selected
                                    ? 'border-[#f5f5f2] bg-[#f5f5f2] text-[#0a0a09]'
                                    : 'border-[#242424] text-[#f5f5f2]/80 hover:bg-[#161616]',
                                )}
                                data-testid={`voice-talkativeness-${level}`}
                              >
                                {TALKATIVENESS_COPY[level].label}
                              </button>
                            );
                          })}
                        </div>
                        <p
                          className="mt-2 text-xs leading-5 text-[#8f8f8b]"
                          data-testid="voice-talkativeness-description"
                        >
                          {TALKATIVENESS_COPY[talkativeness].description}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </motion.div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
