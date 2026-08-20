import React from 'react';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
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
          styles.orbit,
          styles.orbitLarge,
          { borderColor: colors.border },
        ]}
      />
      <View
        style={[
          styles.orbit,
          styles.orbitSmall,
          { borderColor: colors.accent },
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
          <View
            style={[
              styles.logoFrame,
              { borderColor: colors.primary, backgroundColor: colors.card },
            ]}
          >
            <Image
              source={require('@/assets/images/icon_2.png')}
              style={styles.logo}
              contentFit="contain"
            />
          </View>
          <Text style={[styles.wordmark, { color: colors.primary }]}>VENOM</Text>
        </View>

        <View
          style={[
            styles.panel,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.eyebrow, { color: colors.primary }]}>
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
  orbit: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 999,
    opacity: 0.45,
  },
  orbitLarge: {
    width: 360,
    height: 360,
    top: -170,
    right: -150,
  },
  orbitSmall: {
    width: 220,
    height: 220,
    bottom: -110,
    left: -90,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  brand: {
    alignItems: 'center',
    marginBottom: 28,
  },
  logoFrame: {
    width: 72,
    height: 72,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
  logo: {
    width: 52,
    height: 52,
    transform: [{ rotate: '-45deg' }],
  },
  wordmark: {
    marginTop: 18,
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    letterSpacing: 6,
  },
  panel: {
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  eyebrow: {
    fontFamily: 'Inter_700Bold',
    fontSize: 10,
    letterSpacing: 2.2,
    marginBottom: 10,
  },
  title: {
    fontFamily: 'Inter_700Bold',
    fontSize: 28,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 24,
  },
  footer: {
    alignItems: 'center',
    marginTop: 22,
  },
});