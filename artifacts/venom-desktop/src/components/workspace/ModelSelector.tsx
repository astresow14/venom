/**
 * ModelSelector – compact active-model chip in the chat composer.
 *
 * Shows the active model's name. Both the chip and the settings icon open
 * the combined models & voices dialog (ModelVoicesDialog, owned by the chat
 * page); this component no longer carries a popup of its own.
 */

import React, { useMemo } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import { useVenomWorkspace } from '@/context/venom-workspace';
import {
  getGetVenomModelsQueryKey,
  useGetVenomModels,
  type VenomManagedModel,
} from '@workspace/api-client-react';
import { normalizeModelPreferences } from '@/lib/workspaceState';

export function ModelSelector({ onOpen }: { onOpen: () => void }) {
  const { state } = useVenomWorkspace();

  const prefs = useMemo(
    () => normalizeModelPreferences(state.modelPreferences),
    [state.modelPreferences],
  );

  // Fetch models so we can show display names; stale-while-revalidate friendly
  const modelsQuery = useGetVenomModels({
    query: { staleTime: 60_000, queryKey: getGetVenomModelsQueryKey() },
  });

  const modelMap = useMemo<Map<string, VenomManagedModel>>(() => {
    // Guard against a non-array payload (e.g. an HTML error page) so a bad
    // response degrades the picker instead of taking down the chat page.
    if (!Array.isArray(modelsQuery.data)) return new Map();
    return new Map(modelsQuery.data.map((m) => [m.id, m]));
  }, [modelsQuery.data]);

  const enabledModels = useMemo<VenomManagedModel[]>(() => {
    return prefs.enabledModelIds
      .map((id) => modelMap.get(id))
      .filter((m): m is VenomManagedModel => Boolean(m));
  }, [prefs.enabledModelIds, modelMap]);

  // Active model metadata (may be null if models haven't loaded yet)
  const activeModel = modelMap.get(prefs.activeModelId);
  // In auto policies the chip announces the handover instead of a model
  // name — the server picks per reply, so no single name would be honest.
  const selectionPolicy = prefs.selectionPolicy ?? 'manual';
  const activeLabel =
    selectionPolicy === 'auto-cheapest'
      ? 'Auto — cheapest'
      : selectionPolicy === 'auto-max-power'
        ? 'Auto — max power'
        : (activeModel?.name ?? prefs.activeModelId);

  // Only render if there are enabled models with metadata, else show nothing
  // (avoids UI flash before first fetch)
  const hasData = modelsQuery.isSuccess && enabledModels.length > 0;

  if (!hasData && modelsQuery.isPending) {
    // Subtle skeleton – keep composer height stable
    return (
      <div
        className="h-5 w-20 rounded-md bg-foreground/10 motion-safe:animate-pulse"
        aria-hidden="true"
      />
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={onOpen}
        className="-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Active model: ${activeLabel}. Open models and voices.`}
        aria-haspopup="dialog"
        data-testid="button-model-chip"
      >
        <span data-testid="text-active-model">{activeLabel}</span>
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={onOpen}
        className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Manage models and voices"
        title="Manage models and voices"
        aria-haspopup="dialog"
        data-testid="button-manage-models"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
