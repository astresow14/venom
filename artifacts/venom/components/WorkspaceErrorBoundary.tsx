import React, { PropsWithChildren, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { ErrorFallbackProps } from '@/components/ErrorFallback';
import { IS_UI_TEST } from '@/context/VenomContext';
import { useColors } from '@/hooks/useColors';

/**
 * Blast-radius fence around one workspace surface.
 *
 * Every workspace stays mounted from startup (see app/index.tsx), so before
 * this existed a single render- or effect-time throw in any one of them —
 * hidden or not — escaped to the root ErrorBoundary and replaced the ENTIRE
 * app with "Something went wrong". Wrapping each surface individually means
 * a broken feature degrades in place: the tab bar, and every other
 * workspace, keep working, and the failed surface offers its own retry.
 */

export type WorkspaceSurface =
  | 'chat'
  | 'feed'
  | 'notifications'
  | 'brain'
  | 'todo';

declare global {
  // Set by browser tests (addInitScript) before any app code runs, to force
  // a crash inside one workspace: "feed" throws at effect time (the shape of
  // the original slime incident), "feed:render" throws during render.
  // eslint-disable-next-line no-var
  var __venomCrashWorkspace: string | undefined;
}

function crashPhaseFor(surface: WorkspaceSurface): 'render' | 'effect' | null {
  if (!IS_UI_TEST) return null;
  const directive = globalThis.__venomCrashWorkspace;
  if (typeof directive !== 'string') return null;
  const [target, phase = 'effect'] = directive.split(':');
  if (target !== surface) return null;
  return phase === 'render' ? 'render' : 'effect';
}

/**
 * UI-test-only fault injector. Mounted inside the boundary, so its throw
 * must be contained exactly the way a real workspace bug would be. Renders
 * nothing and does nothing unless the test set the crash directive.
 */
function WorkspaceCrashProbe({ surface }: { surface: WorkspaceSurface }) {
  const phase = crashPhaseFor(surface);

  useEffect(() => {
    if (phase !== 'effect') return;
    throw new Error(
      `Forced effect-time crash in the ${surface} workspace (ui-test probe)`,
    );
  }, [phase, surface]);

  if (phase === 'render') {
    throw new Error(
      `Forced render-time crash in the ${surface} workspace (ui-test probe)`,
    );
  }
  return null;
}

type WorkspaceErrorFallbackProps = ErrorFallbackProps & {
  surface: WorkspaceSurface;
  title: string;
};

function WorkspaceErrorFallback({
  surface,
  title,
  error,
  resetError,
}: WorkspaceErrorFallbackProps) {
  const colors = useColors();
  const [retryFocused, setRetryFocused] = useState(false);

  const monoFont = Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'monospace',
  });

  return (
    <View
      style={styles.container}
      testID={`workspace-error-${surface}`}
      accessibilityRole="alert"
      accessibilityLabel={`The ${title} workspace hit a problem. The rest of Venom is still running.`}
    >
      <View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <View style={[styles.icon, { backgroundColor: colors.secondary }]}>
          <Feather name="alert-triangle" size={20} color={colors.foreground} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>
          {title} hit a problem
        </Text>
        <Text style={[styles.description, { color: colors.mutedForeground }]}>
          This surface crashed, but the rest of Venom is still running. Retry
          it here, or keep working in the other tabs.
        </Text>
        <TouchableOpacity
          testID={`workspace-error-retry-${surface}`}
          style={[
            styles.retryButton,
            { backgroundColor: colors.primary },
            retryFocused && [
              styles.retryButtonFocused,
              { outlineColor: colors.foreground },
            ],
          ]}
          activeOpacity={0.78}
          onPress={resetError}
          onFocus={() => setRetryFocused(true)}
          onBlur={() => setRetryFocused(false)}
          accessibilityRole="button"
          accessibilityLabel={`Retry the ${title} workspace`}
        >
          <Text
            style={[styles.retryText, { color: colors.primaryForeground }]}
          >
            Retry {title}
          </Text>
        </TouchableOpacity>
        {__DEV__ ? (
          <Text
            style={[
              styles.devDetail,
              { color: colors.mutedForeground, fontFamily: monoFont },
            ]}
            numberOfLines={3}
          >
            {error.message}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export type WorkspaceErrorBoundaryProps = PropsWithChildren<{
  surface: WorkspaceSurface;
  /** Human name shown in the fallback, matching the tab title. */
  title: string;
}>;

export function WorkspaceErrorBoundary({
  surface,
  title,
  children,
}: WorkspaceErrorBoundaryProps) {
  // surface/title are stable per mount point, so this component type is
  // stable too and the fallback does not remount across renders.
  const FallbackComponent = useMemo(
    () =>
      function BoundWorkspaceErrorFallback(props: ErrorFallbackProps) {
        return (
          <WorkspaceErrorFallback surface={surface} title={title} {...props} />
        );
      },
    [surface, title],
  );

  return (
    <ErrorBoundary
      FallbackComponent={FallbackComponent}
      onError={(error) => {
        console.error(
          `[venom] ${title} workspace crashed; degraded to its fallback while the rest of the app keeps running`,
          error,
        );
      }}
    >
      {IS_UI_TEST ? <WorkspaceCrashProbe surface={surface} /> : null}
      {children}
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 16,
    padding: 24,
    alignItems: 'flex-start',
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 20,
    letterSpacing: -0.4,
  },
  description: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 20,
  },
  retryButton: {
    minHeight: 48,
    borderRadius: 24,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  retryButtonFocused: {
    outlineStyle: 'solid',
    outlineWidth: 2,
    outlineOffset: 2,
  },
  retryText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
  },
  devDetail: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: 14,
  },
});
