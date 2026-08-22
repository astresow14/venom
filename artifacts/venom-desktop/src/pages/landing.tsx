import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { VenomMark } from "@/components/venom-mark";
import { VenomWordmark } from "@/components/venom-wordmark";
import { VenomWordmarkReveal } from "@/components/venom-wordmark-reveal";
import {
  Activity,
  AudioLines,
  ChevronDown,
  CirclePlus,
  Image,
  PanelLeft,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { stashPendingPrompt } from "@/lib/pending-prompt";
import { motion } from "framer-motion";

/**
 * The living symbiote backdrop carries the whole GL stack, so it stays off
 * the first-paint critical path: the hero renders immediately on plain
 * near-black, the chunk loads on idle, and the canvas fades in once it has
 * drawn. Devices without WebGL simply keep the plain background.
 */
const LandingSlime = lazy(() => import("@/components/landing-slime"));

const sidebarItems = [
  { label: "Search", icon: Search },
  { label: "New chat", icon: SquarePen, active: true },
  { label: "Imagine", icon: Image, indicator: true },
  { label: "Automations", icon: Activity },
  { label: "Skills and Connectors", icon: WandSparkles },
];

export default function LandingPage() {
  const [, setLocation] = useLocation();
  const [value, setValue] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [liveBackdrop, setLiveBackdrop] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Mount the backdrop only after the browser has painted and gone idle:
    // the effect is an enhancement, never a first-paint cost.
    let cancelled = false;
    const arm = () => {
      if (!cancelled) setLiveBackdrop(true);
    };
    if (typeof window.requestIdleCallback === "function") {
      const idle = window.requestIdleCallback(arm, { timeout: 1200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idle);
      };
    }
    const timer = window.setTimeout(arm, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const start = (prompt: string) => {
    if (!prompt.trim()) return;
    stashPendingPrompt(prompt);
    setLocation("/sign-in");
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    start(value);
  };

  return (
    <div className="flex h-[100dvh] bg-[#050505] text-white">
      <aside className="hidden w-[206px] shrink-0 flex-col border-r border-white/[0.08] bg-[#060606] md:flex">
        <div className="flex h-12 items-center justify-between border-b border-white/[0.06] px-4">
          <VenomMark className="h-5 w-5 text-white" title="Venom" />
          <button
            type="button"
            aria-label="Collapse sidebar"
            className="rounded-md p-1 text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        <nav className="space-y-0.5 px-3 py-3" aria-label="Main navigation">
          {sidebarItems.map(({ label, icon: Icon, active, indicator }) => (
            <button
              type="button"
              key={label}
              className={cn(
                "relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
                active && "bg-white/[0.1] text-white",
              )}
            >
              <Icon className="h-4 w-4 shrink-0 text-white/80" strokeWidth={1.8} />
              <span className="whitespace-nowrap">{label}</span>
              {indicator && (
                <span className="ml-auto h-1 w-1 rounded-full bg-violet-400" aria-label="New" />
              )}
            </button>
          ))}
        </nav>

        <div className="px-4 pb-2 pt-3 text-[11px] font-medium text-white/50">
          <span>Projects</span>
          <ChevronDown className="ml-1 inline h-3 w-3" />
        </div>
        <button
          type="button"
          className="mx-3 flex h-8 items-center gap-3 rounded-lg px-2.5 text-left text-[13px] text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <CirclePlus className="h-4 w-4" strokeWidth={1.7} />
          Add project
        </button>

        <div className="px-4 pb-2 pt-5 text-[11px] font-medium text-white/50">
          <span>History</span>
          <ChevronDown className="ml-1 inline h-3 w-3" />
        </div>
        <div className="flex-1 px-3">
          <p className="border-b border-white/[0.06] px-2.5 pb-2 text-[11px] text-white/35">Today</p>
        </div>

        <div className="border-t border-white/[0.08] p-3">
          <Link
            href="/sign-in"
            className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-[12px] text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <Settings2 className="h-4 w-4" />
            Sign in to sync
          </Link>
        </div>
      </aside>

      <div className="relative isolate flex min-w-0 flex-1 flex-col">
        {/* Living backdrop: pointer-inert, behind the pane's own content
            (negative z within the isolated pane), fading in after first
            draw. Without WebGL it stays an empty transparent canvas. */}
        {liveBackdrop && (
          <Suspense fallback={null}>
            <LandingSlime />
          </Suspense>
        )}
        <header className="flex h-12 items-center justify-between border-b border-white/[0.06] px-4 md:px-5">
          <VenomWordmark className="h-6 md:hidden" />
          <span className="hidden md:block" />
          <nav className="flex items-center gap-1">
            <Link href="/sign-in">
              <Button
                variant="ghost"
                data-testid="link-sign-in"
                className="h-8 rounded-md px-3 text-xs font-medium text-white/55 hover:bg-white/[0.07] hover:text-white"
              >
                Sign in
              </Button>
            </Link>
            <Link href="/sign-up">
              <Button
                data-testid="link-sign-up"
                className="h-8 rounded-md bg-white px-3 text-xs font-medium text-black hover:bg-white/90"
              >
                Get started
              </Button>
            </Link>
          </nav>
        </header>

        <main className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 pb-16 md:items-start md:pt-[22vh]">
          <div className="flex w-full max-w-[590px] flex-col items-center">
            <h1 className="sr-only">What are you working on?</h1>
            {/* The tag throws itself on first; the composer rises just after. */}
            <VenomWordmarkReveal className="mb-7 h-24 text-white md:h-28" />

            <motion.form
              onSubmit={handleSubmit}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                "flex w-full items-center rounded-full border border-white/[0.12] bg-[#111111] px-3 py-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.25)] transition-colors duration-200",
                isFocused && "border-white/30",
              )}
            >
              <label htmlFor="landing-prompt" className="sr-only">
                Ask Venom
              </label>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center text-white/75" aria-hidden="true">
                <CirclePlus className="h-5 w-5" strokeWidth={1.8} />
              </span>
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
                placeholder="How can I help you today?"
                className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent px-2 py-2.5 text-sm text-white outline-none placeholder:text-white/40"
              />
              <button
                type="button"
                className="hidden h-10 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:flex"
                aria-label="Choose mode"
              >
                Auto
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="hidden h-10 w-10 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/[0.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:flex"
                aria-label="Voice input"
              >
                <AudioLines className="h-4 w-4" />
              </button>
              <Button
                type="submit"
                size="icon"
                disabled={!value.trim()}
                aria-label="Send"
                className="h-10 w-10 shrink-0 rounded-full bg-white text-black hover:bg-white/90 disabled:bg-white disabled:text-black"
              >
                {value.trim() ? (
                  <Sparkles className="h-4 w-4" />
                ) : (
                  <AudioLines className="h-4 w-4" />
                )}
              </Button>
            </motion.form>
          </div>
        </main>
      </div>
    </div>
  );
}