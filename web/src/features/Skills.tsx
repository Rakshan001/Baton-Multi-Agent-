// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Skills screen

   Two bands, and the split is the whole organising idea:

     Your skills   — uploaded by the user, stored in ~/.baton/skills,
                     present in EVERY project on this machine. These
                     are the ones that can be downloaded and deleted.
     Baton skills  — shipped inside the npm package. Install-only:
                     exporting one would hand back what npm already
                     delivered, and deleting one is not ours to allow.

   Install a skill into an agent's own config dir with one click —
   .claude/skills/<id>/SKILL.md for Claude Code, .cursor/rules for
   Cursor, .agents/skills for Antigravity.

   Mirrors GET /api/skills, POST /api/skills/upload|import,
   DELETE /api/skills/:id, GET /api/skills/:id/file and
   GET /api/skills/export (src/skills/install.ts).
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { CardSkeleton, ConfirmDialog, ErrorState } from "../components/primitives";
import { AgentGlyph, getAgent } from "../lib/registry";
import { Label, rule, ScreenHeader, SearchInput } from "./shared";
import { ApiError, BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import { copyText } from "../lib/format";
import { ls } from "../lib/storage";
import { SkillDetail } from "./SkillDetail";
import { isUserSkill, type SkillAgent, type SkillStatus } from "../types";

/** One track definition for the skill card grid, shared by the loading
 *  skeleton and the loaded grid. They previously disagreed — minmax(360px)
 *  gap 14 while loading vs minmax(380px) gap 12 after — so the column count
 *  could change the moment data arrived and the whole grid jumped. */
const SKILL_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))",
  gap: "var(--gap-lg)",
  alignItems: "start",
};

/** Where users can find more skills to download. Ours will replace it later. */
const SKILL_DIRECTORY_URL = "https://www.skills.sh/";

/** Extensions the daemon accepts, kept in step with SKILL_EXTENSIONS server-side. */
const UPLOAD_ACCEPT = ".md,.mdc,.markdown,.txt";

/** Mirrors slugifySkillId in src/skills/install.ts — the shortcut preview must
 *  show what the daemon will actually store, not a hopeful approximation. */
function slugifyShortcut(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}



/* The curated "efficiency & traceability" pack — surfaced as a showcase band so these
   high-leverage skills are discoverable on the empty/landing state of the screen. */
const FEATURED_PACK: { id: string; blurb: string }[] = [
  { id: "token-efficient-coding", blurb: "Read the map, not the repo. Minimal diffs, no re-reads." },
  { id: "traceable-changes", blurb: "One atomic commit per change. Blame & bisect just work." },
  { id: "memory-light", blurb: "Recall before exploring. State to disk, not the chat." },
  { id: "verify-before-done", blurb: "Skeptic re-checks the diff before anything ships." },
];

/* The skill a brand-new project should run before anything else. Surfaced on its own band so
   it reads as the starting point rather than one card among many. */
const STARTER_ID = "basic-setup";

/* Proven skills from the wider Claude ecosystem — every URL verified to serve a
   raw SKILL.md. Clicking one prefills the import box (nothing installs without
   the user confirming), so the catalog isn't limited to what Baton bundles. */
const COMMUNITY_PICKS: { name: string; repo: string; blurb: string; url: string; heavy?: string }[] = [
  { name: "ui-ux-pro-max", repo: "nextlevelbuilder/ui-ux-pro-max-skill", blurb: "Design intelligence for real interfaces: 119 UX rules, 192 palettes, 74 font pairings, searchable offline.", url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill", heavy: "70 files, 3.5MB — brings its own search tool and data. Claude Code and Antigravity can run it; Cursor gets the guidance without the tool." },
  { name: "test-driven-development", repo: "obra/superpowers", blurb: "RED → GREEN → REFACTOR, enforced: no production code without a failing test first.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/test-driven-development/SKILL.md" },
  { name: "systematic-debugging", repo: "obra/superpowers", blurb: "Four-phase root-cause analysis — turns guess-and-patch into investigation.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md" },
  { name: "brainstorming", repo: "obra/superpowers", blurb: "Socratic design refinement before any code is written.", url: "https://raw.githubusercontent.com/obra/superpowers/main/skills/brainstorming/SKILL.md" },
  { name: "skill-creator", repo: "anthropics/skills", blurb: "Write your own skills properly — structure, trigger descriptions, references.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/skill-creator/SKILL.md" },
  { name: "webapp-testing", repo: "anthropics/skills", blurb: "Drive and test web apps end-to-end from the agent.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/webapp-testing/SKILL.md" },
  { name: "mcp-builder", repo: "anthropics/skills", blurb: "Build MCP servers that expose your tools to any agent.", url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/mcp-builder/SKILL.md" },
];

/**
 * The prompt users hand to an agent to write or repair a SKILL.md.
 *
 * It exists because the two frontmatter fields do completely different jobs and
 * nothing on disk says so. `name` becomes the shortcut a human types;
 * `description` is what the AGENT reads to decide whether the skill is relevant
 * at all — so a vague one means the skill never fires, and a sprawling one
 * means it fires constantly. Everything the Skills screen renders comes from
 * these two fields, so a messy file is a messy card.
 *
 * Written as an instruction to an agent rather than a spec for a human: the
 * point is that you paste it, hand over your file, and get a fixed one back.
 */
const SKILL_AUTHORING_PROMPT = `You are improving an agent skill file (SKILL.md) for Baton.

Here is my skill file (or a description of what I want the skill to do):

<<< PASTE YOUR SKILL.md OR YOUR IDEA HERE >>>

Rewrite it to this exact format, then review it.

## Required format

\`\`\`markdown
---
name: kebab-case-id
description: "One or two sentences, written for an AGENT deciding whether to use this. Lead with the trigger — when should it fire? Include the words someone would actually say. Wrap in double quotes if it contains a colon."
---

# Human-readable title

One short paragraph: what this does and when to reach for it.

## Steps

1. Concrete, ordered, checkable steps.
2. Say what to do, not what to consider.

## Done when

- The observable condition that means it worked.
\`\`\`

## Rules

1. \`name\` is the shortcut people type — kebab-case, under 40 chars, no version numbers.
2. \`description\` is the single most important line. It is the agent's ONLY basis
   for deciding relevance. Lead with the trigger condition, then keywords a user
   would say out loud. Aim for 15–40 words. Never start with "This skill…".
3. Keep the description to ONE line in the file — a folded multi-line YAML scalar
   is valid but harder to read back.
4. The body is a playbook, not an essay. Prefer numbered steps over prose.
5. No secrets, no absolute paths from your machine, no company-internal URLs.

## One skill per file — split if you must

A skill is ONE job. If what I gave you covers several unrelated jobs, do not
force it into one file — split it into several, one job each, and give every one
its own \`name\` and \`description\`. A file that tries to cover everything matches
nothing, because the agent cannot tell when it applies.

Lay each one out as its own folder named after its shortcut:

\`\`\`
deploy-checklist/SKILL.md
incident-review/SKILL.md
api-conventions/SKILL.md
\`\`\`

I can upload that whole set in one go — every folder becomes its own shortcut —
so err on the side of splitting rather than merging.

## Then report back

- The rewritten SKILL.md, complete, in one code block. If you split it, give me
  each file in its own block with its folder name above it.
- A ranked list of what you changed and why — most impactful first.
- Anything you could not fix without more information from me, stated plainly.`;

/** Same set as UPLOAD_ACCEPT, as a test — mirrors SKILL_EXTENSIONS server-side. */
const SKILL_EXT_RE = /\.(md|mdc|markdown|txt)$/i;
/** Mirrors MAX_IMPORT_BYTES in src/skills/install.ts. */
const MAX_SKILL_BYTES = 256 * 1024;
/** A stray Downloads folder should not be able to hang the tab, or queue 4000 rows. */
const MAX_ROWS = 20;
const DROP_MAX_DEPTH = 4;

const baseName = (p: string): string => p.split(/[/\\]/).pop() || p;

/**
 * Mirrors parseSkillSource in src/skills/github.ts.
 *
 * People paste the whole `npx skills add <url> --skill <name>` line out of a
 * README. Without this the shortcut field derives itself from that entire
 * string — and because an explicit shortcut overrides the daemon's own answer,
 * the good name gets replaced by a slug of the command.
 */
function parsePastedSource(input: string): { url: string; skill?: string } | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  const url = /https?:\/\/[^\s'"`<>]+/.exec(text)?.[0];
  if (!url) return null;
  const skill = /(?:--skill|--name|-s)[=\s]+["']?([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text)?.[1];
  return { url: url.replace(/[.,;:)\]}]+$/, ""), ...(skill ? { skill } : {}) };
}

