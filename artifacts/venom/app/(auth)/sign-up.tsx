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
  const [focusedButton, setFocusedButton] = useState<
    'resend' | 'submit' | 'verify' | null
  >(null);
  const [focusedField, setFocusedField] = useState<
    'email' | 'password' | 'code' | null
  >(null);

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
      eyebrow={isVerification ? 'Email verification' : 'Start with Venom'}
      title={isVerification ? 'Confirm your account' : 'Create your workspace'}
      subtitle={
        isVerification
          ? `We sent a security code to ${emailAddress}.`
          : 'One secure account keeps your intelligence workspace available on every device.'
      }
      footer={
        <Text style={[styles.footerText, { color: colors.symbioteMuted }]}>
          Already have an account?{' '}
          <Link
            href={'/(auth)/sign-in' as Href}
            style={[
              styles.footerLink,
              { color: colors.symbioteHighlight },
            ]}
          >
            Sign in
          </Link>
        </Text>
      }
    >
      {isVerification ? (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>
            Verification code
          </Text>
          <TextInput
            testID="sign-up-code"
            accessibilityLabel="Verification code"
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
            testID="verify-sign-up"
            accessibilityRole="button"
            accessibilityLabel="Confirm account"
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
                Confirm account
              </Text>
            )}
          </Pressable>
          <Pressable
            style={[
              styles.resendButton,
              focusedButton === 'resend' && styles.buttonFocused,
              focusedButton === 'resend' && { outlineColor: colors.foreground },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send a new verification code"
            onPress={() => void signUp.verifications.sendEmailCode()}
            onFocus={() => setFocusedButton('resend')}
            onBlur={() => setFocusedButton(null)}
          >
            <Text
              style={[styles.resendText, { color: colors.mutedForeground }]}
            >
              Send a new code
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.foreground }]}>Email</Text>
          <TextInput
            testID="sign-up-email"
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
            testID="sign-up-password"
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
            placeholder="Create a secure password"
            placeholderTextColor={colors.mutedForeground}
            secureTextEntry
            textContentType="newPassword"
            autoComplete="new-password"
          />
          <Pressable
            testID="submit-sign-up"
            accessibilityRole="button"
            accessibilityLabel="Create account"
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
            {isBusy ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[
                  styles.primaryButtonText,
                  { color: colors.primaryForeground },
                ]}
              >
                Create account
              </Text>
            )}
          </Pressable>
          <View nativeID="clerk-captcha" />
        </>
      )}

      {visibleError ? (
        <Text
          testID="sign-up-error"
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
  error: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 16,
  },
  resendButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: 8,
  },
  resendText: {
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