import React, { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkLoaded, ClerkLoading, ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, View } from "react-native";
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
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { IS_READ_ONLY_UI_TEST, VenomProvider } from "@/context/VenomContext";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { useColors } from "@/hooks/useColors";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;

if (!publishableKey) {
  throw new Error("Missing EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY");
}
const clerkPublishableKey: string = publishableKey;

function RootLayoutNav() {
  const { getToken, isSignedIn, userId } = useAuth();
  const colors = useColors();
  const { theme } = useTheme();
  const previousUserId = useRef<string | null | undefined>(undefined);
  const canOpenWorkspace = Boolean(isSignedIn) || IS_READ_ONLY_UI_TEST;

  useEffect(() => {
    setAuthTokenGetter(isSignedIn ? () => getToken() : null);
    return () => setAuthTokenGetter(null);
  }, [getToken, isSignedIn]);

  useEffect(() => {
    if (
      previousUserId.current !== undefined &&
      previousUserId.current !== (userId ?? null)
    ) {
      queryClient.clear();
    }
    previousUserId.current = userId ?? null;
  }, [userId]);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  return (
    <>
      <StatusBar style={theme === "dark" ? "light" : "dark"} />
      <VenomProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
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
          </Stack.Protected>
        </Stack>
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
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

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
                <View
                  style={{
                    flex: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#050908",
                  }}
                >
                  <ActivityIndicator size="small" color="#b4f536" />
                </View>
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
