import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { useColors } from '@/hooks/useColors';

/**
 * Error tone for the always-dark auth surface. The palette's `destructive`
 * flips with the device theme and its light value is unreadable on the black
 * symbiote backdrop, so auth uses this fixed light red.
 */
const AUTH_ERROR_COLOR = '#ffb4ab';

type AuthTextFieldProps = TextInputProps & {
  label: string;
};

/** A labelled input that sits directly on the dark backdrop — no card. */
export function AuthTextField({
  label,
  style,
  onFocus,
  onBlur,
  ...props
}: AuthTextFieldProps) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: colors.symbioteMuted }]}>
        {label}
      </Text>
      <TextInput
        placeholderTextColor="rgba(247, 247, 247, 0.34)"
        {...props}
        style={[
          styles.input,
          {
            color: colors.symbioteHighlight,
            backgroundColor: 'rgba(247, 247, 247, 0.05)',
            borderColor: focused
              ? colors.symbioteHighlight
              : 'rgba(247, 247, 247, 0.16)',
          },
          focused && styles.inputFocused,
          style,
        ]}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
      />
    </View>
  );
}

type AuthPillButtonProps = {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  variant?: 'white' | 'ghost';
  icon?: React.ReactNode;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
};

/** Full-width pill action sitting directly on the background. */
export function AuthPillButton({
  label,
  accessibilityLabel,
  onPress,
  variant = 'white',
  icon,
  busy = false,
  disabled = false,
  testID,
}: AuthPillButtonProps) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);
  const isWhite = variant === 'white';
  const ink = colors.symbioteBackdrop;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, busy }}
      style={({ pressed }) => [
        styles.pill,
        isWhite
          ? { backgroundColor: colors.symbioteHighlight }
          : {
              backgroundColor: 'rgba(247, 247, 247, 0.06)',
              borderWidth: 1,
              borderColor: 'rgba(247, 247, 247, 0.22)',
            },
        pressed && styles.pressed,
        disabled && styles.disabled,
        focused && styles.focused,
        focused && { outlineColor: colors.symbioteHighlight },
      ]}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      disabled={disabled}
    >
      {busy ? (
        <ActivityIndicator color={isWhite ? ink : colors.symbioteHighlight} />
      ) : (
        <>
          {icon}
          <Text
            style={[
              styles.pillText,
              { color: isWhite ? ink : colors.symbioteHighlight },
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

type AuthQuietButtonProps = {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
};

/** Low-emphasis text action (start over, resend, back). */
export function AuthQuietButton({
  label,
  accessibilityLabel,
  onPress,
  testID,
}: AuthQuietButtonProps) {
  const colors = useColors();
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.quiet,
        focused && styles.focused,
        focused && { outlineColor: colors.symbioteHighlight },
      ]}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <Text style={[styles.quietText, { color: colors.symbioteMuted }]}>
        {label}
      </Text>
    </Pressable>
  );
}

type AuthErrorTextProps = {
  children: string;
  testID?: string;
};

export function AuthErrorText({ children, testID }: AuthErrorTextProps) {
  return (
    <Text
      testID={testID}
      accessibilityLiveRegion="polite"
      role="alert"
      style={styles.error}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  fieldWrap: {
    marginBottom: 18,
  },
  fieldLabel: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.2,
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 18,
    minHeight: 54,
    paddingHorizontal: 18,
    paddingVertical: 14,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
  },
  inputFocused: {
    borderWidth: 2,
  },
  pill: {
    minHeight: 56,
    borderRadius: 28,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  pillText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 16,
    letterSpacing: -0.2,
  },
  quiet: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  quietText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 13,
    letterSpacing: 0,
  },
  error: {
    fontFamily: 'Inter_500Medium',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 16,
    textAlign: 'center',
    color: AUTH_ERROR_COLOR,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
  disabled: {
    opacity: 0.45,
  },
  focused: {
    outlineStyle: 'solid',
    outlineWidth: 3,
    outlineOffset: 3,
  },
});
