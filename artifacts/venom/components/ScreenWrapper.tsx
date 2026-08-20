import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';

export function ScreenWrapper({ children, withBottomInset = true, style }: { children: React.ReactNode, withBottomInset?: boolean, style?: any }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  
  return (
    <View style={[
      styles.container,
      {
        paddingBottom: withBottomInset ? insets.bottom : 0,
        backgroundColor: colors.background,
      },
      style
    ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  }
});
