import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useColors } from '@/hooks/useColors';
import { useVenom, Project } from '@/context/VenomContext';
import { Header } from '@/components/Header';

export default function ProjectsScreen() {
  const colors = useColors();
  const router = useRouter();
  const { state, setActiveProject, addProject, deleteProject } = useVenom();
  const insets = useSafeAreaInsets();

  const [isCreating, setIsCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const handleSelect = (id: string) => {
    setActiveProject(id);
    router.back();
  };

  const handleCreate = () => {
    if (!newTitle.trim()) return;
    addProject({
      name: newTitle.trim(),
      description: newDesc.trim() || 'New intelligence container',
      accent: colors.primary,
      sourceCount: 0
    });
    setNewTitle('');
    setNewDesc('');
    setIsCreating(false);
  };

  const renderItem = ({ item }: { item: Project }) => {
    const isActive = state.activeProjectId === item.id;
    return (
      <TouchableOpacity 
        style={[
          styles.projectCard, 
          { backgroundColor: colors.card, borderColor: isActive ? colors.primary : colors.border }
        ]}
        onPress={() => handleSelect(item.id)}
        activeOpacity={0.7}
      >
        <View style={styles.cardHeader}>
          <Text style={[styles.projectName, { color: isActive ? colors.primary : colors.foreground }]}>{item.name}</Text>
          {isActive && <View style={[styles.activeDot, { backgroundColor: colors.primary }]} />}
        </View>
        <Text style={[styles.projectDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
          {item.description}
        </Text>
        <View style={styles.cardFooter}>
          <View style={styles.badge}>
            <Feather name="database" size={12} color={colors.mutedForeground} />
            <Text style={[styles.badgeText, { color: colors.mutedForeground }]}>{item.sourceCount} SOURCES</Text>
          </View>
          <TouchableOpacity onPress={() => deleteProject(item.id)} hitSlop={12}>
            <Feather name="trash-2" size={16} color={colors.destructive} style={{ opacity: 0.7 }} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Header 
        title="PROJECTS"
        showBack
        rightIcon={isCreating ? "x" : "plus"}
        onRightPress={() => setIsCreating(!isCreating)}
      />

      {isCreating ? (
        <View style={[styles.createContainer, { paddingBottom: insets.bottom + 20 }]}>
          <Text style={[styles.sectionTitle, { color: colors.primary }]}>NEW WORKSPACE</Text>
          <TextInput
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card }]}
            placeholder="Project Designation"
            placeholderTextColor={colors.mutedForeground}
            value={newTitle}
            onChangeText={setNewTitle}
            autoFocus
          />
          <TextInput
            style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.card, height: 80 }]}
            placeholder="Operational parameters (Optional)"
            placeholderTextColor={colors.mutedForeground}
            value={newDesc}
            onChangeText={setNewDesc}
            multiline
          />
          <TouchableOpacity 
            style={[styles.createBtn, { backgroundColor: newTitle.trim() ? colors.primary : colors.accent }]}
            onPress={handleCreate}
            disabled={!newTitle.trim()}
          >
            <Text style={[styles.createBtnText, { color: newTitle.trim() ? colors.primaryForeground : colors.mutedForeground }]}>
              INITIALIZE
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={state.projects.sort((a,b) => b.updatedAt - a.updatedAt)}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 20 }]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    padding: 16,
    gap: 16,
  },
  projectCard: {
    borderWidth: 1,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  projectName: {
    fontFamily: 'Inter_600SemiBold',
    fontSize: 16,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  projectDesc: {
    fontFamily: 'Inter_400Regular',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeText: {
    fontFamily: 'Inter_500Medium',
    fontSize: 11,
    letterSpacing: 1,
  },
  createContainer: {
    padding: 16,
  },
  sectionTitle: {
    fontFamily: 'Inter_700Bold',
    fontSize: 12,
    letterSpacing: 2,
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 16,
    fontFamily: 'Inter_400Regular',
    fontSize: 15,
  },
  createBtn: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  createBtnText: {
    fontFamily: 'Inter_700Bold',
    fontSize: 14,
    letterSpacing: 2,
  }
});
