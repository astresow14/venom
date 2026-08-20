import React from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import { Header } from '@/components/Header';
import { useHealthCheck } from '@workspace/api-client-react';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  
  const { data: health, isError } = useHealthCheck();

  const isConnected = !!health && !isError;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header title="SYSTEM PARAMS" showBack />
      
      <ScrollView 
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>CONNECTION STATUS</Text>
          
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="server" size={18} color={isConnected ? colors.primary : colors.destructive} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Neural Uplink</Text>
              </View>
              <Text style={[styles.statusText, { color: isConnected ? colors.primary : colors.destructive }]}>
                {isConnected ? 'ONLINE' : 'OFFLINE'}
              </Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="activity" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Latency</Text>
              </View>
              <Text style={[styles.statusText, { color: colors.mutedForeground }]}>
                {isConnected ? '24ms' : '--'}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>MODEL CONFIGURATION</Text>
          
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="cpu" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Core Reasoning</Text>
              </View>
              <Text style={[styles.statusText, { color: colors.primary }]}>GPT-5.1</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="eye" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Stealth Mode</Text>
              </View>
              <Switch 
                value={true}
                onValueChange={() => {}}
                trackColor={{ false: colors.accent, true: colors.primary }}
                thumbColor={colors.background}
              />
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.rowLeft}>
                <Feather name="database" size={18} color={colors.mutedForeground} />
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Local Persistence</Text>
              </View>
              <Switch 
                value={true}
                onValueChange={() => {}}
                trackColor={{ false: colors.accent, true: colors.primary }}
                thumbColor={colors.background}
              />
            </View>
          </View>
        </View>

        <TouchableOpacity 
          style={[styles.dangerZone, { borderColor: colors.destructive, backgroundColor: colors.card }]}
          activeOpacity={0.7}
        >
          <Feather name="alert-triangle" size={18} color={colors.destructive} />
          <Text style={[styles.dangerText, { color: colors.destructive }]}>PURGE ALL DATA</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  section: { marginBottom: 32 },
  sectionTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 12,
    letterSpacing: 2,
    marginBottom: 12,
    marginLeft: 4,
  },
  card: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowTitle: {
    fontFamily: 'Inter_500Medium',
    fontSize: 15,
  },
  statusText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    letterSpacing: 1,
  },
  divider: {
    height: 1,
    backgroundColor: '#1a241f',
    marginLeft: 46,
  },
  dangerZone: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    padding: 16,
    borderRadius: 8,
    marginTop: 16,
  },
  dangerText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    letterSpacing: 1,
  }
});
