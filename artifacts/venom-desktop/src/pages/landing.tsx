import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Database,
  Brain,
  Workflow,
  Hexagon,
  Activity,
} from "lucide-react";
import { motion, type Variants } from "framer-motion";

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.2,
    },
  },
};

const itemVariants: Variants = {
  hidden: { y: 20, opacity: 0 },
  visible: {
    y: 0,
    opacity: 1,
    transition: { type: "spring", stiffness: 100, damping: 20 },
  },
};

export default function LandingPage() {
  return (
    <div className="relative flex h-[100dvh] flex-col overflow-x-hidden overflow-y-auto bg-background text-foreground selection:bg-foreground selection:text-background">
      {/* Living Ink Mass - Glossy Substrate */}
      <div className="fixed inset-0 z-0 flex items-center justify-center overflow-hidden opacity-25 mix-blend-multiply pointer-events-none dark:opacity-20 dark:mix-blend-screen">
        <svg width="0" height="0" className="absolute">
          <filter id="ink-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="25" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 50 -20" result="goo" />
            <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
          </filter>
        </svg>
        <div
          className="relative w-full h-full max-w-[800px] max-h-[800px] flex items-center justify-center"
          style={{ filter: "url(#ink-goo)" }}
        >
          {/* Main body */}
          <div className="absolute w-[400px] h-[400px] bg-foreground rounded-full animate-breathe shadow-[inset_-20px_-20px_40px_rgba(255,255,255,0.1),inset_20px_20px_40px_rgba(255,255,255,0.2)]" />
          {/* Orbiting appendages */}
          <div className="absolute w-[250px] h-[250px] bg-foreground rounded-full animate-[spin_10s_linear_infinite] origin-[250px_50px] shadow-[inset_-10px_-10px_20px_rgba(255,255,255,0.15)]" />
          <div className="absolute w-[200px] h-[200px] bg-foreground rounded-full animate-[spin_14s_linear_infinite_reverse] origin-[-150px_100px] shadow-[inset_15px_15px_30px_rgba(255,255,255,0.1)]" />
          <div className="absolute w-[150px] h-[150px] bg-foreground rounded-full animate-[spin_8s_linear_infinite] origin-[100px_-200px] shadow-[inset_10px_-10px_20px_rgba(255,255,255,0.2)]" />
        </div>
      </div>

      <header className="sticky top-0 z-50 px-6 py-4 flex items-center justify-between border-b border-border/50 bg-background/70 backdrop-blur-xl">
        <div className="flex items-center gap-3 font-black text-xl tracking-tighter uppercase group cursor-pointer">
          <div className="relative flex items-center justify-center w-8 h-8 rounded-[40%_60%_70%_30%/40%_50%_60%_50%] bg-foreground text-background overflow-hidden group-hover:scale-110 transition-transform duration-500 ease-out animate-ink-flow">
             <Hexagon className="w-4 h-4 relative z-10" fill="currentColor" />
          </div>
          Venom
        </div>
        <nav className="flex items-center gap-4 sm:gap-6 text-sm font-medium">
          <Link
            href="/sign-in"
            className="hidden sm:block text-muted-foreground hover:text-foreground transition-colors font-mono uppercase tracking-wider text-xs font-bold"
          >
            Sign In
          </Link>
          <Link href="/sign-up">
            <Button className="font-bold uppercase tracking-wider text-xs rounded-full h-9 px-6 border-2 border-transparent hover:border-foreground/20 hover:bg-transparent hover:text-foreground transition-all">
              Access
            </Button>
          </Link>
        </nav>
      </header>

      <main className="flex-1 flex flex-col">
        {/* Hero Section */}
        <section className="px-6 py-24 sm:py-32 flex flex-col items-center justify-center text-center border-b border-border/50 relative overflow-hidden min-h-[80vh]">
          
          <motion.div
            variants={containerVariants}
            initial="hidden"
            animate="visible"
            className="max-w-5xl mx-auto flex flex-col items-center relative z-10 mix-blend-difference dark:mix-blend-normal text-background dark:text-foreground"
          >
            <motion.div
              variants={itemVariants}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-current/20 text-xs font-mono mb-10 uppercase tracking-widest backdrop-blur-sm"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              Workspace v2.0
            </motion.div>

            <motion.h1
              variants={itemVariants}
              className="text-5xl sm:text-7xl md:text-8xl lg:text-[9rem] font-black uppercase tracking-tighter leading-[0.85] w-full"
            >
              The Living <br className="hidden sm:block" />
              <span className="text-current opacity-60">
                Project Context
              </span>
            </motion.h1>

            <motion.p
              variants={itemVariants}
              className="mt-8 text-lg sm:text-xl opacity-80 max-w-2xl font-mono leading-relaxed"
            >
              A responsive browser workspace for your AI projects. Converse with
              your context across devices and let Venom synthesize your
              knowledge automatically.
            </motion.p>

            <motion.div
              variants={itemVariants}
              className="mt-14 flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto"
            >
              <Link href="/sign-up" className="w-full sm:w-auto">
                <Button
                  size="lg"
                  className="group relative h-16 w-full overflow-hidden rounded-[2rem] rounded-tr-md border-2 border-transparent bg-foreground px-10 text-base font-bold text-background transition-all duration-300 hover:border-foreground hover:bg-background hover:text-foreground sm:w-auto"
                >
                  <span className="relative z-10 flex items-center tracking-widest uppercase">
                    Open Workspace
                    <ArrowRight className="ml-3 w-5 h-5 group-hover:translate-x-1 transition-transform" />
                  </span>
                </Button>
              </Link>
            </motion.div>
          </motion.div>
        </section>

        {/* Features Matrix */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 border-b border-border/50 bg-background/80 backdrop-blur-xl">
          {[
            {
              icon: Activity,
              title: "Live Feed",
              desc: "Real-time activity stream of your conversations, tasks, and knowledge extraction.",
            },
            {
              icon: Brain,
              title: "Knowledge Brain",
              desc: "Auto-extracted insights map your mental model into an interactive ontology.",
            },
            {
              icon: Database,
              title: "Continuous Sync",
              desc: "Cross-device synchronization ensures your desktop always reflects mobile interactions.",
            },
            {
              icon: Workflow,
              title: "Project Tasks",
              desc: "A practical board for tracking work inside the project context shared with Venom mobile.",
            },
          ].map((feature, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-100px" }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
              className="p-8 sm:p-10 border-b lg:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-r last:border-r-0 border-border/50 flex flex-col items-start group hover:bg-foreground hover:text-background transition-colors duration-300"
            >
              <div className="w-12 h-12 rounded-[40%_60%_70%_30%/40%_50%_60%_50%] border-2 border-foreground/20 group-hover:border-background/30 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-300 bg-background group-hover:bg-foreground">
                <feature.icon className="w-5 h-5 text-foreground group-hover:text-background" />
              </div>
              <h3 className="text-xl font-black mb-3 tracking-tighter uppercase">
                {feature.title}
              </h3>
              <p className="text-muted-foreground group-hover:text-background/70 font-mono text-sm leading-relaxed transition-colors">
                {feature.desc}
              </p>
            </motion.div>
          ))}
        </section>

        {/* CTA */}
        <section className="px-6 py-32 flex flex-col items-center justify-center text-center bg-foreground text-background relative overflow-hidden">
          <div className="absolute inset-0 bg-background/5 animate-breathe pointer-events-none" />

          <motion.h2
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="text-4xl md:text-6xl font-black uppercase tracking-tighter mb-10 z-10"
          >
            Stop Searching.
            <br />
            Start Working.
          </motion.h2>
          <Link href="/sign-up" className="z-10">
            <Button
              size="lg"
              className="h-14 px-10 text-lg font-bold bg-background text-foreground hover:bg-background/90 rounded-[2rem] rounded-tl-md transition-transform hover:scale-105 active:scale-95 uppercase tracking-widest border-2 border-background"
            >
              Enter Venom
            </Button>
          </Link>
        </section>
      </main>

      <footer className="px-6 py-8 border-t border-border/50 flex flex-col md:flex-row items-center justify-center gap-4 text-xs font-mono text-muted-foreground bg-background">
        <div className="uppercase tracking-widest font-bold">&copy; {new Date().getFullYear()} Venom Protocol</div>
      </footer>
    </div>
  );
}