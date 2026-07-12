"use client";

import { useState } from "react";

/**
 * A copy-to-clipboard install/command chip.
 * Mono text on a glassy 1px-border pill with a Copy affordance.
 */
export default function CopyChip({
  command,
  display,
  prefix = "$",
  className = "",
}: {
  command: string;
  display?: string;
  prefix?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API can be blocked; fail quietly rather than throwing.
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="group flex items-center gap-3 rounded-full border border-line bg-ink-2/80 px-4 py-2 font-mono text-sm text-muted transition-colors hover:border-line-strong hover:text-fg"
      aria-label={`Copy command: ${command}`}
    >
      <span className="select-none text-faint">{prefix}</span>
      <span className={`text-fg ${className}`}>{display ?? command}</span>
      <span
        className="ml-1 select-none text-xs text-faint transition-colors group-hover:text-amber"
        aria-hidden="true"
      >
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
