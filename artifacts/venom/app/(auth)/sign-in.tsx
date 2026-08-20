import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSignIn, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import { type Href, Link, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AuthScreenShell } from '@/components/AuthScreenShell';
import { useColors } from '@/hooks/useColors';

WebBrowser.maybeCompleteAuthSession();

function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Unable to authenticate. Check your details and try again.';
}

export default function SignInScreen() {
  useWarmUpBrowser();
  const colors = useColors();
  const router = useRouter();
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  const [emailAddress, setEmailAddress] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const finishSignIn = useCallback(async () => {
    await signIn.finalize({
      navigate: ({ session, decorateUrl }) => {
        if (session?.currentTask) {
          setFormError('Your account needs an additional verification step.');
          return;
        }
        router.replace(decorateUrl('/') as Href);
      },
    });
  }, [router, signIn]);

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signIn.password({ emailAddress, password });
    if (error) {
      setFormError(errorMessage(error));
      return;
    }

    if (signIn.status === 'complete') {
      await finishSignIn();
      return;
    }

    if (
      signIn.status === 'needs_client_trust' ||
      signIn.status === 'needs_second_factor'
    ) {
      const emailFactor = signIn.supportedSecondFactors.find(
        (factor) => factor.strategy === 'email_code',
      );
      if (emailFactor) {
        await signIn.mfa.sendEmailCode();
        return;
      }
    }

    setFormError('This account requires a sign-in method not yet available.');
  };

  const handleVerify = async () => {
    setFormError(null);
    const { error } = await signIn.mfa.verifyEmailCode({ code });
    if (error) {
      setFormError(errorMessage(error));
      return;
    }
    if (signIn.status === 'complete') {
      await finishSignIn();
    }
  };

  const handleGoogle = async () => {
    setFormError(null);
    setIsGoogleLoading(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google',
        redirectUrl: AuthSession.makeRedirectUri({
          scheme: 'venom',
          path: 'oauth-native-callback',
        }),
      });

      if (!createdSessionId || !setActive) {
        setFormError('Google sign-in needs an additional account step.');
        return;
      }

      await setActive({
        session: createdSessionId,
        navigate: ({ session, decorateUrl }) => {
          if (session?.currentTask) {
            setFormError('Your account needs an additional verification step.');
            return;
          }
          router.replace(decorateUrl('/') as Href);
        },
      });
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const isVerification =
    signIn.status === 'needs_client_trust' ||
    signIn.status === 'needs_second_factor';
  const isBusy = fetchStatus === 'fetching' || isGoogleLoading;
  const clerkError =
    errors.fields.identifier?.message ??
    errors.fields.password?.message ??
    errors.fields.code?.message;
  const visibleError = formError ?? clerkError;

  return (
    <AuthScreenShell
      eyebrow={isVerification ? 'IDENTITY CHALLENGE' : 'SECURE ACCESS'}
      title={isVerification ? 'Verify this device' : 'Resume your workspace'}
      subtitle={
        isVerification
          ? 'Enter the security code sent to your account.'
          : 'Sign in to restore projects, conversations, and your knowledge map on this device.'
      }
      footer={
        <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
          New to Venom?{' '}
          <Link href={'/(auth)/sign-up' as Href} style={{ color: colors.primary }}>
            Create an account
          </Link>
        </Text>
      }
    >
      {isVerification ? (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>
            SECURITY CODE
          </Text>
          <TextInput
            testID="sign-in-code"
            style={[
              styles.input,
              { color: colors.foreground, borderColor: colors.border },
            ]}
            value={code}
            onChangeText={setCode}
            placeholder="000000"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          <Pressable
            testID="verify-sign-in"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              (!code || isBusy) && styles.disabled,
            ]}
            onPress={handleVerify}
            disabled={!code || isBusy}
          >
            {isBusy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: colors.primaryForeground },
                ]}
              >
                VERIFY DEVICE
              </Text>
            )}
          </Pressable>
          <Pressable
            style={styles.resetButton}
            onPress={() => {
              void signIn.reset();
              setCode('');
              setFormError(null);
            }}
          >
            <Text style={[styles.resetText, { color: colors.mutedForeground }]}>
              START OVER
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>EMAIL</Text>
          <TextInput
            testID="sign-in-email"
            style={[
              styles.input,
              { color: colors.foreground, borderColor: colors.border },
            ]}
            value={emailAddress}
            onChangeText={setEmailAddress}
            placeholder="operator@example.com"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
          />
          <Text style={[styles.label, { color: colors.foreground }]}>
            PASSWORD
          </Text>
          <TextInput
            testID="sign-in-password"
            style={[
              styles.input,
              { color: colors.foreground, borderColor: colors.border },
            ]}
            value={password}
            onChangeText={setPassword}
            placeholder="Enter your password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
          />
          <Pressable
            testID="submit-sign-in"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              (!emailAddress || !password || isBusy) && styles.disabled,
            ]}
            onPress={handleSubmit}
            disabled={!emailAddress || !password || isBusy}
          >
            {fetchStatus === 'fetching' ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: colors.primaryForeground },
                ]}
              >
                SIGN IN
              </Text>
            )}
          </Pressable>
          <View style={styles.dividerRow}>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
            <Text
              style={[styles.dividerText, { color: colors.mutedForeground }]}
            >
              OR
            </Text>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
          </View>
          <Pressable
            testID="google-sign-in"
            style={({ pressed }) => [
              styles.secondaryButton,
              { borderColor: colors.border, backgroundColor: colors.accent },
              pressed && styles.pressed,
              isBusy && styles.disabled,
            ]}
            onPress={handleGoogle}
            disabled={isBusy}
          >
            {isGoogleLoading ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <>
                <Ionicons
                  name="logo-google"
                  size={18}
                  color={colors.foreground}
                />
                <Text
                  style={[
                    styles.secondaryButtonText,
                    { color: colors.foreground },
                  ]}
                >
                  CONTINUE WITH GOOGLE
                </Text>
              </>
            )}
          </Pressable>
        </>
      )}

      {visibleError ? (
        <Text
          testID="sign-in-error"
          style={[styles.error, { color: colors.destructive }]}
        >
          {visibleError}
        </Text>
      ) : null}
    </AuthScreenShell>
  );
}

const styles = StyleSheet.create({
  label: {
    fontFamily: 'Inter_700Bold',
    fontSize: 10,
    letterSpacing: 1.8,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    marginBottom: 18,
  },
  primaryButton: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 12,
    letterSpacing: 2,
  },
  secondaryButton: {
    minHeight: 50,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  secondaryButtonText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.3,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 18,
  },
  divider: {
    height: 1,
    flex: 1,
  },
  dividerText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.5,
  },
  error: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16,
  },
  resetButton: {
    alignItems: 'center',
    paddingTop: 18,
  },
  resetText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.6,
  },
  footerText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 13,
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.45,
  },
});