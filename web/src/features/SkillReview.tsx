// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — the imported-skill review screen

   The one place in the dashboard where hostile content is put on
   the display on purpose.

   A downloaded skill becomes the agent's OWN instructions:
   `installSkill` writes it to `.claude/skills/<id>/SKILL.md`, where
   the harness loads it as directive text. Baton fences untrusted
   text everywhere else and deliberately cannot here, so the defence
   is a person reading the skill — and this screen's whole job is to
   make reading it the easy path and installing it unread the
   deliberate one.

   Three rules it is built around:

   1. **Never rendered as markup.** Every byte of skill content goes
      through React children into a <pre>, which escapes. No
      dangerouslySetInnerHTML, no markdown renderer, not now and not
      as a "nicer preview" later.
   2. **Findings sit BESIDE the content, never in place of it.** They
      are a reading aid; the scanner cannot decide intent, so a short
      findings list is not permission to skip the file.
   3. **Release binds to the hash that was on screen.** The daemon
      re-checks it and answers 409 if the skill changed — which is a
      re-read, not a retry.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Sheet } from "../components/primitives";
import { ApiError, BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import {
  CATEGORY_LABEL, CONTEXT_LABEL, HELD_EXPLAINER, HELD_TIP, RELEASE_CONFIRM,
  findingsByFile, gutterFor, orderFindings, pickHeld, reviewNote,
} from "../lib/quarantine";
import type { HeldSkill, QuarantineView, ScanFindingRow } from "../types";

/** Rows of skill content rendered at once. Everything beyond this is one
 *  scroll away in the same pane — the cap is on DOM, never on what is shown. */
const PANE_MAX_HEIGHT = 420;

const toneOf = (f: ScanFindingRow) =>
  f.severity === "high"
    ? { text: "var(--conflict-text)", soft: "var(--conflict-soft)", border: "var(--conflict-border)" }
    : { text: "var(--dirty-text)", soft: "var(--dirty-soft)", border: "var(--dirty-border)" };

/**
 * The one "Held — review" control, used by the catalog row, the catalog card and
 * the detail dialog.
 *
 * Shared because it is a security affordance: three hand-copied variants are
 * three chances for one to drift into wording that sounds more permissive than
 * the other two.
 */
export function HeldButton({ onClick, style }: { onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button className="btn btn-sm fr" onClick={onClick} data-tip={HELD_TIP}
      style={{ flex: "none", borderColor: "var(--conflict-border)", color: "var(--conflict-text)", ...style }}>
      Held — review
    </button>
  );
}

/** One row of exclusive picks. Same widget for the file tabs and the skill tabs. */
function TabStrip<T>({ items, isActive, onPick, label, count }: {
  items: T[];
  isActive: (item: T) => boolean;
  onPick: (item: T, i: number) => void;
  label: (item: T) => string;
  /** Findings on that item, if any — the reason to look at it first. */
  count: (item: T) => number;
}) {
  if (items.length < 2) return null;
  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {items.map((item, i) => {
        const on = isActive(item);
        const n = count(item);
        return (
          <button key={label(item)} className="btn btn-sm fr" onClick={() => onPick(item, i)} aria-pressed={on}
            style={{
              height: 26, borderColor: on ? "var(--accent-border)" : "var(--border-default)",
              color: on ? "var(--accent-text)" : "var(--text-tertiary)",
            }}>
            <span className="mono" style={{ fontSize: "var(--text-micro)" }}>{label(item)}</span>
            {n > 0 && <span style={{ marginLeft: 5, fontSize: "var(--text-micro)", color: "var(--conflict-text)" }}>{n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The "N held" banner. Lives above the catalog so a held skill is not something
 * you have to go looking for.
 */
export function HeldBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count === 0) return null;
  return (
    <div className="card" style={{
      padding: "13px 15px", display: "flex", alignItems: "center", gap: 11,
      background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)",
    }}>
      <span style={{
        width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flex: "none",
        background: "var(--bg-base)", border: "1px solid var(--conflict-border)", color: "var(--conflict-text)",
      }}>
        <Icon name="lock" size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>
          {count} skill{count === 1 ? " is" : "s are"} held until you read {count === 1 ? "it" : "them"}
        </div>
        <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {HELD_EXPLAINER}
        </div>
      </div>
      <button className="btn btn-sm fr" style={{ flex: "none" }} onClick={onOpen}
        data-tip="Read what is waiting, then decide">
        Review
      </button>
    </div>
  );
}

/** One scanner hit — the line it is on, what matched, and where it sits. */
function Finding({ f, onGo }: { f: ScanFindingRow; onGo: () => void }) {
  const tone = toneOf(f);
  // A fenced or negated match is still shown — suppressing them would make
  // "wrap it in backticks" the bypass — but it reads quieter, because it is.
  const quiet = f.context !== "imperative";
  return (
    <button onClick={onGo} className="fr" style={{
      display: "flex", alignItems: "flex-start", gap: 9, width: "100%", textAlign: "left",
      padding: "8px 10px", background: quiet ? "var(--bg-surface-2)" : tone.soft,
      border: `1px solid ${quiet ? "var(--border-subtle)" : tone.border}`,
      borderRadius: "var(--r-sm)", cursor: "pointer", font: "inherit", color: "inherit",
    }}>
      <span className="mono" style={{
        flex: "none", minWidth: 44, textAlign: "right", fontSize: "var(--text-micro)",
        color: quiet ? "var(--text-quaternary)" : tone.text, paddingTop: 2,
        fontVariantNumeric: "tabular-nums",
      }}>
        :{f.line}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: "block", fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)",
          color: quiet ? "var(--text-secondary)" : tone.text,
        }}>
          {CATEGORY_LABEL[f.category]}
        </span>
        <span className="mono" style={{
          display: "block", fontSize: "var(--text-micro)", color: "var(--text-tertiary)",
          marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {f.excerpt}
        </span>
        <span style={{ display: "block", fontSize: "var(--text-micro)", color: "var(--text-quaternary)", marginTop: 3 }}>
          {CONTEXT_LABEL[f.context]}
        </span>
      </span>
    </button>
  );
}

/**
 * One held skill: what it is, what matched, and all of it, readable.
 *
 * Files are paged rather than concatenated. A skill may carry up to 200 files
 * of up to 256 KB each, and mounting that as one pane would hang the tab — but
 * every file is listed with its size and its finding count, so paging hides
 * nothing. Nothing here truncates a file's text.
 */
function Review({ skill, writeEnabled, onReleased }: {
  skill: HeldSkill; writeEnabled: boolean; onReleased: () => void;
}) {
  const files = useMemo(() => findingsByFile(skill.files, skill.findings), [skill]);
  /* Sorted here rather than trusted from the response: the order a reviewer
     walks the file must not depend on the payload arriving as expected. */
  const ordered = useMemo(() => orderFindings(skill.findings), [skill]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  /** The element that actually scrolls vertically — the wrapper, not either
   *  <pre>: the panes size to their content and the wrapper clips them. */
  const wrapRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  /** A jump waiting for the target file to be on screen. `n` re-fires a jump to
   *  the same line, which otherwise looks like a dead click. */
  const [jump, setJump] = useState<{ line: number; n: number } | null>(null);

  // A different skill is a different review: never carry a file selection, a
  // pending jump, or an in-flight state across.
  useEffect(() => { setActive(0); setJump(null); setBusy(false); }, [skill.id, skill.hash]);

  const file = files[active];

  /* Scrolling happens in an effect, not in the click handler: selecting another
     file re-renders, and a handler that scrolled immediately would be measuring
     the file the reader just left. */
  useEffect(() => {
    if (!jump) return;
    const wrap = wrapRef.current;
    const gutter = gutterRef.current;
    if (!wrap || !gutter || !file) return;
    // Row height from the gutter itself rather than a hardcoded line-height:
    // one measurement that cannot drift out of step with the CSS.
    const rowH = gutter.scrollHeight / Math.max(1, file.lines);
    wrap.scrollTop = Math.max(0, (jump.line - 1) * rowH - 40);
  }, [jump, active, file]);

  /** Show a finding's line: switch to its file if needed, then scroll to it. */
  const goTo = (rel: string, line: number) => {
    const i = files.findIndex((f) => f.rel === rel);
    if (i >= 0 && i !== active) setActive(i);
    setJump((j) => ({ line, n: (j?.n ?? 0) + 1 }));
  };

  const release = async () => {
    setBusy(true);
    try {
      await BatonAPI.releaseHeldSkill(skill.id, skill.hash);
      showToast({ kind: "ok", title: `Released ${skill.id}`, desc: "Agents can now be given this skill." });
      onReleased();
    } catch (e) {
      const err = e as ApiError;
      // 409 is not a retry. The bytes changed between being shown and being
      // approved, so the approval would cover something nobody read.
      const changed = err instanceof ApiError && (err.code === "CONFLICT" || err.status === 409);
      showToast({
        kind: "error",
        title: changed ? "This skill changed while you were reading it" : "Couldn't release that skill",
        desc: changed ? "Re-read it — the version you approved is not the one on disk." : err.message,
      });
      onReleased(); // refetch either way, so the screen stops showing a stale hash
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)" }}>
            /{skill.id}
          </span>
          <span style={{ fontSize: "var(--text-micro)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-quaternary)" }}>
            {skill.source}
          </span>
          <span className="mono" style={{ fontSize: "var(--text-micro)", color: "var(--text-quaternary)" }}
            data-tip="Release approves this exact content, not the name">
            {skill.hash.slice(0, 12)}
          </span>
        </div>
        <p style={{ margin: "5px 0 0", fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {reviewNote(skill.findings)}
        </p>
      </div>

      {ordered.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {ordered.map((f, i) => (
            <Finding key={`${f.file}:${f.line}:${f.category}:${i}`} f={f} onGo={() => goTo(f.file, f.line)} />
          ))}
        </div>
      )}

      <TabStrip items={files} isActive={(f) => f === file} onPick={(_f, i) => setActive(i)}
        label={(f) => f.rel} count={(f) => f.findings.length} />

      {file && (
        <div style={{ border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", overflow: "hidden" }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
            background: "var(--bg-surface-2)", borderBottom: "1px solid var(--border-subtle)",
          }}>
            <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "var(--text-micro)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>
              {file.rel}
            </span>
            <span className="mono" style={{ flex: "none", fontSize: "var(--text-micro)", color: "var(--text-quaternary)", fontVariantNumeric: "tabular-nums" }}>
              {file.missing ? "not in this payload" : `${file.lines} lines · ${file.bytes} B`}
            </span>
          </div>
          {/* Two <pre>s of the same string split the same way, so the gutter and
              the text cannot drift apart. Content reaches the DOM as a text
              child: React escapes it, and nothing here ever renders markup. */}
          <div ref={wrapRef} style={{ display: "flex", maxHeight: PANE_MAX_HEIGHT, overflow: "auto", background: "var(--bg-input)" }}>
            <pre ref={gutterRef} aria-hidden="true" className="mono" style={{
              margin: 0, padding: "10px 8px 10px 10px", flex: "none", textAlign: "right",
              fontSize: "var(--text-micro)", lineHeight: 1.6, color: "var(--text-quaternary)",
              userSelect: "none", background: "var(--bg-surface-2)", fontVariantNumeric: "tabular-nums",
            }}>{gutterFor(file.content)}</pre>
            <pre className="mono" style={{
              margin: 0, padding: "10px 12px", flex: 1, minWidth: 0, overflowX: "auto",
              fontSize: "var(--text-micro)", lineHeight: 1.6, color: "var(--text-primary)",
              whiteSpace: "pre", tabSize: 2,
            }}>{file.content}</pre>
          </div>
        </div>
      )}

      <div style={{
        display: "flex", alignItems: "center", gap: 11, padding: "11px 12px",
        background: "var(--bg-surface-2)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
      }}>
        <p style={{ flex: 1, minWidth: 0, margin: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: 1.55 }}>
          {RELEASE_CONFIRM}
        </p>
        <button className="btn btn-sm fr" disabled={!writeEnabled || busy} onClick={() => void release()}
          data-tip={writeEnabled ? "Approves this exact content" : "Read-only — start the daemon with --write to release a skill"}
          style={{
            flex: "none", borderColor: writeEnabled ? "var(--accent-border)" : undefined,
            color: writeEnabled ? "var(--accent-text)" : undefined,
          }}>
          {busy ? "Releasing…" : "I've read this — release"}
        </button>
      </div>
    </div>
  );
}

/** The review sheet: what is held, one skill at a time. */
export function SkillReviewSheet({ open, focusId, onClose, view, writeEnabled, onReleased }: {
  open: boolean;
  /** The skill the reader asked to see. Opening on a DIFFERENT one than they
   *  clicked is the whole failure this prop exists to prevent: the release
   *  button would then approve content they had not asked for. */
  focusId: string | null;
  onClose: () => void; view: QuarantineView | null;
  writeEnabled: boolean; onReleased: () => void;
}) {
  const held = view?.held ?? [];
  /** A tab picked inside the sheet; null means "whatever they opened it on". */
  const [picked, setPicked] = useState<string | null>(null);
  // Cleared whenever the sheet is opened afresh, so a stale pick from a previous
  // visit can never outrank the skill just clicked.
  useEffect(() => { setPicked(null); }, [open, focusId]);

  const current = pickHeld(held, focusId, picked);

  return (
    <Sheet open={open} onClose={onClose} labelledBy="skill-review-title" width={860}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)", flex: "none" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div id="skill-review-title" style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>
            Read before installing
          </div>
          <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
            {/* The daemon's own wording, shown verbatim: one place decides how
                this is phrased, and it is the side that ran the scan. */}
            {view?.note ?? "Scanned, not verified."}
          </div>
        </div>
        <button className="btn btn-icon fr" onClick={onClose} aria-label="Close the review">
          <Icon name="x" size={13} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {held.length === 0 ? (
          <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", lineHeight: 1.6 }}>
            Nothing is waiting on you. A skill lands here when you import one — Baton holds it until you have read it.
          </p>
        ) : (
          <>
            <TabStrip items={held} isActive={(h) => h.id === current?.id} onPick={(h) => setPicked(h.id)}
              label={(h) => `/${h.id}`} count={(h) => h.findings.length} />
            {current && <Review skill={current} writeEnabled={writeEnabled} onReleased={onReleased} />}
          </>
        )}
      </div>
    </Sheet>
  );
}
