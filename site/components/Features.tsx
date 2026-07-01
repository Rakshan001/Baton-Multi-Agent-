"use client";

import { motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import Section from "./Section";
import Reveal from "./Reveal";

export default function Features() {
  return (
    <Section
      id="features"
      eyebrow="// what's in the box"
      title="Everything the agents need to share one repo."
      intro="Baton is a local coordination hub: a knowledge graph, evidence-anchored memory, live edit signals, and installable skills — all git-native, all on your machine."
    >
      <div className="grid auto-rows-[minmax(190px,auto)] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card className="lg:col-span-2 lg:row-span-2" eyebrow="knowledge graph" title="Your repo, indexed into a queryable graph." body="Agents navigate the code map instead of grepping. A merged cross-project graph rebuilds on every commit, exported as a <2k-token CODEBASE.md.">
          <GraphMini />
        </Card>

        <Card eyebrow="cost arbitrage" title="~300× cheaper context." body="Reading the repo map vs. reading every file.">
          <CostCounter />
        </Card>

        <Card eyebrow="session handoff" title="One markdown file carries the session." body="Objective, plan, checklist, cost estimate — plain markdown, no proprietary format.">
          <HandoffSnippet />
        </Card>

        <Card eyebrow="worktree isolation" title="Every agent gets its own git worktree." body="No clobbered branches, ever. Each task is a branch under baton/<slug> — in a single repo, or across a hub of several repos where each task branches off its own sub-project.">
          <BranchMini />
        </Card>

        <Card eyebrow="live edit signals" title="See who's editing what, in real time." body="SSE-streamed signals. Overlaps warn before they conflict, not after.">
          <SignalRows />
        </Card>

        <Card eyebrow="evidence-anchored memory" title="Shared facts pinned to commits & content hashes." body="When an anchor file changes, the fact is marked stale and withheld — agents can't hallucinate from it." />

        <Card className="lg:col-span-2" eyebrow="installable skills" title="A searchable catalog of reusable agent playbooks." body="One install writes a skill into the agent's own config — or import your own from a path or URL. Ships a flagship bug-fix skill plus an efficiency & traceability pack.">
          <SkillsRow />
        </Card>
      </div>
    </Section>
  );
}

function Card({
  eyebrow,
  title,
  body,
  className = "",
  children,
}: {
  eyebrow: string;
  title: string;
  body: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Reveal
      className={`group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-panel/60 p-6 transition-[transform,border-color] duration-300 hover:-translate-y-1 hover:border-line-strong ${className}`}
    >
      {/* hover glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: "radial-gradient(400px circle at 30% 0%, #ff9d2e14, transparent 70%)" }}
      />
      <div className="relative">
        <p className="eyebrow mb-3">{eyebrow}</p>
        <h3 className="text-balance text-lg font-medium leading-snug text-fg">
          {title}
        </h3>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted">{body}</p>
      </div>
      {children && <div className="relative mt-auto pt-6">{children}</div>}
    </Reveal>
  );
}

/* ----------------------------- mini graphics ----------------------------- */

function GraphMini() {
  // ~24 nodes in a loose force-like cluster (precomputed, deterministic).
  const nodes = Array.from({ length: 24 }, (_, i) => {
    const a = (i / 24) * Math.PI * 2;
    const r = 40 + ((i * 37) % 60);
    return {
      x: 160 + Math.cos(a) * r,
      y: 110 + Math.sin(a) * r * 0.8,
      key: i,
    };
  });
  return (
    <svg viewBox="0 0 320 220" className="h-44 w-full" aria-hidden="true">
      {nodes.map((n, i) =>
        nodes.slice(i + 1, i + 3).map((m, j) => (
          <line key={`${i}-${j}`} x1={n.x} y1={n.y} x2={m.x} y2={m.y} stroke="#ffffff14" strokeWidth="0.75" />
        )),
      )}
      {nodes.map((n) => (
        <motion.circle
          key={n.key}
          cx={n.x}
          cy={n.y}
          r={n.key % 5 === 0 ? 3.5 : 2}
          fill={n.key % 5 === 0 ? "#ff9d2e" : "#36d1dc"}
          initial={{ opacity: 0.5 }}
          animate={{ opacity: [0.4, 1, 0.6] }}
          transition={{ duration: 2, delay: (n.key % 6) * 0.15, repeat: Infinity, repeatType: "reverse" }}
        />
      ))}
    </svg>
  );
}

function CostCounter() {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true });
  const [val, setVal] = useState(0);

  // Fail-safe: count up when the card is in view, or shortly after mount if the
  // viewport observer never reports (keeps the figure from sitting at zero).
  const [forced, setForced] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setForced(true), 800);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!inView && !forced) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 1100);
      setVal(Math.round(824 + (248000 - 824) * easeOut(p)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, forced]);

  return (
    <div ref={ref} className="font-mono text-sm">
      <div className="flex items-baseline justify-between text-muted">
        <span>repo map</span>
        <span className="text-amber">~824 tok</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between text-muted">
        <span>every file</span>
        <span className="text-fg">~{val.toLocaleString()} tok</span>
      </div>
      <div className="mt-3 h-px bg-line" />
      <div className="mt-3 text-2xl text-fg">
        ~300<span className="text-amber">×</span> cheaper
      </div>
    </div>
  );
}

