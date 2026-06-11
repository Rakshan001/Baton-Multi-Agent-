/* ============================================================
   BATON — demo-mode terminal playback
   A canned, ANSI-colored "claude TUI" transcript typed into the
   xterm instance so the Terminal tab is explorable without a
   daemon. Input is disabled in demo mode; this is showcase only.
   ============================================================ */

export interface DemoFrame {
  text: string;
  delay: number; // ms before this frame is written
}

const ESC = "\x1b[";
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`;
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`;
const green = (s: string) => `${ESC}32m${s}${ESC}0m`;
const yellow = (s: string) => `${ESC}33m${s}${ESC}0m`;
const nl = "\r\n";

export function buildDemoTerminal(slug: string, task?: string): DemoFrame[] {
  const what = task || "improve the empty states";
  return [
    { delay: 300, text: bold(cyan("✻ Claude Code")) + dim("  v2.1 · demo playback") + nl + nl },
    { delay: 500, text: dim("> ") + what + nl + nl },
    { delay: 900, text: cyan("●") + " I'll start by reading " + bold("CODEBASE.md") + " for orientation." + nl },
    { delay: 1100, text: dim("  ⎿ Read CODEBASE.md (212 lines)") + nl + nl },
    { delay: 1200, text: cyan("●") + " Searching the knowledge graph for related components…" + nl },
    { delay: 900, text: dim("  ⎿ query_graph(\"empty state components\") → 4 nodes") + nl + nl },
    { delay: 1300, text: cyan("●") + " Editing " + bold("src/components/EmptyState.tsx") + nl },
    { delay: 800, text: dim("  ⎿ Updated with 18 additions and 4 removals") + nl + nl },
    { delay: 1000, text: cyan("●") + " Running the checks…" + nl },
    { delay: 700, text: dim("  $ npx tsc --noEmit && npx vitest run") + nl },
    { delay: 1500, text: green("  ✓ typecheck clean · 34 tests passed") + nl + nl },
    { delay: 900, text: cyan("●") + " Committing on " + yellow(`baton/${slug}`) + nl },
    { delay: 700, text: dim("  ⎿ git commit -m \"feat: friendlier empty states\"") + nl + nl },
    { delay: 800, text: green("✓ Done.") + " The board will show this session as " + green("ready to merge") + "." + nl },
    { delay: 600, text: nl + dim("── demo playback ended · real sessions are fully interactive ──") + nl },
  ];
}
