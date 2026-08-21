import React, { useEffect, useRef } from "react";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { ClerkLoaded, ClerkLoading, ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, Platform, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import {
  IS_READ_ONLY_UI_TEST,
  IS_UI_TEST,
  UI_TEST_USER_ID,
  VenomProvider,
} from "@/context/VenomContext";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { SharedWorkspaceProvider } from "@/context/sharedWorkspace";
import {
  isWorkspaceAccessDeniedError,
  notifyWorkspaceAccessLost,
} from "@/lib/workspaceAccess";
import { useColors } from "@/hooks/useColors";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

SplashScreen.preventAutoHideAsync();

// Revocation of shared-workspace access surfaces as a 403 with a dedicated
// code on any workspace-scoped request. Every such error funnels through
// these hooks so cached workspace content is evicted centrally.
const handleRequestError = (error: unknown) => {
  if (isWorkspaceAccessDeniedError(error)) notifyWorkspaceAccessLost();
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleRequestError }),
  mutationCache: new MutationCache({ onError: handleRequestError }),
  defaultOptions: {
    queries: {
      // Access denial is deterministic — retrying cannot help.
      retry: (failureCount, error) =>
        !isWorkspaceAccessDeniedError(error) && failureCount < 3,
    },
  },
});

const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

if (!publishableKey) {
  throw new Error("Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
}
const clerkPublishableKey: string = publishableKey;

function AppLoading() {
  const colors = useColors();

  return (
    <View
      accessibilityLabel="Loading Venom"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.symbioteBackdrop,
      }}
    >
      <ActivityIndicator size="small" color={colors.symbioteHighlight} />
    </View>
  );
}
function RootLayoutNav() {
  const { getToken, isSignedIn, userId } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const effectiveUserId = IS_UI_TEST ? UI_TEST_USER_ID : (userId ?? null);
  const colors = useColors();
  const { theme } = useTheme();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const canOpenWorkspace = Boolean(isSignedIn) || IS_READ_ONLY_UI_TEST;

  useEffect(() => {
    setAuthTokenGetter(
      !IS_UI_TEST && isSignedIn ? () => getToken() : null,
    );
    return () => setAuthTokenGetter(null);
  }, [getToken, isSignedIn]);

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== effectiveUserId
    ) {
      queryClient.clear();
    }
    previousUserId.current = effectiveUserId;
  }, [effectiveUserId]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(
      canOpenWorkspace ? colors.background : colors.symbioteBackdrop,
    );
  }, [canOpenWorkspace, colors.background, colors.symbioteBackdrop]);

  useEffect(() => {
    const isInAuthGroup = segments[0] === "(auth)";
    if (!canOpenWorkspace && !isInAuthGroup) {
      router.replace("/(auth)/sign-in");
    } else if (canOpenWorkspace && isInAuthGroup) {
      router.replace("/");
    }
  }, [canOpenWorkspace, router, segments]);

  return (
    <>
      <StatusBar
        style={canOpenWorkspace ? (theme === "dark" ? "light" : "dark") : "light"}
      />
      <VenomProvider>
        <SharedWorkspaceProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: {
              backgroundColor: canOpenWorkspace
                ? colors.background
                : colors.symbioteBackdrop,
            },
            animation: "fade",
          }}
        >
          <Stack.Protected guard={!canOpenWorkspace}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
          <Stack.Protected guard={canOpenWorkspace}>
            <Stack.Screen name="index" />
            <Stack.Screen name="projects" />
            <Stack.Screen name="settings" />
            <Stack.Screen name="knowledge" />
            <Stack.Screen name="apps" />
            <Stack.Screen name="sops" />
            <Stack.Screen name="workspaces" />
            <Stack.Screen name="community/profile" />
            <Stack.Screen name="community/new" />
            <Stack.Screen name="community/[threadId]" />
          </Stack.Protected>
        </Stack>
        </SharedWorkspaceProvider>
      </VenomProvider>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError || Platform.OS === "web") {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError && Platform.OS !== "web") return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <ClerkProvider
              publishableKey={clerkPublishableKey}
              tokenCache={tokenCache}
              proxyUrl={proxyUrl}
            >
              <ClerkLoading>
                <AppLoading />
              </ClerkLoading>
              <ClerkLoaded>
                <GestureHandlerRootView style={{ flex: 1 }}>
                  <KeyboardProvider>
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
              </ClerkLoaded>
            </ClerkProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
