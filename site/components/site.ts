// Shared, single-source-of-truth constants for the Baton marketing site.
// Copy here is grounded in the real CLI / API surface — do not invent flags.

export const REPO_URL = "https://github.com/Rakshan001/Baton-Multi-Agent-";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const GOOD_FIRST_ISSUES_URL = `${ISSUES_URL}?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const DOCS_URL = `${REPO_URL}#readme`;

// Star count is fetched live at build time (see Nav). This is the fallback.
export const STAR_FALLBACK = "★";

export const NAV_LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Open Source", href: "#open-source" },
  { label: "Docs", href: DOCS_URL, external: true },
] as const;

export const AGENTS = [
  "Claude Code",
  "Cursor",
  "Codex",
  "Gemini",
  "Aider",
  "OpenCode",
] as const;
