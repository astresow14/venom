import React, { useCallback, useState } from 'react';
import { useAuth, useSignUp } from '@clerk/expo';
import { type Href, Link, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AuthScreenShell } from '@/components/AuthScreenShell';
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
  const isBusy = fetchStatus === 'fetching';
  const clerkError =
    errors.fields.emailAddress?.message ??
    errors.fields.password?.message ??
    errors.fields.code?.message;
  const visibleError = formError ?? clerkError;

  return (
    <AuthScreenShell
      eyebrow={isVerification ? 'EMAIL VERIFICATION' : 'NEW OPERATOR'}
      title={isVerification ? 'Confirm your account' : 'Create your workspace'}
      subtitle={
        isVerification
          ? `We sent a security code to ${emailAddress}.`
          : 'One secure account keeps your intelligence workspace available on every device.'
      }
      footer={
        <Text style={[styles.footerText, { color: colors.mutedForeground }]}>
          Already have an account?{' '}
          <Link href={'/(auth)/sign-in' as Href} style={{ color: colors.primary }}>
            Sign in
          </Link>
        </Text>
      }
    >
      {isVerification ? (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>
            VERIFICATION CODE
          </Text>
          <TextInput
            testID="sign-up-code"
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
            testID="verify-sign-up"
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
                CONFIRM ACCOUNT
              </Text>
            )}
          </Pressable>
          <Pressable
            style={styles.resendButton}
            onPress={() => void signUp.verifications.sendEmailCode()}
          >
            <Text
              style={[styles.resendText, { color: colors.mutedForeground }]}
            >
              SEND A NEW CODE
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>EMAIL</Text>
          <TextInput
            testID="sign-up-email"
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
            testID="sign-up-password"
            style={[
              styles.input,
              { color: colors.foreground, borderColor: colors.border },
            ]}
            value={password}
            onChangeText={setPassword}
            placeholder="Create a secure password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
          />
          <Pressable
            testID="submit-sign-up"
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              (!emailAddress || !password || isBusy) && styles.disabled,
            ]}
            onPress={handleSubmit}
            disabled={!emailAddress || !password || isBusy}
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
                CREATE ACCOUNT
              </Text>
            )}
          </Pressable>
          <View nativeID="clerk-captcha" />
        </>
      )}

      {visibleError ? (
        <Text
          testID="sign-up-error"
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
  error: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16,
  },
  resendButton: {
    alignItems: 'center',
    paddingTop: 18,
  },
  resendText: {
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