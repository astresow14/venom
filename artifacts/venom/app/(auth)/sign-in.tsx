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
  const [focusedButton, setFocusedButton] = useState<
    'google' | 'reset' | 'submit' | 'verify' | null
  >(null);
  const [focusedField, setFocusedField] = useState<
    'email' | 'password' | 'code' | null
  >(null);

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
      eyebrow={isVerification ? 'Security check' : 'Welcome back'}
      title={isVerification ? 'Verify this device' : 'Resume your workspace'}
      subtitle={
        isVerification
          ? 'Enter the security code sent to your account.'
          : 'Sign in to restore projects, conversations, and your knowledge map on this device.'
      }
      footer={
        <Text style={[styles.footerText, { color: colors.symbioteMuted }]}>
          New to Venom?{' '}
             <Link
               href={'/(auth)/sign-up' as Href}
               style={[
                 styles.footerLink,
                 { color: colors.symbioteHighlight },
               ]}
             >
            Create an account
          </Link>
        </Text>
      }
    >
      {isVerification ? (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>
            Security code
          </Text>
          <TextInput
            testID="sign-in-code"
            accessibilityLabel="Security code"
            style={[
              styles.input,
              {
                color: colors.foreground,
                borderColor:
                  focusedField === 'code' ? colors.foreground : colors.border,
                backgroundColor: colors.background,
              },
              focusedField === 'code' && styles.inputFocused,
            ]}
            value={code}
            onChangeText={setCode}
            onFocus={() => setFocusedField('code')}
            onBlur={() => setFocusedField(null)}
            placeholder="000000"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          <Pressable
            testID="verify-sign-in"
            accessibilityRole="button"
            accessibilityLabel="Verify device"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              (!code || isBusy) && styles.disabled,
              focusedButton === 'verify' && styles.buttonFocused,
              focusedButton === 'verify' && { outlineColor: colors.foreground },
            ]}
            onPress={handleVerify}
            onFocus={() => setFocusedButton('verify')}
            onBlur={() => setFocusedButton(null)}
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
                Verify device
              </Text>
            )}
          </Pressable>
          <Pressable
            style={[
              styles.resetButton,
              focusedButton === 'reset' && styles.buttonFocused,
              focusedButton === 'reset' && { outlineColor: colors.foreground },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Start sign-in over"
            onPress={() => {
              void signIn.reset();
              setCode('');
              setFormError(null);
            }}
            onFocus={() => setFocusedButton('reset')}
            onBlur={() => setFocusedButton(null)}
          >
            <Text style={[styles.resetText, { color: colors.mutedForeground }]}>
              Start over
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>Email</Text>
          <TextInput
            testID="sign-in-email"
            accessibilityLabel="Email"
            style={[
              styles.input,
              {
                color: colors.foreground,
                borderColor:
                  focusedField === 'email' ? colors.foreground : colors.border,
                backgroundColor: colors.background,
              },
              focusedField === 'email' && styles.inputFocused,
            ]}
            value={emailAddress}
            onChangeText={setEmailAddress}
            onFocus={() => setFocusedField('email')}
            onBlur={() => setFocusedField(null)}
            placeholder="you@example.com"
            placeholderTextColor={colors.mutedForeground}
            keyboardType="email-address"
            textContentType="emailAddress"
            autoComplete="email"
            autoCapitalize="none"
          />
          <Text style={[styles.label, { color: colors.foreground }]}>
            Password
          </Text>
          <TextInput
            testID="sign-in-password"
            accessibilityLabel="Password"
            style={[
              styles.input,
              {
                color: colors.foreground,
                borderColor:
                  focusedField === 'password'
                    ? colors.foreground
                    : colors.border,
                backgroundColor: colors.background,
              },
              focusedField === 'password' && styles.inputFocused,
            ]}
            value={password}
            onChangeText={setPassword}
            onFocus={() => setFocusedField('password')}
            onBlur={() => setFocusedField(null)}
            placeholder="Enter your password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            textContentType="password"
            autoComplete="current-password"
          />
          <Pressable
            testID="submit-sign-in"
            accessibilityRole="button"
            accessibilityLabel="Sign in"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              (!emailAddress || !password || isBusy) && styles.disabled,
              focusedButton === 'submit' && styles.buttonFocused,
              focusedButton === 'submit' && { outlineColor: colors.foreground },
            ]}
            onPress={handleSubmit}
            onFocus={() => setFocusedButton('submit')}
            onBlur={() => setFocusedButton(null)}
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
                Sign in
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
              Or
            </Text>
            <View
              style={[styles.divider, { backgroundColor: colors.border }]}
            />
          </View>
          <Pressable
            testID="google-sign-in"
            accessibilityRole="button"
            accessibilityLabel="Continue with Google"
            style={({ pressed }) => [
              styles.secondaryButton,
              { borderColor: colors.border, backgroundColor: colors.accent },
              pressed && styles.pressed,
              isBusy && styles.disabled,
              focusedButton === 'google' && styles.buttonFocused,
              focusedButton === 'google' && { outlineColor: colors.foreground },
            ]}
            onPress={handleGoogle}
            onFocus={() => setFocusedButton('google')}
            onBlur={() => setFocusedButton(null)}
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
                  Continue with Google
                </Text>
              </>
            )}
          </Pressable>
        </>
      )}

      {visibleError ? (
        <Text
          testID="sign-in-error"
          accessibilityLiveRegion="polite"
          role="alert"
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
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    letterSpacing: 0,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 15,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    marginBottom: 20,
  },
  inputFocused: {
    borderWidth: 2,
  },
  primaryButton: {
    minHeight: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 15,
    letterSpacing: 0,
  },
  secondaryButton: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  secondaryButtonText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
    letterSpacing: 0,
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
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    letterSpacing: 0,
  },
  error: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16,
  },
  resetButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 8,
  },
  resetText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    letterSpacing: 0,
  },
  footerText: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
  },
  footerLink: {
    fontFamily: 'Inter_600SemiBold',
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.45,
  },
  buttonFocused: {
    outlineStyle: 'solid',
    outlineWidth: 3,
    outlineOffset: 3,
  },
});