/**
 * ModelSelector – compact active-model picker in the chat composer.
 *
 * Shows only enabled models. Tapping opens a small popover with the list.
 * Long-press / settings icon opens ModelLibraryDialog.
 */

import React, { useMemo, useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { ChevronDown, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useVenomWorkspace } from '@/context/venom-workspace';
import { getGetVenomModelsQueryKey, useGetVenomModels, type VenomManagedModel } from '@workspace/api-client-react';
import { normalizeModelPreferences } from '@/lib/workspaceState';
import { ModelLibraryDialog } from './ModelLibraryDialog';

export function ModelSelector() {
  const [open, setOpen] = useState(false);
  const { state, setActiveModelId } = useVenomWorkspace();

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
  const activeLabel = activeModel?.name ?? prefs.activeModelId;

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

  if (enabledModels.length <= 1 && hasData) {
    // Only one model – show label, still allow opening library
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground" data-testid="text-active-model">
          {activeLabel}
        </span>
        <ModelLibraryDialog>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Manage models"
            title="Manage models"
          >
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </ModelLibraryDialog>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              '-ml-1 flex items-center gap-1 rounded-md px-1 py-0.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              open
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            aria-label={`Active model: ${activeLabel}. Press to change.`}
            aria-expanded={open}
            aria-haspopup="listbox"
          >
            {activeLabel}
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-52 rounded-xl border border-border p-1 shadow-md"
          role="listbox"
          aria-label="Choose active model"
        >
          <div className="flex flex-col gap-0.5">
            {enabledModels.map((model) => {
              const isActive = prefs.activeModelId === model.id;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    setActiveModelId(model.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <span className="truncate">{model.name}</span>
                  {isActive && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-1 border-t border-border pt-1">
            <ModelLibraryDialog>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setOpen(false)}
              >
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                Manage models
              </button>
            </ModelLibraryDialog>
          </div>
        </PopoverContent>
      </Popover>

      <ModelLibraryDialog>
        <button
          type="button"
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Manage models"
          title="Manage models"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </ModelLibraryDialog>
    </div>
  );
}
