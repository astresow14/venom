import React, { useCallback, useState } from 'react';
import { useAuth, useSignUp } from '@clerk/expo';
import { type Href, Link, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { AuthScreenShell } from '@/components/AuthScreenShell';
import {
  AuthErrorText,
  AuthPillButton,
  AuthQuietButton,
  AuthTextField,
} from '@/components/AuthUi';
import { useColors } from '@/hooks/useColors';

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Unable to create this account. Check your details and try again.';
}

export default function SignUpScreen() {
  const colors = useColors();
  const router = useRouter();
  const { isSignedIn } = useAuth();
  const { signUp, errors, fetchStatus } = useSignUp();
  const [emailAddress, setEmailAddress] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const finishSignUp = useCallback(async () => {
    await signUp.finalize({
      navigate: ({ session, decorateUrl }) => {
        if (session?.currentTask) {
          setFormError('Your account needs an additional verification step.');
          return;
        }
        router.replace(decorateUrl('/') as Href);
      },
    });
  }, [router, signUp]);

  const handleSubmit = async () => {
    setFormError(null);
    const { error } = await signUp.password({ emailAddress, password });
    if (error) {
      setFormError(errorMessage(error));
      return;
    }
    const result = await signUp.verifications.sendEmailCode();
    if (result.error) {
      setFormError(errorMessage(result.error));
    }
  };

  const handleVerify = async () => {
    setFormError(null);
    const { error } = await signUp.verifications.verifyEmailCode({ code });
    if (error) {
      setFormError(errorMessage(error));
      return;
    }
    if (signUp.status === 'complete') {
      await finishSignUp();
      return;
    }
    setFormError('Account verification is not complete yet.');
  };

  if (signUp.status === 'complete' || isSignedIn) return null;

  const isVerification =
    signUp.status === 'missing_requirements' &&
    signUp.unverifiedFields.includes('email_address') &&
    signUp.missingFields.length === 0;
  const step = isVerification ? 'verify' : 'form';
  const isBusy = fetchStatus === 'fetching';
  const clerkError =
    errors.fields.emailAddress?.message ??
    errors.fields.password?.message ??
    errors.fields.code?.message;
  const visibleError = formError ?? clerkError;

  const footerLink = (
    <Text style={[styles.footerText, { color: colors.symbioteMuted }]}>
      Already have an account?{' '}
      <Link
        href={'/(auth)/sign-in' as Href}
        style={[styles.footerLink, { color: colors.symbioteHighlight }]}
      >
        Sign in
      </Link>
    </Text>
  );

  return (
    <AuthScreenShell
      stateKey={step}
      headline={step === 'verify' ? 'Check your email' : 'Create your account'}
      supportText={
        step === 'verify'
          ? `Code sent to ${emailAddress}.`
          : 'One account. Every device.'
      }
      footer={step === 'verify' ? undefined : footerLink}
    >
      {step === 'verify' ? (
        <View>
          <AuthTextField
            label="Verification code"
            testID="sign-up-code"
            accessibilityLabel="Verification code"
            value={code}
            onChangeText={setCode}
            placeholder="000000"
            keyboardType="number-pad"
            autoComplete="one-time-code"
          />
          <View style={styles.stack}>
            <AuthPillButton
              testID="verify-sign-up"
              accessibilityLabel="Confirm account"
              label="Confirm account"
              onPress={handleVerify}
              busy={isBusy}
              disabled={!code || isBusy}
            />
            <AuthQuietButton
              accessibilityLabel="Send a new verification code"
              label="Send a new code"
              onPress={() => void signUp.verifications.sendEmailCode()}
            />
          </View>
        </View>
      ) : (
        <View>
          <AuthTextField
            label="Email"
            testID="sign-up-email"
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
            testID="sign-up-password"
            accessibilityLabel="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Pick a strong password"
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
          />
          <View style={styles.stack}>
            <AuthPillButton
              testID="submit-sign-up"
              accessibilityLabel="Create account"
              label="Create account"
              onPress={handleSubmit}
              busy={isBusy}
              disabled={!emailAddress || !password || isBusy}
            />
          </View>
          <View nativeID="clerk-captcha" />
        </View>
      )}

      {visibleError ? (
        <AuthErrorText testID="sign-up-error">{visibleError}</AuthErrorText>
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
