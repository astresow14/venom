import React from 'react';
import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { Hexagon, ArrowRight, Zap, Database, Brain, Workflow } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col selection:bg-foreground selection:text-background">
      <header className="px-6 py-4 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
          <Hexagon className="w-6 h-6 fill-foreground" />
          VENOM
        </div>
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link href="/sign-in" className="hover:text-muted-foreground transition-colors">Sign In</Link>
          <Link href="/sign-up">
            <Button className="font-mono uppercase tracking-wider text-xs">Access Workspace</Button>
          </Link>
        </nav>
      </header>

      <main className="flex-1 flex flex-col">
        {/* Hero Section */}
        <section className="px-6 py-32 flex flex-col items-center justify-center text-center border-b border-border relative overflow-hidden">
          {/* Brutalist geometric decoration */}
          <div className="absolute top-10 left-10 w-32 h-32 border border-border opacity-50 rotate-12 pointer-events-none" aria-hidden="true" />
          <div className="absolute bottom-20 right-20 w-64 h-64 border border-foreground/10 rotate-45 pointer-events-none" aria-hidden="true" />
          
          <h1 className="text-6xl md:text-8xl font-black uppercase tracking-tighter max-w-4xl leading-[0.9]">
            The Living Project <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-foreground to-muted-foreground">Context</span>
          </h1>
          <p className="mt-8 text-xl text-muted-foreground max-w-2xl font-mono">
            A desktop companion to your mobile AI workspace. Converse with your context and let Venom synthesize your knowledge automatically.
          </p>
          <div className="mt-12 flex items-center gap-4">
            <Link href="/sign-up">
              <Button size="lg" className="h-14 px-8 text-lg font-bold">
                Open Venom <ArrowRight className="ml-2 w-5 h-5" aria-hidden="true" />
              </Button>
            </Link>
          </div>
        </section>

        {/* Features Matrix */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-b border-border">
          <div className="p-10 border-b md:border-b-0 md:border-r border-border flex flex-col items-start hover:bg-muted/50 transition-colors">
            <Zap className="w-8 h-8 mb-6" aria-hidden="true" />
            <h3 className="text-xl font-bold mb-3">Live Feed</h3>
            <p className="text-muted-foreground font-mono text-sm leading-relaxed">
              Real-time activity stream of your conversations, tasks, and knowledge extraction. Never lose track of recent changes.
            </p>
          </div>
          <div className="p-10 border-b md:border-b-0 md:border-r border-border flex flex-col items-start hover:bg-muted/50 transition-colors">
            <Brain className="w-8 h-8 mb-6" aria-hidden="true" />
            <h3 className="text-xl font-bold mb-3">Knowledge Brain</h3>
            <p className="text-muted-foreground font-mono text-sm leading-relaxed">
              Auto-extracted insights map your mental model into an interactive ontology of connected concepts and sources.
            </p>
          </div>
          <div className="p-10 border-b lg:border-b-0 lg:border-r border-border flex flex-col items-start hover:bg-muted/50 transition-colors">
            <Database className="w-8 h-8 mb-6" aria-hidden="true" />
            <h3 className="text-xl font-bold mb-3">Continuous Context</h3>
            <p className="text-muted-foreground font-mono text-sm leading-relaxed">
              Cross-device synchronization ensures your desktop workspace always reflects your latest mobile interactions.
            </p>
          </div>
          <div className="p-10 flex flex-col items-start hover:bg-muted/50 transition-colors">
            <Workflow className="w-8 h-8 mb-6" aria-hidden="true" />
            <h3 className="text-xl font-bold mb-3">Project Tasks</h3>
            <p className="text-muted-foreground font-mono text-sm leading-relaxed">
              A practical board for tracking work inside the project context you already share with Venom mobile.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 py-24 flex flex-col items-center justify-center text-center bg-foreground text-background">
          <h2 className="text-4xl md:text-5xl font-black uppercase tracking-tight mb-8">
            Stop Searching. Start Working.
          </h2>
          <Link href="/sign-up">
            <Button variant="outline" size="lg" className="h-14 px-8 text-lg font-bold bg-background text-foreground border-transparent hover:bg-background/90 hover:text-foreground">
              Open Your Workspace
            </Button>
          </Link>
        </section>
      </main>
      
      <footer className="px-6 py-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-mono text-muted-foreground">
        <div>&copy; {new Date().getFullYear()} Venom · Desktop workspace</div>
      </footer>
    </div>
  );
}
