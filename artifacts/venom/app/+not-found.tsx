import { Link, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { VenomWordmark } from '@/components/VenomWordmark';
import { useColors } from '@/hooks/useColors';

export default function NotFoundScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        style={[
          styles.container,
          {
            backgroundColor: colors.background,
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
          },
        ]}
      >
        <View
          style={[
            styles.card,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <VenomWordmark color={colors.foreground} height={40} />
          <Text style={[styles.title, { color: colors.foreground }]}>
            This page wandered off
          </Text>
          <Text style={[styles.copy, { color: colors.mutedForeground }]}>
            The link may be outdated, but your workspace is still here.
          </Text>
          <Link href="/" asChild>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.link,
                { backgroundColor: colors.primary },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[styles.linkText, { color: colors.primaryForeground }]}
              >
                Return to workspace
              </Text>
            </Pressable>
          </Link>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  card: {
    alignItems: 'center',
    width: '100%',
    maxWidth: 440,
    borderWidth: 1,
    borderRadius: 28,
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    marginTop: 18,
    fontFamily: 'Inter_700Bold',
    fontSize: 25,
    letterSpacing: -0.7,
    textAlign: 'center',
  },
  copy: {
    marginTop: 10,
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  link: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    marginTop: 24,
    paddingHorizontal: 22,
    borderRadius: 16,
  },
  linkText: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 14,
  },
  pressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
});
