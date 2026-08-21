import React, { useEffect } from 'react';
import {
  Platform,
  type StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import {
  SymbioteAuthBackdrop,
  useSymbioteInteraction,
} from '@/components/SymbioteAuthBackdrop';
import { VenomWordmark } from '@/components/VenomWordmark';
import { useColors } from '@/hooks/useColors';

type AuthScreenShellProps = {
  /**
   * Identity of the current step ('welcome' | 'email' | 'verify' | ...).
   * Changing it replays the staggered reveal for the new step's content.
   */
  stateKey: string;
  /** Large decorative visual shown above the headline (welcome state). */
  hero?: React.ReactNode;
  headline: string;
  /** One quiet line under the headline. Keep it short. */
  supportText?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
};

type RevealProps = {
  children: React.ReactNode;
  delay?: number;
  style?: StyleProp<ViewStyle>;
};

/** Fade-and-rise entrance; instant when the user prefers reduced motion. */
function Reveal({ children, delay = 0, style }: RevealProps) {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) }),
    );
  }, [delay, progress, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * 16 }],
  }));

  return <Animated.View style={[animatedStyle, style]}>{children}</Animated.View>;
}

/**
 * Open, card-free auth layout: small brand row up top, an optional hero and
 * display headline, then the caller's stacked actions sitting directly on the
 * living backdrop.
 */
export function AuthScreenShell({
  stateKey,
  hero,
  headline,
  supportText,
  children,
  footer,
}: AuthScreenShellProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { onPointerMove, onTouchEnd, onTouchMove, pointerX, pointerY } =
    useSymbioteInteraction();
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset =
    Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;

  const displaySize = Math.round(
    Math.min(Math.max(Math.min(width, 480) * 0.125, 40), 56),
  );

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
            paddingTop: topInset + 12,
            paddingBottom: bottomInset + 22,
          },
        ]}
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Reveal>
          <View style={styles.brand}>
            <VenomWordmark color={colors.symbioteHighlight} height={32} />
          </View>
        </Reveal>

        <View key={stateKey} style={styles.body}>
          {hero ? (
            <>
              <View style={styles.spacerAboveHero} />
              <Reveal delay={70} style={styles.heroWrap}>
                {hero}
              </Reveal>
              <Reveal delay={150}>
                <Text
                  accessibilityRole="header"
                  style={[
                    styles.display,
                    {
                      color: colors.symbioteHighlight,
                      fontSize: displaySize,
                      lineHeight: Math.round(displaySize * 1.04),
                      letterSpacing: -displaySize * 0.03,
                    },
                  ]}
                >
                  {headline}
                </Text>
              </Reveal>
              {supportText ? (
                <Reveal delay={200}>
                  <Text
                    style={[styles.support, { color: colors.symbioteMuted }]}
                  >
                    {supportText}
                  </Text>
                </Reveal>
              ) : null}
              <View style={styles.spacerBelowHeadline} />
            </>
          ) : (
            <>
              <View style={styles.spacerAboveSection} />
              <Reveal delay={70}>
                <Text
                  accessibilityRole="header"
                  style={[styles.section, { color: colors.symbioteHighlight }]}
                >
                  {headline}
                </Text>
              </Reveal>
              {supportText ? (
                <Reveal delay={130}>
                  <Text
                    style={[styles.support, { color: colors.symbioteMuted }]}
                  >
                    {supportText}
                  </Text>
                </Reveal>
              ) : null}
              <View style={styles.sectionGap} />
            </>
          )}

          <Reveal delay={hero ? 240 : 190}>{children}</Reveal>

          {!hero ? <View style={styles.spacerGrow} /> : null}

          {footer ? (
            <Reveal delay={hero ? 300 : 250} style={styles.footer}>
              {footer}
            </Reveal>
          ) : null}
        </View>
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
    paddingHorizontal: 24,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 480,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flexGrow: 1,
  },
  heroWrap: {
    alignItems: 'center',
  },
  display: {
    fontFamily: 'Inter_700Bold',
    textAlign: 'center',
    marginTop: 22,
  },
  section: {
    fontFamily: 'Inter_700Bold',
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -1,
    textAlign: 'center',
  },
  support: {
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: 12,
  },
  sectionGap: {
    height: 30,
  },
  spacerAboveHero: {
    flexGrow: 0.8,
    minHeight: 10,
  },
  spacerBelowHeadline: {
    flexGrow: 1.2,
    minHeight: 24,
  },
  spacerAboveSection: {
    flexGrow: 0.55,
    minHeight: 26,
  },
  spacerGrow: {
    flexGrow: 1,
    minHeight: 14,
  },
  footer: {
    alignItems: 'center',
    marginTop: 18,
  },
});
