/**
 * ModelVoicesDialog – the one composer popup for models AND voices.
 *
 * Combines what used to be two separate surfaces:
 *  - the Model Library (enable / set default / remove, availability notes),
 *  - the blend panel: the voice triangle plus, in Verify, a per-voice picker
 *    choosing which enabled model plays First take / Skeptic / Evidence, and
 *    in Debate the corner roster picker.
 *
 * The argue-itself rule is enforced inline: opposing voices can never share
 * an LLM provider, so conflicting options render disabled with a plain
 * explanation. Evidence is neutral and may reuse a provider. The server
 * enforces the same rule for the mobile app and direct API callers.
 */

import React, { useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, Check, Plus, Trash2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { asList } from '@/lib/as-list';
import {
  getGetVenomModelsQueryKey,
  useGetVenomModels,
  type VenomDeliberationVoice,
  type VenomManagedModel,
  type VenomModelId,
  type VenomModelSelectionPolicy,
  type VenomVoiceModelPick,
} from '@workspace/api-client-react';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { normalizeModelPreferences } from '@/lib/workspaceState';
import { BlendPad, type BlendPadCorner } from './BlendPad';
import type { BlendWeights, ResponseMode } from '@/lib/blend';

// Provider badge label mapping
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google',
  openrouter: 'OpenRouter',
};

type VoicePickVoiceId = VenomVoiceModelPick['voiceId'];

/** The three verify voices, in pad-corner order, with offline fallbacks. */
const VERIFY_VOICES: Array<{ id: VoicePickVoiceId; fallbackName: string }> = [
  { id: 'direct', fallbackName: 'First take' },
  { id: 'skeptic', fallbackName: 'Skeptic' },
  { id: 'evidence', fallbackName: 'Evidence' },
];

/** The explicit pick a voice must not clash with (verify: direct ↔ skeptic). */
const OPPOSING_VOICE: Partial<Record<VoicePickVoiceId, VoicePickVoiceId>> = {
  direct: 'skeptic',
  skeptic: 'direct',
};

/**
 * The account-level selection policy choices. Manual keeps explicit picks;
 * the auto modes hand every request's model choice to the server, which
 * re-decides against the live catalog so health flips switch the next reply.
 */
const POLICY_OPTIONS: Array<{
  id: VenomModelSelectionPolicy;
  label: string;
  hint: string;
}> = [
  { id: 'manual', label: 'Manual', hint: 'You choose the models' },
  { id: 'auto-cheapest', label: 'Auto — cheapest', hint: 'Cheapest healthy models' },
  { id: 'auto-max-power', label: 'Auto — max power', hint: 'Most capable models' },
];

