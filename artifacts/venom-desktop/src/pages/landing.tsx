import React, { useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { VenomMark } from "@/components/venom-mark";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { stashPendingPrompt } from "@/lib/pending-prompt";
import { motion } from "framer-motion";

const prompts = [
  "Summarise where my project stands",
  "What did I decide last week?",
  "Draft the next steps for launch",
];

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const start = (prompt: string) => {
    if (!prompt.trim()) return;
    stashPendingPrompt(prompt);
    setLocation("/sign-in");
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    start(value);
  };

  const useSuggestion = (prompt: string) => {
    setValue(prompt);
    inputRef.current?.focus();
  };

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <VenomMark className="h-5 w-5" />
          Venom
        </span>
        <nav className="flex items-center gap-1.5">
          <Link href="/sign-in">
            <Button
              variant="ghost"
              className="h-9 rounded-full px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Sign in
            </Button>
          </Link>
          <Link href="/sign-up">
            <Button className="h-9 rounded-full px-4 text-sm font-medium">
              Sign up
            </Button>
          </Link>
        </nav>
      </header>

      <main className="flex flex-1 items-center justify-center overflow-y-auto px-5 pb-16">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="flex w-full max-w-2xl flex-col items-center"
        >
          <VenomMark className="h-14 w-14" title="Venom" />
          <h1 className="mt-6 text-2xl font-medium tracking-tight sm:text-[28px]">
            What are you working on?
          </h1>

          <form
            onSubmit={handleSubmit}
            className={cn(
              "mt-8 flex w-full items-end rounded-[1.75rem] border bg-card p-2 transition-colors duration-200",
              isFocused ? "border-foreground/60" : "border-border",
            )}
          >
            <label htmlFor="landing-prompt" className="sr-only">
              Ask Venom
            </label>
            <textarea
              id="landing-prompt"
              ref={inputRef}
              rows={1}
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                event.target.style.height = "auto";
                event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
              }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  start(value);
                }
              }}
              placeholder="Ask Venom anything about your projects"
              className="max-h-40 min-h-[44px] w-full resize-none border-0 bg-transparent px-4 py-3 text-base outline-none placeholder:text-muted-foreground"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!value.trim()}
              aria-label="Send"
              className="mb-0.5 mr-0.5 h-11 w-11 shrink-0 rounded-full"
            >
              <ArrowUp className="h-5 w-5" />
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {prompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => useSuggestion(prompt)}
                className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              >
                {prompt}
              </button>
            ))}
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            Sign in to keep your conversations, tasks, and knowledge in sync.
          </p>
        </motion.div>
      </main>
    </div>
  );
}
