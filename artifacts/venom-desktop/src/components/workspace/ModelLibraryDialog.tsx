/**
 * ModelLibraryDialog – polished monochrome model-management dialog.
 *
 * Allows users to:
 *  - View all managed models returned by GET /venom/models
 *  - Enable / remove (disable) models
 *  - Set the default model
 *
 * Uses VenomModelPreferences stored in the WorkspaceState.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, BookOpen, Check, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { asList } from '@/lib/as-list';
import {
  getGetVenomModelsQueryKey,
  useGetVenomModels,
  type VenomManagedModel,
} from '@workspace/api-client-react';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { normalizeModelPreferences } from '@/lib/workspaceState';

// Provider badge label mapping
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google',
  openrouter: 'OpenRouter',
};

function ModelCard({
  model,
  isEnabled,
  isDefault,
  enabledCount,
  onEnable,
  onRemove,
  onSetDefault,
}: {
  model: VenomManagedModel;
  isEnabled: boolean;
  isDefault: boolean;
  enabledCount: number;
  onEnable: () => void;
  onRemove: () => void;
  onSetDefault: () => void;
}) {
  const canRemove = isEnabled && enabledCount > 1;

  return (
    <div
      className={cn(
        'flex flex-col gap-3 border p-4 transition-all rounded-xl shadow-soft',
        isEnabled
          ? 'border-border/60 surface'
          : 'border-border/60 bg-transparent opacity-60',
      )}
      aria-label={`Model: ${model.name}${isEnabled ? ' (enabled)' : ' (disabled)'}${isDefault ? ', default' : ''}`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold truncate">
              {model.name}
            </span>
            {isDefault && (
              <span className="text-xs font-medium border border-border/60 rounded-full px-2 py-0.5 shrink-0 bg-muted/50">
                Default
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs font-medium text-muted-foreground">
            {PROVIDER_LABELS[model.provider] ?? model.provider} &middot; {model.family}
          </div>
        </div>

        {/* Status indicator */}
        <div
          className={cn(
            'shrink-0 h-2 w-2 rounded-full mt-1.5',
            model.available ? 'bg-foreground' : 'bg-muted-foreground',
          )}
          title={model.available ? 'Available' : 'Unavailable'}
          aria-label={model.available ? 'Available' : 'Unavailable'}
        />
      </div>

      {/* Summary */}
      <p className="text-xs text-muted-foreground leading-relaxed">{model.summary}</p>

      {/* Availability text */}
      <p
        className={cn(
          'text-xs font-medium',
          model.available ? 'text-muted-foreground' : 'text-destructive/80',
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
            disabled={!model.available}
            aria-label={`Enable ${model.name}`}
          >
            <Plus className="h-3 w-3 mr-1" />
            Enable
          </Button>
        ) : (
          <>
            {!isDefault && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 rounded-md text-xs font-medium border-border/60 hover:bg-foreground hover:text-background transition-colors shadow-soft"
                onClick={onSetDefault}
                aria-label={`Set ${model.name} as default`}
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
                  : `Cannot remove ${model.name} – it is the only enabled model`
              }
              title={
                !canRemove ? 'At least one model must remain enabled' : undefined
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

export function ModelLibraryDialog({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { state, setModelPreferences } = useVenomWorkspace();

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

  const enabledSet = useMemo(
    () => new Set(prefs.enabledModelIds),
    [prefs.enabledModelIds],
  );

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
    },
    [enabledSet, prefs, setModelPreferences],
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
    // A failed request resolves to the error body rather than throwing, so this
    // can be an object even though the generated type promises an array.
    return [...asList(modelsQuery.data)].sort((a, b) => {
      const aEnabled = enabledSet.has(a.id) ? 0 : 1;
      const bEnabled = enabledSet.has(b.id) ? 0 : 1;
      return aEnabled - bEnabled;
    });
  }, [modelsQuery.data, enabledSet]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-w-lg w-full p-0 gap-0 border border-border/60 rounded-2xl shadow-lift surface sheen">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <BookOpen className="h-4 w-4" />
            Model Library
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Enable models, set your default, or remove ones you don't use.
            Only enabled models appear in the model selector.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-5 max-h-[60vh] overflow-y-auto">
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
                  isDefault={prefs.defaultModelId === model.id}
                  enabledCount={enabledSet.size}
                  onEnable={() => handleEnable(model.id)}
                  onRemove={() => handleRemove(model.id)}
                  onSetDefault={() => handleSetDefault(model.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border/60 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="rounded-md h-9 text-xs font-medium border-border/60 hover:bg-foreground hover:text-background shadow-soft"
            onClick={() => setOpen(false)}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