function ModelCard({
  model,
  isEnabled,
  isActive,
  isDefault,
  enabledCount,
  actionsDisabled,
  onEnable,
  onRemove,
  onSetDefault,
  onUse,
}: {
  model: VenomManagedModel;
  isEnabled: boolean;
  isActive: boolean;
  isDefault: boolean;
  enabledCount: number;
  /** True while an auto policy owns the picks — actions hand over to Venom. */
  actionsDisabled?: boolean;
  onEnable: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
  onUse: () => void;
}) {
  const canRemove = isEnabled && enabledCount > 1 && !actionsDisabled;
  const policyTitle = actionsDisabled
    ? 'Venom is choosing models automatically — switch back to Manual to change this'
    : undefined;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 border p-4 transition-all rounded-xl shadow-soft',
        isEnabled
          ? 'border-border/60 surface'
          : 'border-border/60 bg-transparent opacity-60',
      )}
      aria-label={`Model: ${model.name}${isEnabled ? ' (enabled)' : ' (disabled)'}${isActive ? ', active' : ''}${isDefault ? ', default' : ''}`}
      data-testid={`model-card-${model.id}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold truncate">
              {model.name}
            </span>
            {isActive && (
              <span className="text-xs font-medium rounded-full px-2 py-0.5 shrink-0 bg-foreground text-background">
                Active
              </span>
            )}
            {isDefault && (
              <span className="text-xs font-medium border border-border/60 rounded-full px-2 py-0.5 shrink-0 bg-muted/50">
                Default
              </span>
            )}
            {model.costTier && (
              <span
                className="text-xs font-medium border border-border/60 rounded-full px-2 py-0.5 shrink-0 text-muted-foreground"
                title="Relative cost"
                aria-label={`Relative cost ${model.costTier} of $$$`}
                data-testid={`cost-badge-${model.id}`}
              >
                {model.costTier}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs font-medium text-muted-foreground">
            {PROVIDER_LABELS[model.provider] ?? model.provider} &middot; {model.family}
          </div>
        </div>

        {/* Status indicator: configured + account issue is a third, warned
            state — the key stays valid, so the model remains selectable while
            the provider account problem is called out. */}
        <div
          className={cn(
            'shrink-0 h-2 w-2 rounded-full mt-1.5',
            !model.available
              ? 'bg-muted-foreground'
              : model.accountHealth === 'unfunded'
                ? 'bg-destructive/80'
                : 'bg-foreground',
          )}
          title={
            !model.available
              ? 'Unavailable'
              : model.accountHealth === 'unfunded'
                ? 'Provider account issue'
                : 'Available'
          }
          aria-label={
            !model.available
              ? 'Unavailable'
              : model.accountHealth === 'unfunded'
                ? 'Provider account issue'
                : 'Available'
          }
        />
      </div>

      {/* Summary */}
      <p className="text-xs text-muted-foreground leading-relaxed">{model.summary}</p>

      {/* Availability text */}
      <p
        className={cn(
          'text-xs font-medium',
          model.available && model.accountHealth !== 'unfunded'
            ? 'text-muted-foreground'
            : 'text-destructive/80',
        )}
      >
        {model.availabilityText}
      </p>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {!isEnabled ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-md text-xs font-medium border-border/60 hover:bg-foreground hover:text-background transition-colors shadow-soft"
            onClick={onEnable}
            disabled={!model.available || actionsDisabled}
            aria-label={`Enable ${model.name}`}
            title={policyTitle}
          >
            <Plus className="h-3 w-3 mr-1" />
            Enable
          </Button>
        ) : (
          <>
            {!isActive && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-md text-xs font-medium border-border/60 hover:bg-foreground hover:text-background transition-colors shadow-soft"
                onClick={onUse}
                disabled={actionsDisabled}
                aria-label={`Use ${model.name} as the active model`}
                title={policyTitle}
                data-testid={`button-use-${model.id}`}
              >
                Use
              </Button>
            )}
            {!isDefault && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-md text-xs font-medium border-border/60 hover:bg-foreground hover:text-background transition-colors shadow-soft"
                onClick={onSetDefault}
                disabled={actionsDisabled}
                aria-label={`Set ${model.name} as default`}
                title={policyTitle}
              >
                <Check className="h-3 w-3 mr-1" />
                Set Default
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 rounded-md text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              onClick={onRemove}
              disabled={!canRemove}
              aria-label={
                canRemove
                  ? `Remove ${model.name}`
                  : `Cannot remove ${model.name} right now`
              }
              title={
                actionsDisabled
                  ? policyTitle
                  : !canRemove
                    ? 'At least one model must remain enabled'
                    : undefined
              }
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Remove
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function ModelVoicesDialog({
  open,
  onOpenChange,
  openerRef,
  responseMode,
  deliberationAvailable,
  distinctModels,
  personaVoices,
  voicePicks,
  onVoicePickChange,
  blendCorners,
  padWeights,
  onPadChange,
  onPadCommit,
  padDisabled,
  cornersPickable,
  usableModels,
  onCornerToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The element that opened the dialog. This dialog is controlled and has no
   * Radix trigger, and Radix's default close handling focuses its (absent)
   * trigger — which would drop focus on the page body. Restoring to the real
   * opener keeps the popup keyboard-round-trippable from every entry point.
   */
  openerRef?: React.RefObject<HTMLElement | null>;
  responseMode: ResponseMode;
  deliberationAvailable: boolean;
  /** False when fewer than two models are usable — voice choice is limited. */
  distinctModels: boolean;
  /** Deliberation roster (names + taglines) for the verify voice rows. */
  personaVoices?: VenomDeliberationVoice[];
  /** Normalized per-conversation voice picks (verify only). */
  voicePicks: VenomVoiceModelPick[];
  /** null clears the voice back to Auto. */
  onVoicePickChange: (voiceId: VoicePickVoiceId, modelId: VenomModelId | null) => void;
  blendCorners: [BlendPadCorner, BlendPadCorner, BlendPadCorner] | null;
  padWeights: BlendWeights;
  onPadChange: (weights: BlendWeights) => void;
  onPadCommit: (weights: BlendWeights) => void;
  padDisabled?: boolean;
  /** Debate: whether extra usable models exist to swap into the corners. */
  cornersPickable: boolean;
  /** Enabled models that are available and funded — the pickable roster. */
  usableModels: VenomManagedModel[];
  onCornerToggle: (modelId: string) => void;
}) {
  const { state, setModelPreferences, setActiveModelId } = useVenomWorkspace();

  const modelsQuery = useGetVenomModels({
    query: {
      enabled: open,
      staleTime: 30_000,
      queryKey: getGetVenomModelsQueryKey(),
    },
  });

  const prefs = useMemo(
    () => normalizeModelPreferences(state.modelPreferences),
    [state.modelPreferences],
  );

  // Account-level selection policy. In the auto modes the server owns every
  // model choice, so the manual surfaces below visibly hand over instead of
  // pretending their picks still drive anything.
  const selectionPolicy = prefs.selectionPolicy ?? 'manual';
  const autoPolicyActive = selectionPolicy !== 'manual';

  const enabledSet = useMemo(
    () => new Set(prefs.enabledModelIds),
    [prefs.enabledModelIds],
  );

  // Full catalog lookup (provider metadata even for unusable models), with
  // the usable roster as a fallback while the catalog is still loading.
  const catalogById = useMemo(() => {
    const map = new Map<string, VenomManagedModel>();
    for (const model of usableModels) map.set(model.id, model);
    for (const model of asList(modelsQuery.data)) map.set(model.id, model);
    return map;
  }, [usableModels, modelsQuery.data]);

  const handleEnable = useCallback(
    (modelId: VenomManagedModel['id']) => {
      const next = [...enabledSet, modelId] as typeof prefs.enabledModelIds;
      setModelPreferences({ enabledModelIds: next });
    },
    [enabledSet, setModelPreferences],
  );

  const handleRemove = useCallback(
    (modelId: VenomManagedModel['id']) => {
      if (enabledSet.size <= 1) return; // never remove the last
      const next = [...enabledSet].filter((id) => id !== modelId) as typeof prefs.enabledModelIds;
      const updates: Partial<typeof prefs> = { enabledModelIds: next };
      // If removing default, pick first remaining as default
      if (prefs.defaultModelId === modelId) updates.defaultModelId = next[0];
      // If removing active, reset to default
      if (prefs.activeModelId === modelId) updates.activeModelId = updates.defaultModelId ?? next[0];
      setModelPreferences(updates);
      // A removed model cannot keep playing a voice: clear any pick naming it.
      for (const pick of voicePicks) {
        if (pick.modelId === modelId) onVoicePickChange(pick.voiceId, null);
      }
    },
    [enabledSet, prefs, setModelPreferences, voicePicks, onVoicePickChange],
  );

  const handleSetDefault = useCallback(
    (modelId: VenomManagedModel['id']) => {
      setModelPreferences({ defaultModelId: modelId });
    },
    [setModelPreferences],
  );

  // Order: enabled first, then disabled
  // A failed request resolves to the error body rather than throwing, so a
  // settled non-array response is a service failure, not an empty catalog.
  // Without this the dialog would claim no models exist on a 401.
  const modelsUnreadable =
    !modelsQuery.isPending && !Array.isArray(modelsQuery.data);

  const orderedModels = useMemo(() => {
    return [...asList(modelsQuery.data)].sort((a, b) => {
      const aEnabled = enabledSet.has(a.id) ? 0 : 1;
      const bEnabled = enabledSet.has(b.id) ? 0 : 1;
      return aEnabled - bEnabled;
    });
  }, [modelsQuery.data, enabledSet]);

  // ── Voices (verify) ────────────────────────────────────────────────────────
  const pickByVoice = useMemo(() => {
    const map = new Map<VoicePickVoiceId, VenomModelId>();
    for (const pick of voicePicks) map.set(pick.voiceId, pick.modelId);
    return map;
  }, [voicePicks]);

  const personaByVoice = useMemo(() => {
    const map = new Map<string, VenomDeliberationVoice>();
    for (const voice of personaVoices ?? []) map.set(voice.voiceId, voice);
    return map;
  }, [personaVoices]);

  /** Why `model` cannot play `voiceId`, or undefined when it can. */
  const conflictFor = useCallback(
    (voiceId: VoicePickVoiceId, model: VenomManagedModel): string | undefined => {
      const opposingVoice = OPPOSING_VOICE[voiceId];
      if (!opposingVoice) return undefined; // Evidence is neutral
      const opposingId = pickByVoice.get(opposingVoice);
      // No explicit opposing pick — auto-assignment steers around clashes.
      if (!opposingId) return undefined;
      const opposing = catalogById.get(opposingId);
      if (!opposing) return undefined;
      if (model.id === opposing.id) {
        return `${opposing.name} can't argue itself`;
      }
      if (model.provider === opposing.provider) {
        return `${model.name} and ${opposing.name} both run on ${PROVIDER_LABELS[model.provider] ?? model.provider}`;
      }
      return undefined;
    },
    [pickByVoice, catalogById],
  );

  const showVoices = deliberationAvailable && responseMode !== 'talk';
  const verifySection = showVoices && responseMode === 'verify';
  const debateSection = showVoices && responseMode === 'debate';

  // Debate: swapping in a candidate replaces the least-favored corner, so a
  // candidate clashes when it shares a provider with a corner that stays.
  const debateKeptProviders = useMemo(() => {
    if (!debateSection || !blendCorners) return new Set<string>();
    let replaceIndex = 0;
    for (let index = 1; index < 3; index += 1) {
      if (padWeights[index] < padWeights[replaceIndex]) replaceIndex = index;
    }
    const kept = new Set<string>();
    blendCorners.forEach((corner, index) => {
      if (index === replaceIndex) return;
      const provider = catalogById.get(corner.id)?.provider;
      if (provider) kept.add(provider);
    });
    return kept;
  }, [debateSection, blendCorners, padWeights, catalogById]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg w-full p-0 gap-0 border border-border/60 rounded-2xl shadow-lift surface sheen"
        data-testid="dialog-model-voices"
        onCloseAutoFocus={(event) => {
          const opener = openerRef?.current;
          if (opener && opener.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
      >
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Models &amp; voices
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {verifySection
              ? 'Choose which model plays each voice and balance them on the pad. Manage your model library below.'
              : debateSection
                ? 'Choose which models take the debate corners and balance them. Manage your model library below.'
                : "Enable models, set your default, or remove ones you don't use. Only enabled models appear in the composer."}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-5 max-h-[65vh] overflow-y-auto flex flex-col gap-6">
          {/* ── Selection policy ───────────────────────────────────────── */}
          <section aria-label="Model selection" className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Model selection
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Manual keeps your picks. In the auto modes Venom chooses on
                every reply and adapts as availability changes.
              </p>
            </div>
            <div
              role="radiogroup"
              aria-label="Model selection policy"
              className="grid grid-cols-3 gap-1.5"
              data-testid="model-policy-control"
            >
              {POLICY_OPTIONS.map((option) => {
                const selected = selectionPolicy === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setModelPreferences({ selectionPolicy: option.id })
                    }
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border/60 text-muted-foreground hover:text-foreground',
                    )}
                    data-testid={`policy-${option.id}`}
                  >
                    <span className="text-xs font-semibold">{option.label}</span>
                    <span
                      className={cn(
                        'text-[10px]',
                        selected
                          ? 'text-background/70'
                          : 'text-muted-foreground/80',
                      )}
                    >
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
            {autoPolicyActive && (
              <div
                className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5"
                data-testid="model-policy-takeover"
              >
                <Zap className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                <p className="text-xs text-muted-foreground">
                  Venom is choosing —{' '}
                  {selectionPolicy === 'auto-cheapest'
                    ? 'the cheapest healthy models carry every reply, and the account switches automatically when availability or account health changes.'
                    : 'the most capable models carry every reply, and the account switches automatically when availability changes.'}{' '}
                  Your manual picks are kept for when you switch back.
                </p>
              </div>
            )}
          </section>

          {/* ── Voices ─────────────────────────────────────────────────── */}
          {showVoices && blendCorners && (
            <section
              aria-label={verifySection ? 'Voices' : 'Debate corners'}
              className="flex flex-col gap-3"
            >
              <div>
                <h3 className="text-sm font-semibold tracking-tight">
                  {verifySection ? 'Voices' : 'Debate corners'}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {verifySection
                    ? "Opposing voices never share a provider — a model can't argue itself. Evidence is neutral."
                    : "Every corner runs on a different provider — a model can't argue itself."}
                </p>
              </div>

              <div className="flex justify-center">
                <BlendPad
                  corners={blendCorners}
                  weights={padWeights}
                  onChange={onPadChange}
                  onCommit={onPadCommit}
                  // Debate corners are model picks, and in auto policies the
                  // server seats its own corners — weighting ghosts would be
                  // dishonest. Verify weights ride the stable voice roles
                  // (First take / Skeptic / Evidence), so the pad stays live.
                  disabled={padDisabled || (debateSection && autoPolicyActive)}
                />
              </div>

              {/* Auto policies own voice-model assignment: the pickers hand
                  over rather than pretending explicit picks still apply. */}
              {autoPolicyActive && (
                <p
                  className="text-xs text-muted-foreground text-center"
                  data-testid="voices-policy-takeover"
                >
                  Venom is choosing which models{' '}
                  {verifySection ? 'play the voices' : 'take the corners'} —{' '}
                  {selectionPolicy === 'auto-cheapest'
                    ? 'the cheapest healthy models serve this conversation.'
                    : 'the most capable models serve this conversation.'}
                </p>
              )}

              {/* Verify: one picker row per voice */}
              {!autoPolicyActive && verifySection && distinctModels && (
                <div className="flex flex-col gap-3">
                  {VERIFY_VOICES.map(({ id, fallbackName }) => {
                    const persona = personaByVoice.get(id);
                    const name = persona?.name ?? fallbackName;
                    const picked = pickByVoice.get(id);
                    const opposingVoice = OPPOSING_VOICE[id];
                    const opposingId = opposingVoice
                      ? pickByVoice.get(opposingVoice)
                      : undefined;
                    const opposing = opposingId
                      ? catalogById.get(opposingId)
                      : undefined;
                    return (
                      <div key={id} className="flex flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-semibold">{name}</span>
                          {id === 'evidence' && (
                            <span className="text-[10px] text-muted-foreground">
                              Neutral — may share a provider
                            </span>
                          )}
                        </div>
                        <div
                          className="flex flex-wrap items-center gap-1.5"
                          role="group"
                          aria-label={`Model for ${name}`}
                        >
                          <button
                            type="button"
                            aria-pressed={!picked}
                            onClick={() => onVoicePickChange(id, null)}
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              !picked
                                ? 'border-foreground bg-foreground text-background'
                                : 'border-border/60 text-muted-foreground hover:text-foreground',
                            )}
                            data-testid={`voice-pick-${id}-auto`}
                          >
                            Auto
                          </button>
                          {usableModels.map((model) => {
                            const selected = picked === model.id;
                            const conflict = conflictFor(id, model);
                            return (
                              <button
                                key={model.id}
                                type="button"
                                aria-pressed={selected}
                                disabled={Boolean(conflict) && !selected}
                                title={conflict}
                                onClick={() => onVoicePickChange(id, model.id)}
                                className={cn(
                                  'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                  selected
                                    ? 'border-foreground bg-foreground text-background'
                                    : conflict
                                      ? 'border-border/40 text-muted-foreground/50 cursor-not-allowed'
                                      : 'border-border/60 text-muted-foreground hover:text-foreground',
                                )}
                                data-testid={`voice-pick-${id}-${model.id}`}
                              >
                                {selected && (
                                  <Check className="h-3 w-3" aria-hidden="true" />
                                )}
                                {model.name}
                              </button>
                            );
                          })}
                        </div>
                        {opposing && opposingVoice && (
                          <p
                            className="text-[11px] text-muted-foreground"
                            data-testid={`voice-conflict-note-${id}`}
                          >
                            {opposing.name} can&apos;t argue itself — pick a
                            different model for {name}.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Verify with a single usable model: explain, don't offer */}
              {!autoPolicyActive && verifySection && !distinctModels && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-voices-limited"
                >
                  Only one model is usable right now, so every voice runs on
                  it. Enable another provider&apos;s model below to choose who
                  plays each voice.
                </p>
              )}

              {/* Debate: corner roster picker */}
              {!autoPolicyActive && debateSection && cornersPickable && (
                <div
                  className="flex flex-wrap items-center justify-center gap-1.5"
                  role="group"
                  aria-label="Choose which three models take the corners"
                  data-testid="blend-corner-picker"
                >
                  {usableModels.map((model) => {
                    const seated = blendCorners.some(
                      (corner) => corner.id === model.id,
                    );
                    const clash =
                      !seated && debateKeptProviders.has(model.provider);
                    return (
                      <button
                        key={model.id}
                        type="button"
                        aria-pressed={seated}
                        disabled={clash}
                        title={
                          clash
                            ? `${model.name} runs on ${PROVIDER_LABELS[model.provider] ?? model.provider}, which already holds a corner — debate participants need different providers.`
                            : undefined
                        }
                        onClick={() => onCornerToggle(model.id)}
                        className={cn(
                          'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          seated
                            ? 'border-foreground bg-foreground text-background'
                            : clash
                              ? 'border-border/40 text-muted-foreground/50 cursor-not-allowed'
                              : 'border-border/60 text-muted-foreground hover:text-foreground',
                        )}
                        data-testid={`button-corner-pick-${model.id}`}
                      >
                        {seated && <Check className="h-3 w-3" aria-hidden="true" />}
                        {model.name}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Debate without three usable models: personas hold the corners */}
              {!autoPolicyActive && debateSection && !cornersPickable && usableModels.length < 3 && (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="text-voices-limited"
                >
                  Fewer than three models are usable right now, so Venom&apos;s
                  built-in voices take the corners. Enable more providers below
                  to choose the debaters.
                </p>
              )}
            </section>
          )}

          {/* ── Model library ──────────────────────────────────────────── */}
          <section aria-label="Model library" className="flex flex-col gap-3">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Model library
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Enable models, set your default, or remove ones you don&apos;t
                use. Only enabled models appear in the composer.
              </p>
            </div>

            {modelsQuery.isPending && (
              <div className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-32 w-full rounded-xl bg-foreground/10" />
                ))}
              </div>
            )}

            {(modelsQuery.isError || modelsUnreadable) && (
              <div className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3">
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                <p className="text-xs font-medium text-destructive">
                  Could not load models. Check your connection and try again.
                </p>
              </div>
            )}

            {modelsQuery.isSuccess && !modelsUnreadable && orderedModels.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No models available.
              </p>
            )}

            {modelsQuery.isSuccess && !modelsUnreadable && orderedModels.length > 0 && (
              <div className="flex flex-col gap-3">
                {orderedModels.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    isEnabled={enabledSet.has(model.id)}
                    isActive={prefs.activeModelId === model.id}
                    isDefault={prefs.defaultModelId === model.id}
                    enabledCount={enabledSet.size}
                    actionsDisabled={autoPolicyActive}
                    onEnable={() => handleEnable(model.id)}
                    onRemove={() => handleRemove(model.id)}
                    onSetDefault={() => handleSetDefault(model.id)}
                    onUse={() => setActiveModelId(model.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="px-6 py-4 border-t border-border/60 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="rounded-md h-9 text-xs font-medium border-border/60 hover:bg-foreground hover:text-background shadow-soft"
            onClick={() => onOpenChange(false)}
            data-testid="button-model-voices-done"
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
