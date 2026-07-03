"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * A terminal-style chip that types out a command, then loops.
 * Reduced-motion: shows the full command immediately, no caret animation.
 */
export default function TypingCommand({ text }: { text: string }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? text : "");

  useEffect(() => {
    if (reduce) {
      setShown(text);
      return;
    }
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      i += 1;
      setShown(text.slice(0, i));
      if (i < text.length) {
        timer = setTimeout(tick, 55);
      } else {
        // hold, then restart
        timer = setTimeout(() => {
          i = 0;
          setShown("");
          timer = setTimeout(tick, 600);
        }, 2600);
      }
    };

    timer = setTimeout(tick, 600);
    return () => clearTimeout(timer);
  }, [text, reduce]);

  return (
    <div className="panel inline-flex items-center gap-3 px-4 py-2.5 font-mono text-sm">
      <span aria-hidden="true" className="flex gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
        <span className="h-2.5 w-2.5 rounded-full bg-white/10" />
      </span>
      <span className="text-faint">$</span>
      <span className={reduce ? "text-fg" : "text-fg caret"}>{shown}</span>
    </div>
  );
}
