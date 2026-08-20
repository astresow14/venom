import React, { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useRouter } from 'expo-router';
import { fetch } from 'expo/fetch';
import * as Haptics from 'expo-haptics';
import Animated, { FadeIn, FadeInUp, FadeInDown, Layout } from 'react-native-reanimated';

import { useColors } from '@/hooks/useColors';
import { useVenom, Message } from '@/context/VenomContext';
import { Header } from '@/components/Header';

let messageCounter = 0;
function generateUniqueId(): string {
  messageCounter++;
  return `msg-${Date.now()}-${messageCounter}-${Math.random().toString(36).substr(2, 9)}`;
}

export default function ChatScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { state, isReady, addMessage, setActiveConversation, createNewConversation } = useVenom();
  
  const [text, setText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [localStreamingMessage, setLocalStreamingMessage] = useState<Message | null>(null);
  
  const inputRef = useRef<TextInput>(null);
  const initializedRef = useRef(false);

  const activeConv = state.conversations.find(c => c.id === state.activeConversationId);
  const activeProject = state.projects.find(p => p.id === state.activeProjectId);
  
  const contextMessages = activeConv?.messages || [];
  
  // Combine context messages with the active streaming one
  const displayMessages = localStreamingMessage 
    ? [...contextMessages, localStreamingMessage] 
    : contextMessages;

  const reversedMessages = [...displayMessages].reverse();

  useEffect(() => {
    if (isReady && !state.activeConversationId && !initializedRef.current) {
      initializedRef.current = true;
      const newId = createNewConversation(state.activeProjectId);
      setActiveConversation(newId);
    }
  }, [isReady, state.activeConversationId]);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setText('');
    
    // Create new conv if none exists somehow
    let targetConvId = state.activeConversationId;
    if (!targetConvId) {
      targetConvId = createNewConversation(state.activeProjectId);
      setActiveConversation(targetConvId);
    }

    // Add User Message to context
    addMessage(targetConvId, {
      role: 'user',
      content: trimmed,
      status: 'sent'
    });
    
    setIsStreaming(true);
    setShowTyping(true);

    let fullContent = '';
    let hasReceivedFirstChunk = false;
    let streamId = generateUniqueId();

    try {
      const baseUrl = `https://${process.env.EXPO_PUBLIC_DOMAIN}`;
      const chatHistory = [
        ...contextMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: trimmed },
      ];

      const response = await fetch(`${baseUrl}/api/venom/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({ 
          messages: chatHistory, 
          projectContext: activeProject ? `Project: ${activeProject.name}\n${activeProject.description}` : undefined 
        }),
      });

      if (!response.ok) throw new Error('Network error');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          if (data.includes('"done":true')) continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.content) {
              fullContent += parsed.content;

              if (!hasReceivedFirstChunk) {
                setShowTyping(false);
                hasReceivedFirstChunk = true;
              }
              
              // Update local streaming message
              setLocalStreamingMessage({
                id: streamId,
                role: 'assistant',
                content: fullContent,
                createdAt: Date.now(),
                status: 'sending'
              });
            }
          } catch (e) {}
        }
      }
    } catch (error) {
      console.error(error);
      setShowTyping(false);
      setLocalStreamingMessage({
        id: streamId,
        role: 'assistant',
        content: 'Connection lost. Signal disrupted.',
        createdAt: Date.now(),
        status: 'error'
      });
      fullContent = 'Connection lost. Signal disrupted.';
    } finally {
      setIsStreaming(false);
      setShowTyping(false);
      
      // Commit local stream to context
      if (fullContent) {
        addMessage(targetConvId, {
          role: 'assistant',
          content: fullContent,
          status: 'sent'
        });
      }
      setLocalStreamingMessage(null);
      
      // Keep keyboard open
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.role === 'user';
    return (
      <Animated.View 
        layout={Layout.springify()}
        entering={FadeInDown.springify()}
        style={[styles.messageRow, isUser ? styles.messageUser : styles.messageAssistant]}
      >
        <View style={[
          styles.messageBubble, 
          isUser ? [styles.bubbleUser, { backgroundColor: colors.accent }] : styles.bubbleAssistant,
          item.status === 'error' && { borderColor: colors.destructive, borderWidth: 1 }
        ]}>
          <Text style={[
            styles.messageText, 
            isUser ? { color: colors.foreground } : { color: colors.primary }
          ]}>
            {item.content}
          </Text>
        </View>
      </Animated.View>
    );
  };

  return (
    <KeyboardAvoidingView style={[styles.container, { backgroundColor: colors.background }]} behavior="padding" keyboardVerticalOffset={0}>
      <Header 
        title={activeProject ? activeProject.name : 'GLOBAL WORKSPACE'}
        subtitle={activeProject ? 'ACTIVE PROJECT' : 'UNCATEGORIZED'}
        leftIcon="layers"
        onLeftPress={() => router.push('/projects')}
        rightIcon="sliders"
        onRightPress={() => router.push('/settings')}
        rightIcon2="database"
        onRight2Press={() => router.push('/knowledge')}
      />
      
      <FlatList
        data={reversedMessages}
        keyExtractor={item => item.id}
        renderItem={renderMessage}
        inverted={reversedMessages.length > 0}
        contentContainerStyle={styles.listContent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          showTyping ? (
            <Animated.View entering={FadeIn} style={styles.typingContainer}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.typingText, { color: colors.primary }]}>Receiving signal...</Text>
            </Animated.View>
          ) : null
        }
        ListEmptyComponent={
          !isStreaming && reversedMessages.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Feather name="cpu" size={48} color={colors.primary} style={{ opacity: 0.5, marginBottom: 16 }} />
              <Text style={[styles.emptyText, { color: colors.primary }]}>SYSTEM READY.</Text>
              <Text style={[styles.emptySubtext, { color: colors.mutedForeground }]}>Initiate tactical link.</Text>
            </View>
          ) : null
        }
      />
      
      <View style={[styles.inputContainer, { paddingBottom: Math.max(insets.bottom, 16), backgroundColor: colors.background, borderTopColor: colors.border }]}>
        <View style={[styles.inputWrapper, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: colors.foreground }]}
            placeholder="Awaiting input..."
            placeholderTextColor={colors.mutedForeground}
            value={text}
            onChangeText={setText}
            multiline
            maxLength={1000}
            blurOnSubmit={false}
          />
          <TouchableOpacity 
            style={[
              styles.sendButton, 
              { backgroundColor: text.trim() ? colors.primary : colors.accent }
            ]}
            onPress={handleSend}
            disabled={!text.trim() || isStreaming}
            hitSlop={12}
          >
            <Feather name="arrow-up" size={20} color={text.trim() ? colors.primaryForeground : colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
  },
  messageRow: {
    marginBottom: 16,
    flexDirection: 'row',
  },
  messageUser: {
    justifyContent: 'flex-end',
  },
  messageAssistant: {
    justifyContent: 'flex-start',
  },
  messageBubble: {
    maxWidth: '85%',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bubbleUser: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 4,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  bubbleAssistant: {
    borderTopLeftRadius: 4,
    borderTopRightRadius: 16,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#1a241f',
  },
  messageText: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    lineHeight: 22,
  },
  typingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 16,
  },
  typingText: {
    marginLeft: 8,
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
  },
  emptyText: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    letterSpacing: 2,
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
  inputContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    borderRadius: 24,
    paddingLeft: 16,
    paddingRight: 8,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 24,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    paddingTop: 4,
  },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    marginBottom: 2,
  }
});
