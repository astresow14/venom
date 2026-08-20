import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { VenomMark } from '@/components/VenomMark';

type HeaderProps = {
  title?: string;
  subtitle?: string;
  leftIcon?: keyof typeof Feather.glyphMap;
  onLeftPress?: () => void;
  rightIcon?: keyof typeof Feather.glyphMap;
  onRightPress?: () => void;
  rightAccessibilityLabel?: string;
  rightIcon2?: keyof typeof Feather.glyphMap;
  onRight2Press?: () => void;
  style?: StyleProp<ViewStyle>;
  showBack?: boolean;
};

function iconActionLabel(icon: keyof typeof Feather.glyphMap) {
  const labels: Partial<Record<keyof typeof Feather.glyphMap, string>> = {
    menu: 'Open navigation',
    settings: 'Open settings',
    search: 'Search',
    plus: 'Add',
    edit: 'Edit',
    'more-horizontal': 'More options',
    x: 'Close',
  };
  return labels[icon] ?? 'Header action';
}
export function Header({
  title,
  subtitle,
  leftIcon,
  onLeftPress,
  rightIcon,
  onRightPress,
  rightAccessibilityLabel,
  rightIcon2,
  onRight2Press,
  style,
  showBack = false
}: HeaderProps) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const router = useRouter();

  const handleLeftPress = () => {
    if (showBack) {
      router.back();
    } else if (onLeftPress) {
      onLeftPress();
    }
  };

  const activeLeftIcon = showBack ? 'chevron-left' : leftIcon;

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: colors.background,
          borderBottomColor: colors.border,
        },
        style,
      ]}
    >
      <View style={styles.content}>
        <View style={styles.side}>
          {activeLeftIcon && (
            <TouchableOpacity
              onPress={handleLeftPress}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={
                showBack ? 'Go back' : iconActionLabel(activeLeftIcon)
              }
              hitSlop={12}
            >
              <Feather name={activeLeftIcon} size={22} color={colors.foreground} />
            </TouchableOpacity>
          )}
        </View>
        
        <View style={styles.center}>
          {title && (
            <View style={styles.titleRow}>
              <VenomMark color={colors.foreground} size={18} />
              <Text style={[styles.title, { color: colors.foreground }]}>
                {title}
              </Text>
            </View>
          )}
          {subtitle && <Text style={[styles.subtitle, { color: colors.primary }]}>{subtitle}</Text>}
        </View>

        <View style={[styles.side, styles.rightSide]}>
          {rightIcon2 && (
            <TouchableOpacity
              onPress={onRight2Press}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={iconActionLabel(rightIcon2)}
              hitSlop={12}
            >
              <Feather name={rightIcon2} size={20} color={colors.foreground} />
            </TouchableOpacity>
          )}
          {rightIcon && (
            <TouchableOpacity
              onPress={onRightPress}
              style={[styles.iconButton, { marginLeft: 4 }]}
              accessibilityRole="button"
              accessibilityLabel={rightAccessibilityLabel ?? iconActionLabel(rightIcon)}
              hitSlop={12}
            >
              <Feather name={rightIcon} size={20} color={colors.foreground} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
  },
  content: {
    height: 62,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  side: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  rightSide: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  center: {
    flex: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  title: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 17,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontFamily: 'Inter_500Medium',
    fontSize: 12,
    marginTop: 2,
    letterSpacing: 0,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  }
});
