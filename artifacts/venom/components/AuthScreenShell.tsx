import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import {
  SymbioteAuthBackdrop,
  useSymbioteInteraction,
} from '@/components/SymbioteAuthBackdrop';
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
  const { onPointerMove, onTouchEnd, onTouchMove, pointerX, pointerY } =
    useSymbioteInteraction();
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset =
    Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;

  return (
    <View
      style={[styles.screen, { backgroundColor: colors.symbioteBackdrop }]}
      onPointerMove={onPointerMove}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <SymbioteAuthBackdrop pointerX={pointerX} pointerY={pointerY} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: topInset + 28,
            paddingBottom: bottomInset + 28,
          },
        ]}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <VenomMark color={colors.symbioteHighlight} size={42} />
          <Text style={[styles.wordmark, { color: colors.symbioteHighlight }]}>
            Venom
          </Text>
        </View>

        <View
          style={[
            styles.panel,
            {
              backgroundColor:
                Platform.OS === 'web' ? colors.authPanel : colors.card,
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
    paddingHorizontal: 26,
    paddingVertical: 30,
    shadowOffset: { width: 0, height: 24 },
    shadowOpacity: Platform.OS === 'web' ? 0.06 : 0.1,
    shadowRadius: 48,
    elevation: 6,
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