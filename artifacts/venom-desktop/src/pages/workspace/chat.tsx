import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  extractVenomKnowledge,
  type VenomMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Send,
  Trash2,
  Bot,
  User,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useVenomWorkspace } from "@/context/venom-workspace";
import { useUser } from "@clerk/react";

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

  const [inputValue, setInputValue] = useState("");

  // Local state for the message currently being streamed
  const [streaming, setStreaming] = useState<{
    convId: string;
    id: string;
    content: string;
    status: "sending" | "sent" | "error";
    originalInput?: string; // used for retry
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    messagesEndRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [activeConv?.messages, streaming]);

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
            // The completed chat remains available when background extraction fails.
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
      <div className="flex-1 flex items-center justify-center">
        <Skeleton className="w-64 h-8" />
      </div>
    );
  }

  const messages = activeConv?.messages || [];

  // Combine real messages with streaming message if it belongs to this conversation
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
    <div className="flex-1 flex h-full overflow-hidden relative">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background relative">
        <div className="flex h-14 shrink-0 items-center justify-between px-4 md:px-6">
          <div className="truncate pr-4 text-sm font-medium text-muted-foreground">
            {activeConv?.title || "New chat"}
          </div>
          {activeConvId && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full text-muted-foreground hover:text-destructive"
              onClick={() => {
                if (
                  window.confirm(
                    "Clear every message in this conversation? This cannot be undone.",
                  )
                ) {
                  clearConversation(activeConvId);
                }
              }}
              title="Clear Thread"
              aria-label="Clear Thread"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>

        <div
          className="flex-1 overflow-y-auto px-4 py-6 md:px-8"
          role="log"
          aria-live="polite"
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6">
            {displayMessages.length === 0 ? (
              <div className="flex min-h-full flex-1 flex-col items-center justify-center text-center">
                <div className="mb-5 grid h-12 w-12 place-items-center rounded-2xl bg-muted">
                  <Bot className="h-5 w-5" />
                </div>
                <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                  What can I help with?
                </h1>
              </div>
            ) : (
              displayMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    "flex gap-3 md:gap-4",
                    msg.role === "user"
                      ? "ml-auto flex-row-reverse"
                      : "mr-auto",
                  )}
                >
                  <div
                    className={cn(
                      "shrink-0 w-8 h-8 rounded-full flex items-center justify-center",
                      msg.role === "user"
                        ? "bg-foreground text-background"
                        : "bg-muted",
                    )}
                  >
                    {msg.role === "user" ? (
                      <User className="w-4 h-4" />
                    ) : (
                      <Bot className="w-4 h-4" />
                    )}
                  </div>
                  <div
                    className={cn(
                      "px-4 py-3 text-[15px] leading-7",
                      msg.role === "user"
                        ? "rounded-2xl rounded-tr-md bg-muted text-foreground"
                        : "text-card-foreground",
                    )}
                  >
                    {msg.content}

                    {msg.status === "sending" && (
                      <span
                        className="inline-block ml-2 w-2 h-2 bg-foreground rounded-full animate-pulse"
                        aria-hidden="true"
                      />
                    )}

                    {msg.status === "error" && (
                      <div className="mt-3 p-3 bg-destructive/10 border border-destructive/20 flex flex-col gap-2">
                        <span className="text-xs text-destructive font-mono flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> Failed to
                          transmit.
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[10px] w-fit font-mono"
                          onClick={handleRetry}
                        >
                          <RefreshCw className="w-3 h-3 mr-1" /> Retry
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="px-4 pb-4 pt-2 md:px-8 md:pb-6">
          <form
            onSubmit={handleSend}
            className="relative mx-auto flex max-w-3xl items-center rounded-[26px] border border-border bg-card p-2 shadow-sm transition-shadow focus-within:shadow-md"
          >
            <div className="relative flex-1">
              <label htmlFor="chat-input" className="sr-only">
                Message Venom
              </label>
              <Input
                id="chat-input"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Message Venom…"
                className="h-11 w-full border-0 bg-transparent px-3 text-[15px] shadow-none focus-visible:ring-0"
                disabled={streaming?.status === "sending"}
                autoComplete="off"
              />
            </div>
            <Button
              type="submit"
              disabled={!inputValue.trim() || streaming?.status === "sending"}
              size="icon"
              className="h-10 w-10 shrink-0 rounded-full"
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
          <div className="mt-2 text-center text-[11px] text-muted-foreground">
            Venom can make mistakes.
          </div>
        </div>
      </div>
    </div>
  );
}