function HandoffSnippet() {
  return (
    <pre className="overflow-hidden rounded-lg border border-line bg-ink-2 p-3 font-mono text-[11px] leading-relaxed text-muted">
      <code>
        <span className="text-faint">---</span>
        {"\n"}objective: <span className="text-fg">ship fix</span>
        {"\n"}remaining: <span className="text-fg">2 tasks</span>
        {"\n"}est_cost_usd: <span className="text-amber">0.05</span>
        {"\n"}
        <span className="text-faint">---</span>
      </code>
    </pre>
  );
}

function BranchMini() {
  return (
    <svg viewBox="0 0 220 90" className="h-20 w-full" aria-hidden="true">
      <line x1="10" y1="45" x2="210" y2="45" stroke="#ffffff26" strokeWidth="1.5" />
      <path d="M70,45 C90,45 90,18 120,18" fill="none" stroke="#ff9d2e" strokeWidth="1.5" />
      <path d="M70,45 C90,45 90,72 120,72" fill="none" stroke="#36d1dc" strokeWidth="1.5" />
      {[10, 40, 70].map((x) => (
        <circle key={x} cx={x} cy="45" r="3.5" fill="#a1a1aa" />
      ))}
      <circle cx="120" cy="18" r="3.5" fill="#ff9d2e" />
      <circle cx="120" cy="72" r="3.5" fill="#36d1dc" />
    </svg>
  );
}

function SignalRows() {
  const files = ["src/server.ts", "src/api.ts", "web/api.ts"];
  return (
    <div className="space-y-2 font-mono text-xs">
      {files.map((f, i) => (
        <div key={f} className="flex items-center gap-2">
          <motion.span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: i === 2 ? "#ff9d2e" : "#36d1dc" }}
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.4, delay: i * 0.3, repeat: Infinity }}
          />
          <span className="text-muted">{f}</span>
          {i === 2 && <span className="text-amber">overlap</span>}
        </div>
      ))}
    </div>
  );
}

function SkillsRow() {
  const pills = ["bug-fix", "token-efficient-coding", "traceable-changes", "memory-light", "verify-before-done"];
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2 font-mono text-[11px]">
        <span className="rounded-md border border-line bg-ink-2 px-2 py-1 text-muted">.claude/skills/&lt;id&gt;/SKILL.md</span>
        <span className="rounded-md border border-line bg-ink-2 px-2 py-1 text-muted">.cursor/rules/&lt;id&gt;.mdc</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {pills.map((p) => (
          <span key={p} className="rounded-full border border-amber/30 bg-amber/10 px-3 py-1 font-mono text-xs text-amber">
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
