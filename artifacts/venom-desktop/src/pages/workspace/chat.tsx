import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  extractVenomKnowledge,
  type VenomMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Trash2,
  RefreshCw,
  AlertTriangle,
  SendHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { takePendingPrompt } from "@/lib/pending-prompt";
import { VenomMark } from "@/components/venom-mark";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useUser } from "@clerk/react";
import { motion, AnimatePresence } from "framer-motion";

export default function ChatPage() {
  const { user } = useUser();
  const {
    state,
    addMessage,
    createNewConversation,
    setActiveConversation,
    clearConversation,
    applyKnowledgeInsights,
  } = useVenomWorkspace();

  const [inputValue, setInputValue] = useState(takePendingPrompt);
  const [isFocused, setIsFocused] = useState(false);

  // Local state for the message currently being streamed
  const [streaming, setStreaming] = useState<{
    convId: string;
    id: string;
    content: string;
    status: "sending" | "sent" | "error";
    originalInput?: string;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const extractionControllersRef = useRef<Set<AbortController>>(new Set());
  const activeUserIdRef = useRef<string | null>(null);
  const activeConvIdRef = useRef<string | null>(null);

  const activeConvId = state?.activeConversationId;
  const activeConv = state?.conversations?.find((c) => c.id === activeConvId);

  useEffect(() => {
    const nextUserId = user?.id || null;
    if (activeUserIdRef.current && activeUserIdRef.current !== nextUserId) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      extractionControllersRef.current.forEach((controller) =>
        controller.abort(),
      );
      extractionControllersRef.current.clear();
      setStreaming(null);
    }
    activeUserIdRef.current = nextUserId;
  }, [user?.id]);

  useEffect(() => {
    const extractionControllers = extractionControllersRef.current;
    return () => {
      abortControllerRef.current?.abort();
      extractionControllers.forEach((controller) => controller.abort());
      extractionControllers.clear();
    };
  }, []);

  useEffect(() => {
    activeConvIdRef.current = activeConvId || null;
    if (streaming && streaming.convId !== activeConvId) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setStreaming(null);
    }
  }, [activeConvId, streaming]);

  useEffect(() => {
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "end",
      });
    }
  }, [activeConv?.messages?.length, streaming?.content]);

  const handleFetchStream = useCallback(
    async (
      convId: string,
      userId: string,
      messagesContext: VenomMessage[],
      projectContext?: string,
      originalInput?: string,
    ) => {
      const streamId = `msg_${crypto.randomUUID()}`;
      setStreaming({
        convId,
        id: streamId,
        content: "",
        status: "sending",
        originalInput,
      });

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const response = await fetch("/api/venom/respond", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          credentials: "include",
          body: JSON.stringify({
            messages: messagesContext.slice(-24).map((message) => ({
              role: message.role,
              content: message.content,
            })),
            projectContext: projectContext?.slice(0, 1000),
          }),
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        let buffer = "";
        let receivedDone = false;

        const consumeEvent = (event: string) => {
          const dataString = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();
          if (!dataString || dataString === "[DONE]") return;

          const data = JSON.parse(dataString) as {
            content?: string;
            done?: boolean;
            error?: string;
          };
          if (data.error) throw new Error(data.error);
          if (data.done) {
            receivedDone = true;
            return;
          }
          if (data.content) {
            fullContent += data.content;
            setStreaming((current) =>
              current?.id === streamId
                ? { ...current, content: fullContent }
                : current,
            );
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (
            activeUserIdRef.current !== userId ||
            activeConvIdRef.current !== convId
          ) {
            await reader.cancel();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            consumeEvent(event);
          }
        }

        buffer += decoder.decode();
        if (buffer.trim()) consumeEvent(buffer);
        if (!receivedDone || !fullContent.trim()) {
          throw new Error("The response stream ended before completion.");
        }

        if (
          activeUserIdRef.current !== userId ||
          activeConvIdRef.current !== convId
        ) {
          return;
        }

        addMessage(convId, {
          id: streamId,
          role: "assistant",
          content: fullContent,
          status: "sent",
        });
        setStreaming(null);
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }

        const conv = state.conversations.find((item) => item.id === convId);
        if (conv) {
          const conversationTitle =
            conv.title === "New Session" && originalInput
              ? `${originalInput.slice(0, 30)}${originalInput.length > 30 ? "…" : ""}`
              : conv.title || "New Session";

          const extractionController = new AbortController();
          extractionControllersRef.current.add(extractionController);
          try {
            const result = await extractVenomKnowledge(
              {
                conversation: {
                  id: convId,
                  title: conversationTitle,
                  projectId: conv.projectId,
                },
                messages: [
                  ...messagesContext.slice(-47).map((message) => ({
                    id: message.id,
                    role: message.role,
                    content: message.content.slice(0, 8000),
                  })),
                  {
                    id: streamId,
                    role: "assistant",
                    content: fullContent.slice(0, 8000),
                  },
                ],
              },
              { signal: extractionController.signal },
            );

            if (activeUserIdRef.current === userId) {
              applyKnowledgeInsights(
                {
                  id: convId,
                  title: conversationTitle,
                  projectId: conv.projectId,
                },
                result.clusters,
              );
            }
          } catch {
            // Background extraction fails silently
          } finally {
            extractionControllersRef.current.delete(extractionController);
          }
        }
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (
          activeUserIdRef.current === userId &&
          activeConvIdRef.current === convId
        ) {
          setStreaming((current) =>
            current?.id === streamId
              ? { ...current, status: "error" }
              : current,
          );
        }
      } finally {
        if (abortControllerRef.current === abortController) {
          abortControllerRef.current = null;
        }
      }
    },
    [addMessage, applyKnowledgeInsights, state.conversations],
  );

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!inputValue.trim() || !activeConvId || !user?.id) return;

    const input = inputValue.trim();
    setInputValue("");

    const userMessageId = `msg_${crypto.randomUUID()}`;
    addMessage(activeConvId, {
      id: userMessageId,
      role: "user",
      content: input,
      status: "sent",
    });

    const activeProject = state?.projects?.find(
      (p) => p.id === activeConv?.projectId,
    );
    const contextMessages = [
      ...(activeConv?.messages || []),
      {
        id: userMessageId,
        role: "user" as const,
        content: input,
        status: "sent" as const,
        createdAt: Date.now(),
      },
    ];

    const projectContext = activeProject
      ? `Project: ${activeProject.name}\n${activeProject.description}`
      : undefined;
    void handleFetchStream(
      activeConvId,
      user.id,
      contextMessages,
      projectContext,
      input,
    );
  };

  const handleRetry = () => {
    if (!streaming?.originalInput || !activeConvId || !user?.id) return;

    const activeProject = state?.projects?.find(
      (p) => p.id === activeConv?.projectId,
    );
    const projectContext = activeProject
      ? `Project: ${activeProject.name}\n${activeProject.description}`
      : undefined;
    void handleFetchStream(
      activeConvId,
      user.id,
      activeConv?.messages || [],
      projectContext,
      streaming.originalInput,
    );
  };

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center h-full bg-background">
        <Skeleton className="w-[300px] h-12 rounded-2xl bg-foreground/10" />
      </div>
    );
  }

  const messages = activeConv?.messages || [];
  const displayMessages = [...messages];
  if (streaming && streaming.convId === activeConvId) {
    displayMessages.push({
      id: streaming.id,
      role: "assistant",
      content: streaming.content,
      createdAt: Date.now(),
      status: streaming.status,
    });
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-background relative z-0">
      {/* Top Bar for Desktop */}
      <div className="hidden md:flex h-16 shrink-0 items-center justify-between px-8 border-b border-border/40 bg-background/80 backdrop-blur-md z-10 sticky top-0">
        <div className="truncate pr-4 text-sm font-bold tracking-widest text-muted-foreground">
          {activeConv?.title || "New chat"}
        </div>
        {activeConvId && messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 rounded-2xl text-muted-foreground hover:text-background hover:bg-foreground font-bold tracking-widest text-[11px] transition-colors border-2 border-transparent hover:border-foreground"
            onClick={() => {
              if (window.confirm("Clear this thread? This cannot be undone.")) {
                clearConversation(activeConvId);
              }
            }}
            title="Clear Thread"
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" /> Clear
          </Button>
        )}
      </div>

      {/* Mobile Top Bar */}
      <div className="md:hidden absolute top-0 right-4 h-16 flex items-center z-40">
        {activeConvId && messages.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 rounded-full text-muted-foreground hover:text-background hover:bg-foreground border border-transparent"
            onClick={() => {
              if (window.confirm("Clear this thread?")) {
                clearConversation(activeConvId);
              }
            }}
            aria-label="Clear Thread"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Messages Area */}
      <div
        ref={scrollContainerRef}
        className={cn(
          "flex-1 overflow-y-auto px-4 pb-36 md:px-12 md:pb-40 md:pt-10 scroll-smooth",
          activeConvId && messages.length > 0 ? "pt-20" : "pt-10",
        )}
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 md:gap-10 min-h-full">
          {displayMessages.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 200, damping: 20 }}
              className="flex flex-1 flex-col items-center justify-center text-center pb-24"
            >
              <VenomMark className="mb-6 h-14 w-14" title="Venom" />
              <h1 className="mb-3 text-2xl font-medium tracking-tight sm:text-[28px]">
                How can I help?
              </h1>
              <p className="max-w-md text-sm text-muted-foreground">
                Project context is automatically included in this thread.
              </p>
            </motion.div>
          ) : (
            <AnimatePresence initial={false}>
              {displayMessages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 20, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 25 }}
                  className={cn(
                    "flex flex-col w-full group",
                    msg.role === "user" ? "items-end" : "items-start",
                  )}
                >
                  <div className={cn(
                    "text-[10px] font-bold font-mono tracking-widest mb-1.5 opacity-50 flex items-center gap-2",
                    msg.role === "user" ? "flex-row-reverse" : "flex-row"
                  )}>
                    {msg.role === "user" ? "You" : "Venom"}
                  </div>
                  <div
                    className={cn(
                      "relative text-[15px] leading-relaxed max-w-[90%] md:max-w-[85%] px-6 py-4 transition-all hover:scale-[1.01]",
                      msg.role === "user"
                        ? "bg-foreground text-background font-medium"
                        : "bg-muted/50 text-foreground prose prose-neutral dark:prose-invert prose-p:leading-relaxed prose-pre:bg-muted prose-pre:border prose-pre:border-border prose-pre:rounded-2xl",
                    )}
                    style={{
                      borderRadius:
                        msg.role === "user"
                          ? "24px 24px 4px 24px"
                          : "4px 24px 24px 24px",
                    }}
                  >
                    {msg.content ||
                      (msg.status === "sending" ? (
                        <span className="opacity-50 animate-pulse font-mono text-[11px]">Thinking...</span>
                      ) : (
                        ""
                      ))}

                    {msg.status === "sending" && msg.role === "assistant" && msg.content && (
                      <span
                        className="inline-block ml-1 w-2 h-4 bg-foreground rounded-full align-middle animate-pulse"
                        aria-hidden="true"
                      />
                    )}

                    {msg.status === "error" && (
                      <div className="mt-4 p-4 bg-destructive/10 flex flex-col gap-4 rounded-2xl">
                        <span className="text-sm text-destructive font-bold tracking-widest flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4" /> Connection lost
                        </span>
                        <Button
                          size="sm"
                          className="w-fit rounded-full font-bold tracking-widest text-xs hover:bg-destructive hover:text-destructive-foreground transition-all"
                          onClick={handleRetry}
                        >
                          <RefreshCw className="w-3.5 h-3.5 mr-2" /> Retry
                        </Button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          )}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      </div>

      {/* Composer Area - Fixed to bottom */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 p-4 md:p-8 bg-gradient-to-t from-background via-background to-transparent pt-12 z-20",
          isFocused
            ? "pb-4 md:pb-8"
            : "pb-[env(safe-area-inset-bottom,16px)] md:pb-8",
        )}
      >
        <form
          onSubmit={handleSend}
          className={cn(
            "relative mx-auto flex max-w-4xl items-end bg-card transition-all duration-300 border-2 rounded-[2rem]",
            isFocused
              ? "border-foreground shadow-lg"
              : "border-border shadow-sm",
            "p-2"
          )}
        >
          <div className="relative flex-1 min-h-[48px]">
            <label htmlFor="chat-input" className="sr-only">
              Message Venom
            </label>
            <textarea
              id="chat-input"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(e);
                }
              }}
              placeholder="Message Venom..."
              className="w-full resize-none border-0 bg-transparent px-5 py-3.5 text-[16px] md:text-[15px] shadow-none outline-none max-h-[200px] scrollbar-none placeholder:text-muted-foreground"
              rows={1}
              disabled={streaming?.status === "sending"}
            />
          </div>
          <Button
            type="submit"
            disabled={!inputValue.trim() || streaming?.status === "sending"}
            size="icon"
            className={cn(
              "h-12 w-12 shrink-0 rounded-[1.5rem] mb-1 mr-1 transition-all",
              inputValue.trim()
                ? "bg-foreground text-background hover:scale-105 active:scale-95"
                : "bg-muted text-muted-foreground"
            )}
            aria-label="Send message"
          >
            <SendHorizontal className="h-5 w-5" />
          </Button>
        </form>
      </div>
    </div>
  );
}