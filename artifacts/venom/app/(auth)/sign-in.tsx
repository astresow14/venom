import React, { useCallback, useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useSignIn, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import { type Href, Link, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { AuthScreenShell } from '@/components/AuthScreenShell';
import {
  AuthErrorText,
  AuthPillButton,
  AuthQuietButton,
  AuthTextField,
} from '@/components/AuthUi';
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
  const [view, setView] = useState<'welcome' | 'email'>('welcome');
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
  const step = isVerification ? 'verify' : view;
  const isBusy = fetchStatus === 'fetching' || isGoogleLoading;
  const clerkError =
    errors.fields.identifier?.message ??
    errors.fields.password?.message ??
    errors.fields.code?.message;
  // Field-level Clerk errors belong to the credentials/code forms; the
  // welcome state only surfaces its own (e.g. Google) errors.
  const visibleError =
    step === 'welcome' ? formError : (formError ?? clerkError);

  const footerLink = (
    <Text style={[styles.footerText, { color: colors.symbioteMuted }]}>
      New to Venom?{' '}
      <Link
        href={'/(auth)/sign-up' as Href}
        style={[styles.footerLink, { color: colors.symbioteHighlight }]}
      >
        Create an account
      </Link>
    </Text>
  );

  return (
    <AuthScreenShell
      stateKey={step}
      heroWordmark={step === 'welcome'}
      headline={
        step === 'welcome'
          ? 'Sign in to Venom'
          : step === 'email'
            ? 'Sign in'
            : 'Verify this device'
      }
      supportText={step === 'verify' ? 'We emailed you a code.' : undefined}
      footer={step === 'verify' ? undefined : footerLink}
    >
      {step === 'welcome' ? (
        <View style={styles.stack}>
          <AuthPillButton
            testID="google-sign-in"
            accessibilityLabel="Continue with Google"
            label="Continue with Google"
            onPress={handleGoogle}
            busy={isGoogleLoading}
            disabled={isBusy}
            icon={
              <Ionicons
                name="logo-google"
                size={18}
                color={colors.symbioteBackdrop}
              />
            }
          />
          <AuthPillButton
            variant="ghost"
            testID="continue-with-email"
            accessibilityLabel="Continue with email"
            label="Continue with email"
            onPress={() => {
              setFormError(null);
              setView('email');
            }}
            disabled={isBusy}
          />
        </View>
      ) : null}

      {step === 'email' ? (
        <View>
          <AuthTextField
            label="Email"
            testID="sign-in-email"
            accessibilityLabel="Email"
            value={emailAddress}
            onChangeText={setEmailAddress}
            placeholder="you@example.com"
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
          />
          <AuthTextField
            label="Password"
            testID="sign-in-password"
            accessibilityLabel="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
          />
          <View style={styles.stack}>
            <AuthPillButton
              testID="submit-sign-in"
              accessibilityLabel="Sign in"
              label="Sign in"
              onPress={handleSubmit}
              busy={fetchStatus === 'fetching'}
              disabled={!emailAddress || !password || isBusy}
            />
            <AuthQuietButton
              accessibilityLabel="Back to all sign-in options"
              label="All sign-in options"
              onPress={() => {
                setFormError(null);
                setView('welcome');
              }}
            />
          </View>
        </View>
      ) : null}

      {step === 'verify' ? (
        <View>
          <AuthTextField
            label="Security code"
            testID="sign-in-code"
            accessibilityLabel="Security code"
            value={code}
            onChangeText={setCode}
            placeholder="000000"
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          <View style={styles.stack}>
            <AuthPillButton
              testID="verify-sign-in"
              accessibilityLabel="Verify device"
              label="Verify device"
              onPress={handleVerify}
              busy={isBusy}
              disabled={!code || isBusy}
            />
            <AuthQuietButton
              accessibilityLabel="Start sign-in over"
              label="Start over"
              onPress={() => {
                void signIn.reset();
                setCode('');
                setFormError(null);
                setView('welcome');
              }}
            />
          </View>
        </View>
      ) : null}

      {visibleError ? (
        <AuthErrorText testID="sign-in-error">{visibleError}</AuthErrorText>
      ) : null}
    </AuthScreenShell>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: 12,
  },
  footerText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
  },
  footerLink: {
    fontFamily: 'Inter_600SemiBold',
    textDecorationLine: 'underline',
  },
});
