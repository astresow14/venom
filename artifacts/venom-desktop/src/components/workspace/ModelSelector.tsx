/**
 * ModelSelector – the single Select-model pill in the chat composer.
 *
 * Shows the current selection (a model name, or the auto-policy handover)
 * and opens the combined models & voices dialog (ModelVoicesDialog, owned
 * by the chat page). It is the composer's one entry point for model
 * configuration — the old settings-gear sibling is gone on purpose to keep
 * the composer minimal.
 *
 * When the active space is a shared workspace whose admins lock model
 * settings, the pill says so: it stays visible and clickable, but announces
 * the workspace's policy instead of pretending the user's pick still drives
 * replies billed to the workspace.
 */

import React, { useMemo } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { useSharedWorkspace } from '@/context/shared-workspace';
import {
  getGetVenomBillingContextQueryKey,
  getGetVenomModelsQueryKey,
  useGetVenomBillingContext,
  useGetVenomModels,
  type VenomManagedModel,
} from '@workspace/api-client-react';
import { normalizeModelPreferences } from '@/lib/workspaceState';

export function ModelSelector({ onOpen }: { onOpen: () => void }) {
  const { state } = useVenomWorkspace();
  const { activeWorkspace } = useSharedWorkspace();

  const prefs = useMemo(
    () => normalizeModelPreferences(state.modelPreferences),
    [state.modelPreferences],
  );

  // Fetch models so we can show display names; stale-while-revalidate friendly
  const modelsQuery = useGetVenomModels({
    query: { staleTime: 60_000, queryKey: getGetVenomModelsQueryKey() },
  });

  // Admin model locks ride the billing context of the active space. Display
  // only — the server clamps every workspace-billed request regardless, so a
  // failed read just shows the user's own label while enforcement holds.
  const billingContextParams = activeWorkspace
    ? { workspaceId: activeWorkspace.id }
    : undefined;
  const billingContextQuery = useGetVenomBillingContext(billingContextParams, {
    query: {
      queryKey: getGetVenomBillingContextQueryKey(billingContextParams),
      enabled: Boolean(activeWorkspace),
      staleTime: 60_000,
      retry: 1,
    },
  });
  const modelLock = activeWorkspace
    ? (billingContextQuery.data?.modelLock ?? null)
    : null;
  const forcedPolicy = modelLock?.forcedSelectionPolicy ?? null;

  const modelMap = useMemo<Map<string, VenomManagedModel>>(() => {
    // Guard against a non-array payload (e.g. an HTML error page) so a bad
    // response degrades the picker instead of taking down the chat page.
    if (!Array.isArray(modelsQuery.data)) return new Map();
    return new Map(modelsQuery.data.map((m) => [m.id, m]));
  }, [modelsQuery.data]);

  // Active model metadata (may be null if models haven't loaded yet)
  const activeModel = modelMap.get(prefs.activeModelId);
  // In auto policies the pill announces the handover instead of a model
  // name — the server picks per reply, so no single name would be honest.
  const selectionPolicy = prefs.selectionPolicy ?? 'manual';
  // A manual pick the workspace's tier lock excludes is re-chosen by the
  // server, so the pill must not name a model that will not answer.
  const tierBlockedActive =
    !forcedPolicy &&
    selectionPolicy === 'manual' &&
    Boolean(
      modelLock?.allowedCostTiers &&
        activeModel &&
        !(
          activeModel.costTier &&
          modelLock.allowedCostTiers.includes(activeModel.costTier)
        ),
    );
  const managed = Boolean(forcedPolicy) || tierBlockedActive;
  const effectivePolicy = forcedPolicy ?? selectionPolicy;
  const activeLabel =
    effectivePolicy === 'auto-cheapest'
      ? 'Auto — cheapest'
      : effectivePolicy === 'auto-max-power'
        ? 'Auto — max power'
        : tierBlockedActive
          ? 'Auto — allowed models'
          : (activeModel?.name ?? prefs.activeModelId);
  const managedTitle = managed
    ? `Managed by ${activeWorkspace?.name ?? 'the workspace'} — its admins set the model policy for chats billed to the workspace. Your personal space keeps your own settings.`
    : undefined;

  if (modelsQuery.isPending) {
    // Subtle skeleton – keep composer height stable
    return (
      <div
        className="h-6 w-24 rounded-full bg-foreground/10 motion-safe:animate-pulse"
        aria-hidden="true"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={
        managed
          ? `Select model — currently ${activeLabel}. ${managedTitle}`
          : `Select model — currently ${activeLabel}`
      }
      title={managedTitle ?? 'Select model'}
      aria-haspopup="dialog"
      data-testid="button-model-chip"
    >
      {managed && (
        <Lock
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
          data-testid="model-chip-lock"
        />
      )}
      <span className="truncate" data-testid="text-active-model">
        {activeLabel}
      </span>
      <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
    </button>
  );
}
