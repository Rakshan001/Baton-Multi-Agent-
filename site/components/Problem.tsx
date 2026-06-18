"use client";

import { motion } from "framer-motion";

const LINES = [
  {
    lead: "You run three AI coding agents.",
    tail: "They don't know about each other.",
  },
  {
    lead: "Two of them just edited",
    tail: "the same file.",
  },
  {
    lead: "Your expensive agent hit its limit mid-task —",
    tail: "and all that context died with the session.",
  },
];

export default function Problem() {
  return (
    <section
      id="problem"
      className="mx-auto max-w-5xl px-5 py-28 lg:py-36"
      aria-labelledby="problem-title"
    >
      <h2 id="problem-title" className="sr-only">
        The problem Baton solves
      </h2>
      <p className="eyebrow mb-12">{"// the problem"}</p>

      <div className="space-y-10">
        {LINES.map((line, i) => (
          <motion.p
            key={i}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.6, delay: i * 0.12, ease: "easeOut" }}
            className="text-display text-2xl leading-tight text-faint sm:text-3xl lg:text-4xl"
          >
            {line.lead} <span className="text-fg">{line.tail}</span>
          </motion.p>
        ))}
      </div>
    </section>
  );
}
