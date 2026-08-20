import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function ScreenWrapper({ children, withBottomInset = true, style }: { children: React.ReactNode, withBottomInset?: boolean, style?: any }) {
  const insets = useSafeAreaInsets();
  
  return (
    <View style={[
      styles.container,
      { paddingBottom: withBottomInset ? insets.bottom : 0 },
      style
    ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050908',
  }
});
