"use client";

import { motion } from "framer-motion";
import BatonPassScene from "./BatonPassScene";
import TypingCommand from "./TypingCommand";
import { REPO_URL, DOCS_URL, AGENTS } from "./site";

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: 0.08 * i, ease: [0.21, 0.6, 0.35, 1] as const },
  }),
};

export default function Hero() {
  return (
    <section
      id="top"
      className="relative mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-36 md:pt-44 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:pb-28"
      aria-labelledby="hero-heading"
    >
      <div>
        <motion.p
          custom={0}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="eyebrow mb-6"
        >
          {"// pass the baton"}
        </motion.p>

        <motion.h1
          id="hero-heading"
          custom={1}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="text-display text-balance text-4xl sm:text-5xl lg:text-6xl"
        >
          Plan on your <span className="amber-gradient">expensive</span> agent.
          <br />
          Pass the baton to your <span className="text-muted">cheap</span> one.
        </motion.h1>

        <motion.p
          custom={2}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-7 max-w-xl text-pretty text-lg leading-relaxed text-muted"
        >
          Baton coordinates multiple AI coding agents — Claude Code, Cursor,
          Codex, Gemini — on one repo. Isolated git worktrees, a live dashboard,
          shared memory, installable skills, and one-file session handoff.{" "}
          <span className="text-fg">One file. No server lock-in. Open source.</span>
        </motion.p>

        <motion.div
          custom={3}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-9 flex flex-wrap items-center gap-3"
        >
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="glow-amber rounded-full bg-amber px-6 py-3 text-sm font-semibold text-black transition-transform hover:scale-[1.02]"
          >
            Star on GitHub
          </a>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-fg transition-colors hover:bg-white/5"
          >
            Read the docs
          </a>
        </motion.div>

        <motion.div
          custom={4}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-8"
        >
          <TypingCommand text="baton pass my-task --to cursor" />
        </motion.div>

        <motion.ul
          custom={5}
          variants={fadeUp}
          initial="hidden"
          animate="show"
          className="mt-8 flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs text-faint"
          aria-label="Supported agents"
        >
          {AGENTS.map((a) => (
            <li key={a} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full bg-amber/70" aria-hidden="true" />
              {a}
            </li>
          ))}
        </motion.ul>
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.9, delay: 0.2, ease: "easeOut" }}
        className="order-first lg:order-none"
      >
        <BatonPassScene />
      </motion.div>
    </section>
  );
}
