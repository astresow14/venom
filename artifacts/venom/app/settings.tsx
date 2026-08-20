import React from 'react';
import { View, Text, StyleSheet, ScrollView, Switch, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useClerk, useUser } from '@clerk/expo';
import { useRouter } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { Header } from '@/components/Header';
import { useVenom } from '@/context/VenomContext';
import { useHealthCheck } from '@workspace/api-client-react';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { syncStatus, lastSyncedAt } = useVenom();
  
  const { data: health, isError } = useHealthCheck();

  const isConnected = !!health && !isError;
  const syncLabels = {
    loading: 'RESTORING',
    pending: 'ACTION NEEDED',
    syncing: 'SYNCING',
    synced: 'SYNCED',
    offline: 'OFFLINE',
    too_large: 'TOO LARGE',
    error: 'RETRY NEEDED',
  } as const;
  const isSyncHealthy = syncStatus === 'synced' || syncStatus === 'syncing';
  const accountLabel =
    user?.primaryEmailAddress?.emailAddress ?? 'Authenticated account';

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in' as never);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header title="SYSTEM PARAMS" showBack />
      
      <ScrollView 
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>SECURE ACCOUNT</Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.accountRow}>
              <View style={[styles.avatar, { backgroundColor: colors.accent, borderColor: colors.border }]}>
                <Feather name="user" size={18} color={colors.primary} />
              </View>
              <View style={styles.accountCopy}>
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Signed in</Text>
                <Text style={[styles.accountEmail, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {accountLabel}
                </Text>
              </View>
            </View>
          </View>
        </View>

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
                <Text style={[styles.rowTitle, { color: colors.foreground }]}>Cloud Workspace</Text>
              </View>
              <View style={styles.syncCopy}>
                <Text
                  testID="cloud-sync-status"
                  style={[
                    styles.statusText,
                    { color: isSyncHealthy ? colors.primary : colors.destructive },
                  ]}
                >
                  {syncLabels[syncStatus]}
                </Text>
                {lastSyncedAt ? (
                  <Text style={[styles.syncTime, { color: colors.mutedForeground }]}>
                    {new Date(lastSyncedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                ) : null}
              </View>
            </View>
          </View>
        </View>

        <TouchableOpacity
          testID="sign-out"
          style={[styles.signOut, { borderColor: colors.border, backgroundColor: colors.card }]}
          activeOpacity={0.7}
          onPress={handleSignOut}
        >
          <Feather name="log-out" size={18} color={colors.foreground} />
          <Text style={[styles.signOutText, { color: colors.foreground }]}>SIGN OUT</Text>
        </TouchableOpacity>

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
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  avatar: {
    width: 42,
    height: 42,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  accountCopy: {
    flex: 1,
  },
  accountEmail: {
    fontFamily: 'Inter_400Regular',
    fontSize: 12,
    marginTop: 4,
  },
  syncCopy: {
    alignItems: 'flex-end',
  },
  syncTime: {
    fontFamily: 'Inter_400Regular',
    fontSize: 10,
    marginTop: 3,
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
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    padding: 16,
  },
  signOutText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    letterSpacing: 1,
  },
  dangerText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 13,
    letterSpacing: 1,
  }
});
