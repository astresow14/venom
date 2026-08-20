import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { VenomMark } from '@/components/VenomMark';
import { useColors } from '@/hooks/useColors';

type AuthScreenShellProps = {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

export function AuthScreenShell({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: AuthScreenShellProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.atmosphere,
          styles.atmosphereTop,
          { backgroundColor: colors.secondary },
        ]}
      />
      <View
        style={[
          styles.atmosphere,
          styles.atmosphereBottom,
          { backgroundColor: colors.muted },
        ]}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + 28,
            paddingBottom: insets.bottom + 28,
          },
        ]}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <VenomMark color={colors.foreground} size={42} />
          <Text style={[styles.wordmark, { color: colors.foreground }]}>
            Venom
          </Text>
        </View>

        <View
          style={[
            styles.panel,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              shadowColor: colors.foreground,
            },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.mutedForeground }]}>
            {eyebrow}
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>
            {title}
          </Text>
          <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
            {subtitle}
          </Text>
          {children}
        </View>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    overflow: 'hidden',
  },
  atmosphere: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.58,
  },
  atmosphereTop: {
    width: 420,
    height: 270,
    top: -150,
    right: -190,
    transform: [{ rotate: '-18deg' }],
  },
  atmosphereBottom: {
    width: 320,
    height: 220,
    bottom: -145,
    left: -150,
    transform: [{ rotate: '16deg' }],
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 22,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 480,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 11,
    marginBottom: 32,
  },
  wordmark: {
    fontFamily: 'Inter_700Bold',
    fontSize: 22,
    letterSpacing: -0.7,
  },
  panel: {
    borderWidth: 1,
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingVertical: 26,
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: Platform.OS === 'web' ? 0.08 : 0.12,
    shadowRadius: 32,
    elevation: 4,
  },
  eyebrow: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 12,
    letterSpacing: 0.1,
    marginBottom: 9,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 31,
    lineHeight: 37,
    letterSpacing: -1,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 26,
  },
  footer: {
    alignItems: 'center',
    marginTop: 22,
  },
});