/**
 * The shortcut a file starts with, in the daemon's own order of preference.
 *
 * The folder step is the one that matters: the conventional layout is
 * `<id>/SKILL.md`, so six folders dropped at once would otherwise all want to
 * be `/skill`. Only the folder name knows what the skill is called.
 */
function suggestShortcut(path: string, text: string): string {
  const declared = /^---\r?\n[\s\S]*?^name:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  if (declared) return slugifyShortcut(declared.replace(/^["']|["']$/g, ""));
  const parts = path.split(/[/\\]/).filter(Boolean);
  const stem = (parts.pop() ?? "").replace(SKILL_EXT_RE, "");
  if (/^skill$/i.test(stem) && parts.length) return slugifyShortcut(parts[parts.length - 1]);
  return slugifyShortcut(stem);
}

/**
 * Problems worth raising BEFORE the upload rather than after.
 *
 * None of these stop a skill from being stored — the daemon salvages a lot —
 * but each one produces a skill that reads badly on a card or never fires at
 * all, and the moment to fix that is while the file is still in your editor.
 * Every one of them is something the authoring prompt repairs, which is why
 * each warning offers it.
 */
function formatWarnings(text: string): string[] {
  const out: string[] = [];
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!fm) {
    out.push("No --- frontmatter, so the shortcut and summary are guessed from the filename and first heading.");
  } else {
    const raw = /^description:[ \t]*(.*)$/m.exec(fm[1])?.[1]?.trim() ?? "";
    const desc = raw.replace(/^(['"])([\s\S]*)\1$/, "$2");
    if (!desc) {
      out.push("No description — this is what an agent matches on, so without it the skill may never fire.");
    } else {
      const words = desc.split(/\s+/).filter(Boolean).length;
      if (words < 8) out.push(`The description is ${words} word${words === 1 ? "" : "s"} — too thin for an agent to tell when this applies.`);
      else if (words > 60) out.push(`The description is ${words} words — it will match everything, and the card summary will be a wall of text.`);
      if (/^this skill\b/i.test(desc)) out.push('The description opens with "This skill…" — lead with the trigger instead.');
    }
    if (!/^name:/m.test(fm[1])) out.push("No name in the frontmatter, so the shortcut comes from the file or folder name.");
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const h1 = body.match(/^#[ \t]+\S/gm)?.length ?? 0;
  if (h1 > 1) out.push(`${h1} top-level headings — this looks like several skills in one file. One skill per file matches better.`);
  return out;
}

/**
 * Files out of a drop, folders included.
 *
 * `webkitGetAsEntry` is the only way to see inside a dropped directory —
 * `DataTransfer.files` flattens a folder to an unreadable zero-byte entry — and
 * dropping a handful of `<skill>/SKILL.md` folders at once is exactly the shape
 * people keep these in.
 */
async function filesFromDrop(dt: DataTransfer): Promise<{ path: string; file: File }[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const e = dt.items[i].webkitGetAsEntry?.();
    if (e) roots.push(e);
  }
  // No entry API (or a drag that carried plain files): take what's there.
  if (!roots.length) return Array.from(dt.files).map((f) => ({ path: f.name, file: f }));

  const out: { path: string; file: File }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string, depth: number): Promise<void> => {
    if (out.length >= MAX_ROWS) return;
    if (entry.isFile) {
      const f = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      if (SKILL_EXT_RE.test(f.name)) out.push({ path: prefix + f.name, file: f });
      return;
    }
    if (depth >= DROP_MAX_DEPTH) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries yields at most 100 per call and signals the end with an empty batch.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, depth + 1);
    }
  };
  for (const r of roots) await walk(r, "", 0);
  return out;
}

/** One queued file or URL, from picked to landed. */
type Row = {
  key: string;
  /** What the user sees: `deploy-checklist/SKILL.md`, or the URL itself. */
  label: string;
  /** File rows carry their bytes; URL rows carry the address instead. */
  content?: string;
  url?: string;
  shortcut: string;
  warnings: string[];
  status: "ready" | "busy" | "done" | "error";
  error?: string;
  /** The daemon refused because the name is taken, and offered a replace. */
  canReplace?: boolean;
  /** The repo held several skills — pick one rather than guess. */
  choices?: { id: string; dir: string }[];
};

/** There is only ever one URL row, and retyping the URL replaces it. */
const URL_ROW_KEY = "url:row";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn btn-sm fr" style={{ flex: "none", height: 27 }}
      onClick={() => { void copyText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }); }}>
      <Icon name={copied ? "check" : "copy"} size={12} /> {copied ? "Copied" : "Copy prompt"}
    </button>
  );
}

/**
 * The authoring prompt, behind a door you can actually see.
 *
 * This was a <details> whose summary set `list-style: none`, which suppressed
 * the disclosure triangle and left one line of grey text that nothing marked as
 * clickable — so the prompt may as well not have been there. Now it is an
 * accent row with a chevron that turns, and Copy sits in the header, so the
 * useful thing costs one click rather than two.
 */
