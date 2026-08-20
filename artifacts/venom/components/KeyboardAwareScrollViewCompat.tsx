import React from 'react';
import { ScrollView, ScrollViewProps } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

export function KeyboardAwareScrollViewCompat(props: ScrollViewProps & { bottomOffset?: number }) {
  return (
    <KeyboardAwareScrollView
      {...props}
      bottomOffset={props.bottomOffset || 0}
      keyboardShouldPersistTaps={props.keyboardShouldPersistTaps || 'handled'}
    />
  );
}
