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
import { VENOM_WORDMARK_RATIO } from '@/components/VenomWordmark';
import { VenomWordmarkReveal } from '@/components/VenomWordmarkReveal';
import { useColors } from '@/hooks/useColors';

type AuthScreenShellProps = {
  /**
   * Identity of the current step ('welcome' | 'email' | 'verify' | ...).
   * Changing it replays the staggered reveal for the new step's content.
   */
  stateKey: string;
  /**
   * Welcome treatment mirroring the web landing hero: the large scrawled
   * VENOM wordmark tags itself on as the sole centerpiece over the living
   * backdrop, and the small brand row is dropped on this step so the mark
   * is never drawn twice. The headline still renders — screen-reader-only —
   * because the tag itself becomes the visible headline.
   */
  heroWordmark?: boolean;
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
 * Open, card-free auth layout on the living backdrop. Two arrangements:
 * the wordmark-hero welcome (large VENOM tag reveal, actions rising just
 * after — the mobile mirror of the web landing) and the standard form step
 * (small brand row up top, section headline, then the caller's stack).
 */
export function AuthScreenShell({
  stateKey,
  heroWordmark = false,
  headline,
  supportText,
  children,
  footer,
}: AuthScreenShellProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { onPointerMove, onTouchEnd, onTouchMove, pointerX, pointerY } =
    useSymbioteInteraction();
  const topInset = Platform.OS === 'web' ? Math.max(insets.top, 67) : insets.top;
  const bottomInset =
    Platform.OS === 'web' ? Math.max(insets.bottom, 34) : insets.bottom;

  // Hero tag sized like the web landing's (h-24/md:h-28): as wide as the
  // content column allows, capped so short viewports keep room for the
  // actions rising in underneath.
  const heroWordmarkHeight = Math.round(
    Math.min(
      Math.max((Math.min(width, 480) - 48) / VENOM_WORDMARK_RATIO, 56),
      height * 0.17,
      116,
    ),
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
        {/* The brand row tags itself on (one-time wipe) instead of fading.
            The wordmark-hero step drops it — the hero IS the brand moment. */}
        {!heroWordmark ? (
          <View style={styles.brand}>
            <VenomWordmarkReveal color={colors.symbioteHighlight} height={32} />
          </View>
        ) : null}

        <View key={stateKey} style={styles.body}>
          {heroWordmark ? (
            <>
              <View style={styles.spacerAboveHero} />
              {/* The tag throws itself on first (the wipe is its entrance —
                  no extra fade), then the actions rise in just after. */}
              <View style={styles.heroWrap}>
                <Text accessibilityRole="header" style={styles.srOnlyHeading}>
                  {headline}
                </Text>
                <VenomWordmarkReveal
                  color={colors.symbioteHighlight}
                  height={heroWordmarkHeight}
                />
              </View>
              {supportText ? (
                <Reveal delay={200}>
                  <Text
                    style={[styles.support, { color: colors.symbioteMuted }]}
                  >
                    {supportText}
                  </Text>
                </Reveal>
              ) : null}
              <View style={styles.spacerBelowHero} />
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

          <Reveal delay={heroWordmark ? 260 : 190}>{children}</Reveal>

          {!heroWordmark ? <View style={styles.spacerGrow} /> : null}

          {footer ? (
            <Reveal delay={heroWordmark ? 340 : 250} style={styles.footer}>
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
  /**
   * Visually hidden, screen-reader-accessible heading: 1x1 clipped box,
   * transparent glyphs. Keeps a real heading in the a11y tree while the
   * scrawled tag carries the visible hero.
   */
  srOnlyHeading: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden',
    color: 'transparent',
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
  spacerBelowHero: {
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