function AuthoringPrompt({ open, onToggle, boxRef }: {
  open: boolean;
  onToggle: () => void;
  boxRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={boxRef} style={{ background: "var(--accent-soft)", border: "1px solid var(--accent-border)", borderRadius: "var(--r-sm)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
        <span style={{ width: 26, height: 26, borderRadius: 7, flex: "none", display: "grid", placeItems: "center", background: "var(--bg-base)", border: "1px solid var(--accent-border)", color: "var(--accent-text)" }}>
          <Icon name="sparkle" size={13} />
        </span>
        <button className="fr" onClick={onToggle} aria-expanded={open}
          style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}>
          <span style={{ display: "block", fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Format my skill with an agent</span>
          <span style={{ display: "block", fontSize: "var(--fs-11)", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            Paste this and your file into any agent. It fixes the shape, ranks what it changed, and splits the file if it is really several skills.
          </span>
        </button>
        <CopyButton text={SKILL_AUTHORING_PROMPT} />
        <button className="btn btn-icon fr" onClick={onToggle} data-tip-side="bottom"
          aria-label={open ? "Hide the prompt text" : "Show the prompt text"} style={{ flex: "none" }}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
        </button>
      </div>
      {open && (
        <div style={{ padding: "0 12px 12px" }}>
          <pre className="mono" style={{ margin: 0, padding: "11px 13px", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", fontSize: "var(--text-micro)", lineHeight: 1.6, color: "var(--text-tertiary)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 260, overflow: "auto" }}>
            {SKILL_AUTHORING_PROMPT}
          </pre>
        </div>
      )}
    </div>
  );
}

/** One row of the queue: what it is, what it will be called, what's wrong with it. */
function QueueRow({ row, frozen, problem, note, onShortcut, onRemove, onRetry, onPickChoice, onFixWithPrompt }: {
  row: Row;
  /** True while ANY row in the batch is uploading. */
  frozen: boolean;
  problem: string;
  /** Non-blocking remark — e.g. "you already have one by this name". */
  note: string;
  onShortcut: (v: string) => void;
  onRemove: () => void;
  onRetry: (replace: boolean) => void;
  /** Chose one skill out of a repo that held several. */
  onPickChoice: (id: string) => void;
  onFixWithPrompt: () => void;
}) {
  const id = slugifyShortcut(row.shortcut);
  const done = row.status === "done";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", background: "var(--bg-surface-2)", border: `1px solid ${row.status === "error" ? "var(--conflict-border)" : done ? "var(--clean-border, var(--border-subtle))" : "var(--border-subtle)"}`, borderRadius: "var(--r-sm)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Icon name={done ? "checkCircle" : row.status === "error" ? "alertTriangle" : row.url ? "link" : "folder"} size={13}
          style={{ flex: "none", color: done ? "var(--clean-text, var(--accent-text))" : row.status === "error" ? "var(--conflict)" : "var(--text-quaternary)" }} />
        <span className="mono" data-tip={row.label.length > 46 ? row.label : undefined}
          style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.label}
        </span>
        {row.status === "busy" && <span style={{ flex: "none", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>Adding…</span>}
        {done && <span style={{ flex: "none", fontSize: "var(--fs-11)", color: "var(--clean-text, var(--accent-text))" }}>Added</span>}
        {!done && !frozen && (
          <button className="btn btn-icon fr" onClick={onRemove} data-tip-side="bottom"
            aria-label={`Take ${row.label} out of the queue`} style={{ flex: "none" }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {!done && (
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ flex: "none", fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>Shortcut</span>
          <input value={row.shortcut} onChange={(e) => onShortcut(e.target.value)} placeholder="deploy-checklist"
            disabled={frozen} aria-label={`Shortcut for ${row.label}`}
            style={{ flex: 1, minWidth: 0, height: 30, padding: "0 10px", background: "var(--bg-input)", border: `1px solid ${problem ? "var(--dirty-border)" : "var(--border-default)"}`, borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-12)", fontFamily: "var(--font-mono)", outline: "none" }} />
          <span className="mono" style={{ flex: "none", fontSize: "var(--fs-12)", color: id ? "var(--accent-text)" : "var(--text-quaternary)" }}>/{id || "…"}</span>
        </div>
      )}

      {problem && <span style={{ fontSize: "var(--fs-11)", color: "var(--dirty-text)" }}>{problem}</span>}
      {!problem && note && <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{note}</span>}

      {row.status === "error" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ flex: 1, minWidth: 180, fontSize: "var(--fs-11)", color: "var(--conflict)" }}>{row.error}</span>
          {row.choices?.length
            ? null
            : row.canReplace
              ? <button className="btn btn-sm fr" onClick={() => onRetry(true)} style={{ flex: "none" }}>Replace it</button>
              : <button className="btn btn-sm fr" onClick={() => onRetry(false)} style={{ flex: "none" }}>Try again</button>}
        </div>
      )}

      {/* A repo of many skills is the normal case, not an error state: show what
          is in there and let one click choose. */}
      {row.choices && row.choices.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {row.choices.map((c) => (
            <button key={c.dir} className="btn btn-sm fr" style={{ height: 26 }}
              data-tip={c.dir} onClick={() => onPickChoice(c.id)}>
              <span className="mono" style={{ fontSize: "var(--fs-11)" }}>{c.id}</span>
            </button>
          ))}
        </div>
      )}

      {row.warnings.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)" }}>
          {row.warnings.map((w) => (
            <div key={w} style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
              <Icon name="alertTriangle" size={11} style={{ flex: "none", marginTop: 2, color: "var(--dirty-text)" }} />
              <span style={{ fontSize: "var(--fs-11)", lineHeight: 1.5, color: "var(--text-tertiary)" }}>{w}</span>
            </div>
          ))}
          {!done && (
            <button className="btn btn-sm fr" onClick={onFixWithPrompt} style={{ alignSelf: "flex-start", height: 25 }}>
              <Icon name="sparkle" size={11} /> Fix it with the prompt
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Add skills: drop files or folders, confirm each shortcut, done.
 *
 * Multi-file because that is how skills actually live — a handful of
 * `<id>/SKILL.md` folders, not one file at a time — and because the agent that
 * formats them is told to split one document into several when it covers
 * several jobs. Every file gets its own editable shortcut, its own format
 * warnings, and its own success or failure, so one bad file in a batch of six
 * never costs you the other five.
 *
 * The picker is a <label> wrapping the input rather than a hidden input driven
 * by `.click()`: that opens the file manager natively in every engine, needs no
 * JavaScript, and is reachable from the keyboard.
 */
function AddSkillPanel({ taken, bundledIds, seedUrl, onAdded, onClose }: {
  taken: Set<string>;
  bundledIds: Set<string>;
  /** Prefilled by the community picks. The caller keys the panel on this, so a
   *  new pick remounts with fresh state rather than needing a sync effect. */
  seedUrl?: string;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => {
    const seed = seedUrl ? parsePastedSource(seedUrl) : null;
    if (!seed) return [];
    const shortcut = seed.skill ? slugifyShortcut(seed.skill) : suggestShortcut(seed.url, "");
    return [{ key: URL_ROW_KEY, label: seed.url, url: seed.url, shortcut, warnings: [], status: "ready" }];
  });
  const [url, setUrl] = useState(seedUrl ?? "");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const promptBox = useRef<HTMLDivElement>(null);
  /** Nested dragenter/dragleave fire on every child; count them, don't toggle. */
  const dragDepth = useRef(0);
  /** Row keys must be unique across batches, so the same file dropped twice
   *  does not collide with itself. Nothing about a File is reliably unique. */
  const nextKey = useRef(0);

  // The panel renders at the top of the list, but "Add skill" can be clicked
  // from a band heading further down — so without this it opens off-screen and
  // reads as "the button did nothing".
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, []);

  const patch = (key: string, next: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const addFiles = async (picked: { path: string; file: File }[]) => {
    const accepted: Row[] = [];
    const rejected: string[] = [];
    for (const { path, file } of picked) {
      if (!SKILL_EXT_RE.test(file.name)) { rejected.push(`${file.name} — not a markdown file`); continue; }
      if (file.size > MAX_SKILL_BYTES) { rejected.push(`${file.name} — ${Math.round(file.size / 1024)}KB, over the 256KB limit`); continue; }
      const content = await file.text();
      accepted.push({
        key: `f${(nextKey.current += 1)}:${path}`,
        label: path, content,
        shortcut: suggestShortcut(path, content),
        warnings: formatWarnings(content),
        status: "ready",
      });
    }
    if (rejected.length) {
      showToast({
        kind: "error",
        title: rejected.length === 1 ? "That file can't be a skill" : `${rejected.length} files were skipped`,
        desc: rejected.slice(0, 4).join("\n"),
      });
    }
    const room = Math.max(0, MAX_ROWS - rows.length);
    const take = accepted.slice(0, room);
    if (accepted.length > take.length) {
      showToast({ kind: "warn", title: `The queue holds ${MAX_ROWS} files`, desc: `${accepted.length - take.length} were left out — add them in a second batch.` });
    }
    if (take.length) setRows((prev) => [...prev, ...take]);
  };

  const setUrlValue = (v: string) => {
    setUrl(v);
    const parsed = parsePastedSource(v);
    setRows((prev) => {
      const others = prev.filter((r) => r.key !== URL_ROW_KEY);
      if (!parsed) return others;
      // A named --skill is the author's own answer; only guess without one.
      const shortcut = parsed.skill ? slugifyShortcut(parsed.skill) : suggestShortcut(parsed.url, "");
      return [...others, { key: URL_ROW_KEY, label: parsed.url, url: parsed.url, shortcut, warnings: [], status: "ready" as const }];
    });
  };

  // A shortcut can only be claimed once per batch — two files both wanting /x
  // would otherwise silently overwrite each other, one request apart.
  const wanted = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "done") continue;
    const id = slugifyShortcut(r.shortcut);
    if (id) wanted.set(id, (wanted.get(id) ?? 0) + 1);
  }

  const problemOf = (r: Row): string => {
    if (r.status === "done") return "";
    const id = slugifyShortcut(r.shortcut);
    if (!id) return r.shortcut.trim() ? "That has no letters or digits in it." : "Give this one a shortcut.";
    if (bundledIds.has(id)) return `'${id}' is a Baton built-in — pick another name.`;
    if ((wanted.get(id) ?? 0) > 1) return `Two files in this batch both want /${id}.`;
    return "";
  };
  const noteOf = (r: Row): string =>
    r.status !== "done" && taken.has(slugifyShortcut(r.shortcut)) ? "You already have one by this name — it will ask before replacing." : "";

  const pending = rows.filter((r) => r.status !== "done");
  const ready = !busy && pending.length > 0 && pending.every((r) => !problemOf(r));

  /**
   * `overrideShortcut` exists because picking a skill out of a multi-skill repo
   * re-submits immediately: `rows` in this closure is the pre-click snapshot, so
   * without it the retry would post the shortcut the user just replaced.
   */
  const submit = async (only?: string, replace = false, overrideShortcut?: string) => {
    const targets = rows.filter((r) => (only ? r.key === only : r.status !== "done") && (overrideShortcut ? true : !problemOf(r)));
    if (!targets.length) return;
    setBusy(true);
    const landed = new Set<string>();
    let failed = 0;
    for (const r of targets) {
      patch(r.key, { status: "busy", error: undefined, canReplace: false });
      try {
        const useId = slugifyShortcut(overrideShortcut ?? r.shortcut);
        const s = r.content !== undefined
          ? await BatonAPI.uploadSkill({ filename: baseName(r.label), content: r.content, id: useId, replace })
          : await BatonAPI.importSkill(r.url!, { id: useId, replace });
        landed.add(r.key);
        // A skill whose text points at references/ files that a single .md upload
        // could not carry still works — but the agent will go looking, so say so.
        const dangling = /references\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+/.test(s.body);
        patch(r.key, {
          status: "done", shortcut: s.id, error: undefined,
          warnings: dangling ? ["It mentions references/ files that didn't come with it — agents will go looking for those."] : [],
        });
      } catch (e) {
        failed++;
        const err = e as ApiError;
        const choices = err.code === "AMBIGUOUS"
          ? ((err.details as { choices?: { id: string; dir: string }[] } | undefined)?.choices ?? [])
          : undefined;
        patch(r.key, {
          status: "error",
          error: choices?.length ? `That repo holds ${choices.length} skills — which one?` : err.message,
          canReplace: err.code === "CONFLICT",
          ...(choices?.length ? { choices } : {}),
        });
      }
    }
    setBusy(false);
    if (landed.size) {
      onAdded();
      showToast({
        kind: "ok",
        title: landed.size === 1 ? "Skill added" : `${landed.size} skills added`,
        desc: "Agents invoke them by shortcut, in every project on this machine.",
      });
      // Close only once nothing is left to fix, so a failure stays on screen.
      if (!failed && rows.every((r) => r.status === "done" || landed.has(r.key))) onClose();
    }
  };

  const fixWithPrompt = () => {
    setPromptOpen(true);
    setTimeout(() => promptBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
  };

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <div ref={panel} className="card"
      onDragEnter={(e) => { if (dragHasFiles(e)) { e.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
      onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDrop={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void filesFromDrop(e.dataTransfer).then(addFiles).catch((err) =>
          showToast({ kind: "error", title: "Couldn't read what you dropped", desc: (err as Error).message }));
      }}
      style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12, maxWidth: 720, borderColor: dragging ? "var(--accent-text)" : "var(--accent-border)" }}>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="plus" size={14} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Add skills</span>
        <button className="btn btn-sm fr" style={{ marginLeft: "auto", height: 26 }} onClick={onClose}>
          {rows.some((r) => r.status === "done") ? "Done" : "Cancel"}
        </button>
      </div>

      {/* Above the picker on purpose. A badly-shaped SKILL.md is easiest to fix
          BEFORE it is uploaded, and everything the card and the detail view
          render comes from the two frontmatter fields this explains. */}
      <AuthoringPrompt open={promptOpen} onToggle={() => setPromptOpen((v) => !v)} boxRef={promptBox} />

      <label className="drop-zone fr"
        style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 14px", background: dragging ? "var(--accent-soft)" : "var(--bg-surface-2)", border: `1px dashed ${dragging ? "var(--accent-text)" : "var(--border-default)"}`, borderRadius: "var(--r-sm)", cursor: "pointer" }}>
        <input className="sr-only" type="file" accept={UPLOAD_ACCEPT} multiple
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
            e.target.value = "";
            void addFiles(picked);
          }} />
        <Icon name="folder" size={17} style={{ color: dragging ? "var(--accent-text)" : "var(--text-tertiary)", flex: "none" }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)" }}>
            {dragging ? "Drop them here" : "Choose SKILL.md files — or drop a whole folder"}
          </span>
          <span style={{ display: "block", fontSize: "var(--fs-11)", color: "var(--text-quaternary)", lineHeight: 1.5 }}>
            Several at once is fine. Drop <span className="mono">&lt;name&gt;/SKILL.md</span> folders and each one keeps its folder as its shortcut.
          </span>
        </span>
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
        <span style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)" }}>or paste a URL</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
      </div>

      <input value={url} placeholder="https://…/SKILL.md" aria-label="Add a skill from a URL"
        onChange={(e) => setUrlValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && ready) void submit(); if (e.key === "Escape") onClose(); }}
        style={{ height: 34, padding: "0 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none" }} />

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Label>{rows.length === 1 ? "1 skill" : `${rows.length} skills`}</Label>
            <span style={rule} />
            {pending.length > 1 && !busy && (
              <button className="btn btn-sm fr" style={{ flex: "none", height: 25 }} onClick={() => setRows((prev) => prev.filter((r) => r.status === "done"))}>
                Clear
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 380, overflowY: "auto" }}>
            {rows.map((r) => (
              <QueueRow key={r.key} row={r} frozen={busy} problem={problemOf(r)} note={noteOf(r)}
                onShortcut={(v) => patch(r.key, { shortcut: v })}
                onRemove={() => { if (r.key === URL_ROW_KEY) setUrl(""); setRows((prev) => prev.filter((x) => x.key !== r.key)); }}
                onRetry={(replace) => void submit(r.key, replace)}
                onPickChoice={(id) => {
                  // Naming the skill is what the daemon was missing; set it and go.
                  patch(r.key, { shortcut: id, status: "ready", error: undefined, choices: undefined });
                  void submit(r.key, false, id);
                }}
                onFixWithPrompt={fixWithPrompt} />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button className="btn btn-primary fr" disabled={!ready} onClick={() => void submit()}
          style={!ready ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
          {busy ? "Adding…" : pending.length > 1 ? `Add ${pending.length} skills` : "Add skill"}
        </button>
      </div>
    </div>
  );
}

/* ---- filtering & density ------------------------------------------
   A library of a dozen skills browses fine as a wall of cards. A library
   of a hundred does not: at that size the question stops being "what is
   there?" and becomes "where is the one I want?". So the screen gains a
   way to narrow (source, installed, tag) and a way to change how much
   each answer costs in vertical space.
   -------------------------------------------------------------------- */

type SourceFilter = "all" | "mine" | "baton";
type StatusFilter = "all" | "installed" | "available";
type Density = "cards" | "rows";

/** Below this a wall of cards is still pleasant; above it, rows win by default. */
const ROWS_DEFAULT_AT = 24;

/** A small run of mutually exclusive choices. Two on this screen, so it is a
 *  component rather than the same twenty lines written twice. */
function Segmented<T extends string>({ value, onChange, options, label }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count?: number }[];
  label: string;
}) {
  return (
    <div role="group" aria-label={label}
      style={{ display: "inline-flex", padding: 2, gap: 2, background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} className="fr" aria-pressed={on} onClick={() => onChange(o.value)}
            style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 24, padding: "0 9px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: "var(--fs-12)", fontWeight: on ? "var(--fw-semibold)" : "var(--fw-medium)", fontFamily: "inherit", background: on ? "var(--bg-surface)" : "transparent", color: on ? "var(--text-primary)" : "var(--text-tertiary)", boxShadow: on ? "0 1px 2px rgba(0,0,0,.16)" : "none" }}>
            {o.label}
            {o.count !== undefined && (
              <span className="mono" style={{ fontSize: "var(--text-micro)", color: on ? "var(--text-tertiary)" : "var(--text-quaternary)" }}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** One compact row. At a hundred skills this is the readable unit: shortcut,
 *  what it is for, where it is wired, in one scannable line. */
function SkillRow({ s, writeEnabled, onChanged, onOpen }: {
  s: SkillStatus; writeEnabled: boolean; onChanged: () => void; onOpen: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const installed = s.installs.filter((i) => i.installed).length;
  const mine = isUserSkill(s.source);

  const toggle = async (agent: SkillAgent, on: boolean) => {
    setBusy(true);
    try {
      await (on ? BatonAPI.uninstallSkill(s.id, agent) : BatonAPI.installSkill(s.id, agent));
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn't change that install", desc: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="skill-row" onClick={() => onOpen(s.id)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(s.id); } }}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", cursor: "pointer" }}>
      <button className="btn btn-icon fr" disabled={!writeEnabled} aria-pressed={s.bookmarked}
        aria-label={s.bookmarked ? `Remove the bookmark on ${s.id}` : `Bookmark ${s.id}`}
        onClick={(e) => {
          e.stopPropagation();
          void BatonAPI.bookmarkSkill(s.id, !s.bookmarked).then(onChanged)
            .catch((err) => showToast({ kind: "error", title: "Couldn't update the bookmark", desc: (err as Error).message }));
        }}
        style={{ flex: "none", width: 24, height: 24, color: s.bookmarked ? "var(--dirty-text)" : "var(--text-quaternary)" }}>
        <Icon name={s.bookmarked ? "starFilled" : "star"} size={12} />
      </button>

      <span className="mono skill-row-id" style={{ flex: "none", width: 190, fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        /{s.id}
      </span>

      <span className="skill-row-desc" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {s.description}
      </span>

      {!mine && (
        <span className="skill-row-src" style={{ flex: "none", fontSize: "var(--text-micro)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)" }}>
          Baton
        </span>
      )}

      <span style={{ flex: "none", display: "inline-flex", gap: 3 }}>
        {s.installs.map((i) => (
          <button key={i.agent} className="btn btn-icon fr" disabled={!writeEnabled || busy}
            data-tip-side="bottom"
            data-tip={!writeEnabled ? "Read-only" : `${i.installed ? "Remove from" : "Add to"} ${getAgent(i.agent).short}`}
            aria-label={`${i.installed ? "Remove" : "Add"} ${s.id} ${i.installed ? "from" : "to"} ${getAgent(i.agent).short}`}
            onClick={(e) => { e.stopPropagation(); void toggle(i.agent, i.installed); }}
            style={{ width: 24, height: 24, opacity: i.installed ? 1 : 0.38 }}>
            <AgentGlyph id={i.agent} size={12} />
          </button>
        ))}
      </span>

      <span className="mono" style={{ flex: "none", width: 26, textAlign: "right", fontSize: "var(--text-micro)", color: installed ? "var(--clean-text, var(--accent-text))" : "var(--text-quaternary)" }}>
        {installed}/{s.installs.length}
      </span>
    </div>
  );
}


export function SkillsScreen({ writeEnabled, searchSeed }: { writeEnabled: boolean; searchSeed?: { q: string; n: number } }) {
  const skills = usePoll<SkillStatus[]>(() => BatonAPI.getSkills(), { interval: 30000 });
  const [q, setQ] = useState(searchSeed?.q ?? "");
  // ⌘K deep-link: a picked skill re-seeds the search even if we're already here.
  useEffect(() => { if (searchSeed) setQ(searchSeed.q); }, [searchSeed?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [importing, setImporting] = useState(false);
  /** Which skill has its detail dialog open, by id. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Delete confirm raised from the detail dialog (the card raises its own). */
  const [pendingDelete, setPendingDelete] = useState<SkillStatus | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Prefilled URL from a community pick; keys the add panel so it remounts. */
  const [source, setSource] = useState("");
  /** Narrowing controls. Persisted: at a hundred skills, having to re-narrow on
   *  every visit is the same cost as not having the filters at all. */
  const [srcFilter, setSrcFilter] = useState<SourceFilter>(() => ls.get<SourceFilter>("baton:skills:src", "all"));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => ls.get<StatusFilter>("baton:skills:status", "all"));
  const [tag, setTag] = useState<string>(() => ls.get<string>("baton:skills:tag", ""));
  const [density, setDensity] = useState<Density | null>(() => ls.get<Density | null>("baton:skills:density", null));
  useEffect(() => { ls.set("baton:skills:src", srcFilter); }, [srcFilter]);
  useEffect(() => { ls.set("baton:skills:status", statusFilter); }, [statusFilter]);
  useEffect(() => { ls.set("baton:skills:tag", tag); }, [tag]);
  useEffect(() => { ls.set("baton:skills:density", density); }, [density]);

  const featured = useMemo(() => {
    const byId = new Map((skills.data ?? []).map((s) => [s.id, s]));
    return FEATURED_PACK.map((f) => ({ ...f, skill: byId.get(f.id) })).filter((f) => f.skill);
  }, [skills.data]);

  const starter = useMemo(() => (skills.data ?? []).find((s) => s.id === STARTER_ID), [skills.data]);

  const all = skills.data ?? [];

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((s) => {
      if (needle && !`${s.name} ${s.description} ${s.tags.join(" ")} ${s.produces.join(" ")} ${s.id}`.toLowerCase().includes(needle)) return false;
      if (srcFilter === "mine" && !isUserSkill(s.source)) return false;
      if (srcFilter === "baton" && isUserSkill(s.source)) return false;
      const anyInstalled = s.installs.some((i) => i.installed);
      if (statusFilter === "installed" && !anyInstalled) return false;
      if (statusFilter === "available" && anyInstalled) return false;
      if (tag && !s.tags.includes(tag)) return false;
      return true;
    });
  }, [all, q, srcFilter, statusFilter, tag]);

  /** Tags worth offering: the ones that actually narrow something, commonest
   *  first. A select of ninety one-off tags is not a filter, it is a haystack. */
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const s of all) for (const t of s.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  }, [all]);

  const filtered = srcFilter !== "all" || statusFilter !== "all" || !!tag || !!q.trim();
  const clearFilters = () => { setQ(""); setSrcFilter("all"); setStatusFilter("all"); setTag(""); };
  // Default follows the size of the library, but an explicit choice always wins.
  const view: Density = density ?? (all.length > ROWS_DEFAULT_AT ? "rows" : "cards");

  const installedCount = all.reduce((n, s) => n + s.installs.filter((i) => i.installed).length, 0);

  // The split the whole screen is organised around: what the user added versus
  // what shipped with Baton. Derived from `list` so search narrows both.
  // Bookmarked first within each band — that is the whole point of pinning.
  // Stable otherwise, so the list does not reshuffle on every poll.
  const pinnedFirst = (rows: SkillStatus[]) =>
    [...rows].sort((a, b) => Number(b.bookmarked) - Number(a.bookmarked));
  const mine = useMemo(() => pinnedFirst(list.filter((s) => isUserSkill(s.source))), [list]);
  const built = useMemo(() => pinnedFirst(list.filter((s) => !isUserSkill(s.source))), [list]);
  const mineTotal = all.filter((s) => isUserSkill(s.source)).length;
  const batonTotal = all.length - mineTotal;
  const taken = useMemo(() => new Set(all.filter((s) => isUserSkill(s.source)).map((s) => s.id)), [all]);
  const bundledIds = useMemo(() => new Set(all.filter((s) => !isUserSkill(s.source)).map((s) => s.id)), [all]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader
        title="Skills"
        subtitle={skills.isLoading ? "Loading catalog…" : `${(skills.data ?? []).length} skill${(skills.data ?? []).length === 1 ? "" : "s"} · ${installedCount} installed`}
      >
        <SearchInput value={q} onChange={setQ} placeholder="Search skills…" />
        {mineTotal > 0 && (
          <a className="btn btn-sm fr" href={BatonAPI.skillsExportUrl()} download
            data-tip={`Download all ${mineTotal} of your skills as one file — restore with \`baton skills restore\``}
            style={{ textDecoration: "none" }}>
            <Icon name="share" size={13} /> Export all
          </a>
        )}
        {writeEnabled && (
          <button className="btn btn-sm fr" onClick={() => setImporting((v) => !v)} data-tip="Upload a SKILL.md, or add one from a URL">
            <Icon name="plus" size={13} /> Add skill
          </button>
        )}
      </ScreenHeader>

      {/* Narrowing lives here, above the scroll, so it does not scroll away in a
          library where you actually need it. */}
      {all.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 20px", borderBottom: "1px solid var(--border-subtle)" }}>
          <Segmented<SourceFilter> label="Filter by who added it" value={srcFilter} onChange={setSrcFilter}
            options={[
              { value: "all", label: "All", count: all.length },
              { value: "mine", label: "Yours", count: mineTotal },
              { value: "baton", label: "Baton", count: batonTotal },
            ]} />
          <Segmented<StatusFilter> label="Filter by install state" value={statusFilter} onChange={setStatusFilter}
            options={[
              { value: "all", label: "Any" },
              { value: "installed", label: "Installed" },
              { value: "available", label: "Not yet" },
            ]} />
          {tags.length > 0 && (
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag"
              style={{ height: 28, padding: "0 8px", background: "var(--bg-input)", border: `1px solid ${tag ? "var(--accent-border)" : "var(--border-default)"}`, borderRadius: "var(--r-sm)", color: tag ? "var(--accent-text)" : "var(--text-tertiary)", fontSize: "var(--fs-12)", fontFamily: "inherit", outline: "none", maxWidth: 170 }}>
              <option value="">All tags</option>
              {tags.map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}
            </select>
          )}

          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            {filtered && (
              <>
                <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                  {list.length} of {all.length}
                </span>
                <button className="btn btn-sm fr" style={{ height: 26 }} onClick={clearFilters}>Clear</button>
              </>
            )}
            <Segmented<Density> label="How much detail to show" value={view} onChange={setDensity}
              options={[{ value: "cards", label: "Cards" }, { value: "rows", label: "List" }]} />
          </span>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {importing && writeEnabled && (
          <AddSkillPanel key={source} seedUrl={source} taken={taken} bundledIds={bundledIds}
            onAdded={skills.refetch} onClose={() => { setImporting(false); setSource(""); }} />
        )}


        {skills.error && !(skills.data ?? []).length ? (
          <ErrorState title="Couldn't load the skill catalog" desc={(skills.error as Error).message}
            command="baton serve" onRetry={skills.refetch} retrying={skills.isFetching} />
        ) : skills.isLoading && !(skills.data ?? []).length ? (
          <div style={SKILL_GRID}>
            {[0, 1, 2, 3].map((i) => <CardSkeleton key={i} />)}
          </div>
        ) : list.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 24px", textAlign: "center" }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
              <Icon name="command" size={20} style={{ color: "var(--text-tertiary)" }} />
            </span>
            {/* An empty library and a library you have filtered down to nothing
                are different situations. Telling someone with 84 skills that
                they have none is how a filter reads as a bug. */}
            <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)" }}>
              {filtered ? "Nothing matches those filters." : "No skills yet."}
            </div>
            {filtered ? (
              <>
                <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", maxWidth: 460, lineHeight: 1.6 }}>
                  {all.length} skill{all.length === 1 ? " is" : "s are"} in your catalog — none of them fit this combination.
                </p>
                <button className="btn btn-sm fr" onClick={clearFilters}>Clear filters</button>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", maxWidth: 460, lineHeight: 1.6 }}>Upload a SKILL.md, add one from a URL, or run a newer Baton with bundled skills.</p>
            )}
          </div>
        ) : (
          <>
            {/* Yours first: on a screen that is mostly Baton's own catalog, the
                handful you added are the ones you came here to find. */}
            {srcFilter !== "baton" && <SkillBand
              title="Your skills"
              view={view}
              count={mine.length}
              hint={mineTotal ? "Uploaded by you — in every project on this machine." : undefined}
              action={writeEnabled && (
                <button className="btn btn-sm fr" style={{ flex: "none", height: 26 }}
                  onClick={() => { setSource(""); setImporting(true); }}
                  data-tip="Upload a SKILL.md from this computer, or add one from a URL">
                  <Icon name="plus" size={12} /> Add skill
                </button>
              )}
              skills={mine}
              writeEnabled={writeEnabled}
              onChanged={skills.refetch}
              onOpen={setOpenId}
              empty={!q && mineTotal === 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 15px", background: "var(--bg-surface-2)", border: "1px dashed var(--border-default)", borderRadius: "var(--r-sm)" }}>
                  <Icon name="plus" size={15} style={{ color: "var(--text-quaternary)", flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
                    Nothing here yet. Upload a <span className="mono">SKILL.md</span> and it joins every project on this
                    machine — including ones you set up later. Find some at{" "}
                    <a href={SKILL_DIRECTORY_URL} target="_blank" rel="noreferrer noopener" style={{ color: "var(--accent-text)" }}>skills.sh</a>.
                  </span>
                  {writeEnabled && (
                    <button className="btn btn-sm fr" style={{ flex: "none" }} onClick={() => setImporting(true)}>Add skill</button>
                  )}
                </div>
              ) : undefined}
            />}
            {srcFilter !== "mine" && <SkillBand
              title="Baton skills"
              view={view}
              count={built.length}
              hint="Ship with Baton. Install them into any agent; they update when Baton does."
              skills={built}
              writeEnabled={writeEnabled}
              onChanged={skills.refetch}
              onOpen={setOpenId}
            />}
          </>
        )}

        {!q && starter && (
          <div className="card" style={{ padding: "15px 16px", display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flex: "none", background: "var(--clean-soft, var(--bg-surface-2))", border: "1px solid var(--border-subtle)", color: "var(--clean-text, var(--text-secondary))" }}>
              <Icon name="lock" size={15} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Starting a new project?</div>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <span className="mono" style={{ color: "var(--accent-text)" }}>{STARTER_ID}</span> asks a few plain-language
                questions, lays out an industry-standard folder structure, and installs the secret-leak protection —
                then proves it works by trying to commit a fake key.
              </div>
            </div>
            <button className="btn btn-sm fr" onClick={() => setQ(STARTER_ID)} data-tip="Show this skill" style={{ flex: "none" }}>
              Show
            </button>
          </div>
        )}

        {!q && featured.length > 0 && (
          <div className="card" style={{ padding: "15px 16px", display: "flex", flexDirection: "column", gap: 12, background: "var(--accent-soft)", border: "1px solid var(--accent-border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flex: "none", background: "var(--bg-base)", border: "1px solid var(--accent-border)", color: "var(--accent-text)" }}>
                <Icon name="zap" size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Efficiency &amp; traceability pack</div>
                <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                  Cut token cost and make every change traceable — so multi-agent work stays cheap and auditable.
                </div>
              </div>
              <span style={{ fontSize: "var(--fs-11)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)", background: "var(--bg-base)", border: "1px solid var(--accent-border)", borderRadius: 99, padding: "2px 9px", flex: "none" }}>New</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
              {featured.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setQ(f.id)}
                  data-tip="Show this skill"
                  style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 3, padding: "9px 11px", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", cursor: "pointer", color: "inherit" }}
                >
                  <span className="mono" style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)" }}>{f.id}</span>
                  <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.45 }}>{f.blurb}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!q && (
          <div className="card" style={{ padding: "15px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flex: "none", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}>
                <Icon name="share" size={15} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Community picks</div>
                <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                  Proven skills from the wider Claude ecosystem — click one to prefill the add form, then confirm.
                </div>
              </div>
              <a href={SKILL_DIRECTORY_URL} target="_blank" rel="noreferrer noopener" className="btn btn-sm fr"
                data-tip="Browse more skills at skills.sh, then upload the SKILL.md here"
                style={{ flex: "none", textDecoration: "none" }}>
                Browse more <Icon name="share" size={12} />
              </a>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 8 }}>
              {COMMUNITY_PICKS.filter((p) => !(skills.data ?? []).some((s) => s.id === p.name)).map((p) => (
                <button
                  key={p.url}
                  className="fr"
                  disabled={!writeEnabled}
                  data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : `From ${p.repo} — prefill import`}
                  onClick={() => { setImporting(true); setSource(p.url); }}
                  style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 3, padding: "9px 11px", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", cursor: writeEnabled ? "pointer" : "not-allowed", color: "inherit", opacity: writeEnabled ? 1 : 0.6 }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="mono" style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", color: "var(--text-primary)" }}>{p.name}</span>
                    <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--text-quaternary)", marginLeft: "auto" }}>{p.repo}</span>
                  </span>
                  <span style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.45 }}>{p.blurb}</span>
                  {p.heavy && (
                    <span style={{ display: "flex", gap: 5, alignItems: "flex-start", marginTop: 2, fontSize: "var(--text-micro)", lineHeight: 1.4, color: "var(--text-quaternary)" }}>
                      <Icon name="layers" size={10} style={{ flex: "none", marginTop: 2 }} />
                      {p.heavy}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Resolved from the live list rather than held as a snapshot, so the
          dialog reflects an install or a bookmark the moment it lands. If the
          skill disappears underneath it (deleted elsewhere), it closes. */}
      {openId && (() => {
        const open = (skills.data ?? []).find((s) => s.id === openId);
        if (!open) return null;
        return (
          <SkillDetail
            skill={open}
            writeEnabled={writeEnabled}
            onClose={() => setOpenId(null)}
            onChanged={skills.refetch}
            onDelete={() => { setOpenId(null); setPendingDelete(open); }}
            onBookmark={(on) => {
              void BatonAPI.bookmarkSkill(open.id, on)
                .then(skills.refetch)
                .catch((e) => showToast({ kind: "error", title: "Couldn't update the bookmark", desc: (e as Error).message }));
            }}
          />
        );
      })()}

      {/* Deleting from the dialog still routes through the same confirm the card
          uses — one destructive path, asked for once, worded the same way. */}
      <ConfirmDialog
        open={!!pendingDelete} busy={deletingId !== null}
        onClose={() => { setPendingDelete(null); setDeletingId(null); }}
        onConfirm={() => {
          if (!pendingDelete) return;
          setDeletingId(pendingDelete.id);
          void BatonAPI.removeSkill(pendingDelete.id)
            .then((r) => {
              showToast({ kind: "ok", title: `Deleted "${pendingDelete.name}"`, desc: r.unwired.length ? `Also unwired from ${r.unwired.join(", ")}.` : undefined });
              setPendingDelete(null); setDeletingId(null); skills.refetch();
            })
            .catch((e) => {
              showToast({ kind: "error", title: "Couldn't delete that skill", desc: (e as Error).message });
              setDeletingId(null);
            });
        }}
        tone="danger" icon="trash" confirmLabel="Delete skill"
        title={pendingDelete ? `Delete "${pendingDelete.name}"?` : ""}
        body={<>
          This removes it from your library and unwires it from every agent it was installed into.
          {" "}Nothing here can bring it back — <strong>download it first</strong> if you might want it again.
        </>} />
    </div>
  );
}

/** One titled group of skill cards. Renders nothing when it is empty and has
 *  no empty-state to show, so search never leaves a bare heading behind. */
function SkillBand({ title, count, hint, skills, view, writeEnabled, onChanged, onOpen, action, empty }: {
  title: string;
  count: number;
  hint?: string;
  skills: SkillStatus[];
  /** Cards to browse, rows to scan. Chosen once for the whole screen. */
  view: Density;
  writeEnabled: boolean;
  onChanged: () => void;
  onOpen: (id: string) => void;
  /** Rendered at the end of the heading row (e.g. "Add skill"). */
  action?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  if (!skills.length && !empty) return null;
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* nowrap here shredded the title on a phone: "Your skills" broke across
          two lines and its count split off. The title is the one thing that
          must stay whole, so it never shrinks and the row wraps instead. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--gap-sm)", paddingTop: 4 }}>
        <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: "var(--gap-sm)" }}>
          <Label>{title}</Label>
          {count > 0 && (
            <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--text-quaternary)", letterSpacing: "0.06em" }}>
              {String(count).padStart(2, "0")}
            </span>
          )}
        </span>
        {/* Beside the label, not pinned to the far edge: on a wide screen the
            two were a thousand pixels apart and stopped reading as one thought.
            Supplementary, so it steps out entirely rather than truncating to
            an unreadable stub on a phone. */}
        {hint && (
          <span className="hide-sm" style={{ fontSize: "var(--text-micro)", color: "var(--text-quaternary)", flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>
        )}
        <span style={rule} />
        {/* The add action lives WITH your skills, not only in the screen header.
            A header button scrolls out of reach and sits at the far edge of a
            wide window; the one place you reliably look for "add one of mine"
            is the heading that says these are yours. */}
        {action}
      </div>
      {skills.length ? (
        view === "rows" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {skills.map((s) => <SkillRow key={s.id} s={s} writeEnabled={writeEnabled} onChanged={onChanged} onOpen={onOpen} />)}
          </div>
        ) : (
          <div style={SKILL_GRID}>
            {skills.map((s) => <SkillCard key={s.id} s={s} writeEnabled={writeEnabled} onChanged={onChanged} onOpen={onOpen} />)}
          </div>
        )
      ) : empty}
    </section>
  );
}

function SkillCard({ s, writeEnabled, onChanged, onOpen }: { s: SkillStatus; writeEnabled: boolean; onChanged: () => void; onOpen: (id: string) => void }) {
  const [busy, setBusy] = useState<SkillAgent | "all" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const allInstalled = s.installs.length > 0 && s.installs.every((i) => i.installed);

  const doBookmark = async (on: boolean) => {
    try {
      await BatonAPI.bookmarkSkill(s.id, on);
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn't update the bookmark", desc: (e as Error).message });
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      const r = await BatonAPI.removeSkill(s.id);
      showToast({
        kind: "ok", title: `Deleted "${s.name}"`,
        desc: r.unwired.length ? `Also unwired from ${r.unwired.join(", ")}.` : undefined,
      });
      setConfirmDelete(false);
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn't delete that skill", desc: (e as Error).message });
      setDeleting(false);
    }
  };

  /* Richer skills carry 10+ produces and 8 reference files — rendered in full they bury the
     install controls below the fold. Cap both, expandable in one click. */
  const [expandChips, setExpandChips] = useState(false);
  const producesShown = expandChips ? s.produces : s.produces.slice(0, 5);
  const refsShown = expandChips ? s.references : s.references.slice(0, 4);
  const hiddenChips = s.produces.length - producesShown.length + (s.references.length - refsShown.length);

  async function toggle(agent: SkillAgent, installed: boolean) {
    setBusy(agent);
    try {
      if (installed) {
        await BatonAPI.uninstallSkill(s.id, agent);
        showToast({ kind: "info", title: `Removed "${s.name}"`, desc: `from ${getAgent(agent).short}` });
      } else {
        const r = await BatonAPI.installSkill(s.id, agent);
        showToast({ kind: "ok", title: `Installed "${s.name}"`, desc: r.references > 0 ? `${r.rel}  (+${r.references} reference file${r.references === 1 ? "" : "s"})` : r.rel, mono: true });
      }
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn’t update skill", desc: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function installAll() {
    setBusy("all");
    try {
      const results = await BatonAPI.installSkillEverywhere(s.id);
      showToast({ kind: "ok", title: `Installed "${s.name}" everywhere`, desc: `${results.length} agent${results.length === 1 ? "" : "s"}: ${results.map((r) => getAgent(r.agent).short).join(", ")}` });
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn’t install to all agents", desc: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // No `overflow: hidden` on the card. It used to clip the inline playbook,
  // which now lives in the detail dialog — and while it stayed, it also clipped
  // the [data-tip] tooltips, which render ABOVE their button (base.css) and so
  // fell outside the card for every control in the top row.
  return (
    <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "16px 18px 12px", display: "flex", flexDirection: "column", gap: 13 }}>
        {/* The shortcut is the identity: it is what a developer actually types.
            It used to sit under the prose name as 10.5px grey; the prose name is
            now the subtitle, and the accent is spent here and nowhere else. */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <button className="fr" onClick={() => onOpen(s.id)} data-tip="Open the full playbook and where it is installed"
              style={{ display: "block", width: "100%", textAlign: "left", padding: 0, background: "none", border: "none", cursor: "pointer" }}>
              <span className="mono" style={{ display: "block", fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis" }}>
                /{s.id}
              </span>
            </button>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
              {/* Only when it actually says something the shortcut doesn't.
                  "/api-conventions" over "api-conventions" is the same word twice. */}
              {slugifyShortcut(s.name) !== s.id && (
                <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{s.name}</span>
              )}
              {/* A legacy per-repo skill is the one case where "yours" is not the
                  whole story. Everything else is answered by which band it is in. */}
              {s.source === "imported" && (
                <span data-tip="Stored in this repo's .baton/skills, so it is only here. Re-add it to put it in your machine-wide library."
                  style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--dirty-text)" }}>
                  · this project only
                </span>
              )}
            </div>
          </div>
          <button className="btn btn-icon fr" disabled={!writeEnabled}
            aria-label={s.bookmarked ? `Remove the bookmark on ${s.id}` : `Bookmark ${s.id}`}
            aria-pressed={s.bookmarked}
            data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : s.bookmarked ? "Remove bookmark" : "Pin this to the top"}
            onClick={() => void doBookmark(!s.bookmarked)}
            style={{ flex: "none", color: s.bookmarked ? "var(--dirty-text)" : undefined }}>
            <Icon name={s.bookmarked ? "starFilled" : "star"} size={13} />
          </button>
          {isUserSkill(s.source) && (
            <a className="btn btn-icon fr" href={BatonAPI.skillFileUrl(s.id)} download={`${s.id}.md`}
              aria-label={`Download ${s.id}.md`}
              data-tip="Download this skill's markdown" style={{ flex: "none", textDecoration: "none" }}>
              <Icon name="share" size={13} />
            </a>
          )}
          {isUserSkill(s.source) && writeEnabled && (
            <button className="btn btn-icon fr" onClick={() => setConfirmDelete(true)}
              aria-label={`Delete the ${s.id} skill`}
              data-tip="Delete this skill, and unwire it from every agent" style={{ flex: "none" }}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>

        {s.explain ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {([["What", s.explain.what], ["How", s.explain.how], ["Win", s.explain.win]] as const).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ flex: "none", width: 30 }}>
                  <Label tone={k === "Win" ? "accent" : undefined}>{k}</Label>
                </span>
                <span style={{ fontSize: "var(--fs-12)", lineHeight: 1.55, color: "var(--text-secondary)" }}>{v}</span>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: "var(--fs-12)", lineHeight: 1.6, color: "var(--text-secondary)" }}>{s.description}</p>
        )}

        {s.produces.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Label>Produces</Label><span style={rule} />
            </div>
            {/* A quiet middot list, not pills: ten bordered chips on one card was
                the loudest thing on the screen and none of it is clickable. */}
            <div style={{ fontSize: "var(--fs-11)", lineHeight: 1.7, color: "var(--text-tertiary)" }}>
              {producesShown.join("  ·  ")}
            </div>
          </div>
        )}

        {s.references.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Label>Ships</Label>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", color: "var(--text-quaternary)" }}>
                {s.references.length} file{s.references.length === 1 ? "" : "s"}
              </span>
              <span style={rule} />
            </div>
            <div className="mono" data-tip="Installed alongside the skill, loaded on demand"
              style={{ fontSize: "var(--text-micro)", lineHeight: 1.7, color: "var(--text-tertiary)" }}>
              {refsShown.map((r) => r.replace(/^references\//, "")).join("  ·  ")}
            </div>
          </div>
        )}

        {(hiddenChips > 0 || expandChips) && (
          <button
            onClick={() => setExpandChips((v) => !v)}
            data-tip={expandChips ? "Show less" : "Show everything this skill produces and ships"}
            style={{ alignSelf: "flex-start", padding: 0, background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)" }}
          >
            {expandChips ? "Show less" : `+${hiddenChips} more`}
          </button>
        )}
      </div>

      {/* Wired into — the signature block.

          Baton's whole premise is several agents on one repo, so "which of my
          agents can already do this?" is the question this card exists to
          answer. It used to be three equally-loud buttons that all shouted
          "Add to …" whether or not the skill was already there. Now installed
          reads as held (agent colour, checked) and missing reads as available
          (ghosted), so the row is scannable before it is clickable. */}
      <div style={{ padding: "0 18px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Label tone={allInstalled ? "accent" : undefined}>Wired into</Label>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", color: "var(--text-quaternary)" }}>
            {s.installs.filter((i) => i.installed).length}/{s.installs.length}
          </span>
          <span style={rule} />
          {!allInstalled && writeEnabled && (
            <button
              className="fr"
              disabled={busy !== null}
              data-tip="Install this skill into every writable agent at once"
              onClick={installAll}
              style={{ flex: "none", padding: 0, background: "none", border: "none", cursor: busy ? "default" : "pointer", fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)" }}
            >
              {busy === "all" ? "Installing…" : "Add to all"}
            </button>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {s.installs.map((inst) => {
            const a = getAgent(inst.agent);
            return (
              <button
                key={inst.agent}
                className="fr"
                disabled={!writeEnabled || busy !== null}
                aria-pressed={inst.installed}
                data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : inst.installed ? `Installed at ${inst.rel} — click to remove` : `Write ${inst.rel}`}
                onClick={() => toggle(inst.agent, inst.installed)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6, height: 26, padding: "0 10px",
                  borderRadius: "var(--r-sm)", cursor: writeEnabled && !busy ? "pointer" : "default",
                  fontSize: "var(--fs-11)", fontWeight: "var(--fw-medium)", fontFamily: "inherit",
                  background: inst.installed ? `color-mix(in srgb, ${a.color} 12%, transparent)` : "transparent",
                  border: `1px solid ${inst.installed ? `color-mix(in srgb, ${a.color} 38%, transparent)` : "var(--border-subtle)"}`,
                  color: inst.installed ? "var(--text-primary)" : "var(--text-quaternary)",
                  opacity: writeEnabled ? 1 : 0.6,
                }}
              >
                <span style={{ opacity: inst.installed ? 1 : 0.45, display: "inline-flex" }}>
                  <AgentGlyph id={inst.agent} size={12} />
                </span>
                {/* The verb stays on the uninstalled state. A bare agent name
                    reads as a label, and a label does not tell you that
                    clicking it writes a file — which is the one thing this
                    control does. Installed drops it, because a tick plus the
                    name already says "it's here". */}
                {busy === inst.agent ? "…" : inst.installed ? a.short : `Add to ${a.short}`}
                {inst.installed && <Icon name="check" size={11} style={{ color: a.color }} />}
              </button>
            );
          })}
          <button className="fr" onClick={() => onOpen(s.id)} data-tip="Full playbook, install paths, and every file it ships"
            style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5, height: 26, padding: "0 6px", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "var(--text-micro)", letterSpacing: "0.08em", textTransform: "uppercase", fontWeight: "var(--fw-semibold)", color: "var(--text-tertiary)" }}>
            <Icon name="chevronRight" size={12} /> Details
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete} busy={deleting}
        onClose={() => { setConfirmDelete(false); setDeleting(false); }}
        onConfirm={() => void doDelete()}
        tone="danger" icon="trash" confirmLabel="Delete skill"
        title={`Delete "${s.name}"?`}
        body={<>
          This removes it from your library and unwires it from every agent it was installed into.
          {" "}Nothing here can bring it back — <strong>download it first</strong> if you might want it again.
        </>} />
    </div>
  );
}
