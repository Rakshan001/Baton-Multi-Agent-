"use client";
// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";

/**
 * A multi-line command block with copy-to-clipboard.
 *
 * CopyChip covers the single-command pill in the nav; this is its block-level
 * sibling for quick-start sequences, where the whole run matters.
 */
export default function CodeBlock({
  code,
  label,
}: {
  code: string;
  /** Mono caption above the block, e.g. "clone → build → serve". */
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be blocked; the text is selectable either way.
      setCopied(false);
    }
  }

  return (
    <figure className="panel my-6 overflow-hidden">
      <figcaption className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
        <span className="eyebrow !text-[0.68rem]">{label ?? "terminal"}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md px-2 py-1 font-mono text-xs text-faint transition-colors hover:text-amber"
          aria-label={`Copy: ${code}`}
        >
          {copied ? "copied" : "copy"}
        </button>
      </figcaption>
      <pre className="overflow-x-auto px-4 py-4 font-mono text-[0.82rem] leading-relaxed text-fg">
        <code>{code}</code>
      </pre>
    </figure>
  );
}
