// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — code review screen

   Surfaces the durable three-axis review record (src/reviews.ts):
   Standards (repo conventions + smell baseline), Spec (does it match
   the issue/spec/handoff brief), Security (source-to-sink baseline).

   The one rule this screen exists to respect: THE AXES ARE NEVER
   MERGED AND NEVER CROSS-RANKED. A Standards nit and a Security hole
   are not comparable, so there is no combined total here — three
   columns, three counts, no "12 findings" headline anywhere.

   Every finding carries a mandatory citation, and resolution is
   addressed by the finding's stable id (never by array position — a
   re-review reorders them).
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import { ErrorState, CardSkeleton, EmptyState, ConfirmDialog } from "../components/primitives";
import { AgentGlyph } from "../lib/registry";
import { ScreenHeader, SearchInput } from "./shared";
import { BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import type { AgentId, ReviewAxis, ReviewFinding, ReviewRecord } from "../types";

const AXES: ReviewAxis[] = ["standards", "spec", "security"];

const AXIS_META: Record<ReviewAxis, { label: string; icon: IconName; color: string; soft: string; tip: string }> = {
  standards: {
    label: "Standards", icon: "layers", color: "var(--accent)", soft: "var(--accent-soft)",
    tip: "Repo conventions + the 12-smell baseline. Only this axis may claim a hard violation.",
  },
  spec: {
    label: "Spec", icon: "list", color: "var(--dirty)", soft: "var(--dirty-soft)",
    tip: "Does the change match the issue / spec / handoff brief — and nothing beyond it?",
  },
  security: {
    label: "Security", icon: "lock", color: "var(--conflict)", soft: "var(--conflict-soft)",
    tip: "Source-to-sink vulnerability baseline. Never ranked against the other axes.",
  },
};

const ROUTE_LABEL: Record<string, string> = {
  "fix-directly": "fix directly",
  "systematic-debugging": "→ systematic-debugging",
  "bug-fix": "→ bug-fix",
  "implement": "→ implement",
};

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ---------- one finding ---------- */
function FindingCard({ f, axis, writeEnabled, busy, onFix, onDismiss }: {
  f: ReviewFinding; axis: ReviewAxis; writeEnabled: boolean; busy: boolean;
  onFix: () => void; onDismiss: () => void;
}) {
  const meta = AXIS_META[axis];
  const resolved = f.status !== "open";
  return (
    <div style={{
      border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)", background: "var(--bg-surface)",
      padding: 11, display: "flex", flexDirection: "column", gap: 7, opacity: resolved ? 0.6 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
        <span style={{ flex: 1, fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", lineHeight: "var(--lh-snug)", textDecoration: f.status === "dismissed" ? "line-through" : "none" }}>
          {f.title}
        </span>
        {f.hard && (
          <span className="mono" data-tip="A documented-standard breach, not a judgement call — the only kind that may be hard" style={{
            flex: "none", fontSize: 10, textTransform: "uppercase", letterSpacing: "var(--ls-wide)", padding: "1px 6px",
            borderRadius: 5, color: "var(--conflict)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)",
          }}>hard</span>
        )}
      </div>

      {(f.file || f.line !== undefined) && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
          {f.file}{f.line !== undefined ? `:${f.line}` : ""}
        </span>
      )}

      {/* The citation is mandatory in the store — an uncited finding is an
          opinion — so it is always shown, never behind a disclosure. */}
      <div style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 11, color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
        <Icon name="link" size={12} style={{ flex: "none", marginTop: 1 }} />
        <span className="mono" style={{ wordBreak: "break-word" }}>{f.source}</span>
      </div>

      {f.detail && (
        <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-normal)" }}>{f.detail}</p>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {f.route && (
          <span className="mono" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 5, color: meta.color, background: meta.soft, border: "1px solid var(--border-subtle)" }}>
            {ROUTE_LABEL[f.route] ?? f.route}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {resolved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-tertiary)" }}>
            <Icon name={f.status === "fixed" ? "checkCircle" : "x"} size={12} />
            {f.status}
          </span>
        ) : (
          <>
            <button
              className="btn fr" onClick={onDismiss} disabled={!writeEnabled || busy}
              data-tip={writeEnabled ? "Not a problem — dismissal survives a re-review" : "Read-only: start the daemon with --write"}
              style={{ height: 26, padding: "0 9px", fontSize: 11 }}
            >
              Dismiss
            </button>
            <button
              className="btn btn-primary fr" onClick={onFix} disabled={!writeEnabled || busy}
              data-tip={writeEnabled ? "Mark fixed — reverts to open if a re-review still reports it" : "Read-only: start the daemon with --write"}
              style={{ height: 26, padding: "0 9px", fontSize: 11 }}
            >
              <Icon name="check" size={12} /> Fix
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- one axis column ---------- */
function AxisColumn({ axis, findings, openCount, skip, writeEnabled, busyId, onFix, onDismiss }: {
  axis: ReviewAxis; findings: ReviewFinding[]; openCount: number; skip?: string;
  writeEnabled: boolean; busyId: string | null;
  onFix: (f: ReviewFinding) => void; onDismiss: (f: ReviewFinding) => void;
}) {
  const meta = AXIS_META[axis];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ display: "grid", placeItems: "center", width: 22, height: 22, borderRadius: 6, color: meta.color, background: meta.soft, border: "1px solid var(--border-subtle)", flex: "none" }}>
          <Icon name={meta.icon} size={13} />
        </span>
        <span data-tip={meta.tip} style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{meta.label}</span>
        <span className="mono" data-tip="Open findings on this axis. Axes are never summed." style={{
          fontSize: 11, padding: "1px 7px", borderRadius: 999, flex: "none",
          color: openCount ? meta.color : "var(--text-tertiary)",
          background: openCount ? meta.soft : "var(--bg-surface-2)", border: "1px solid var(--border-subtle)",
        }}>{openCount}</span>
      </header>

      {skip ? (
        /* An unreported skip reads as a clean pass, so say it loudly. */
        <div style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: 10, borderRadius: "var(--r-md)", border: "1px dashed var(--border-default)", background: "var(--bg-surface-2)" }}>
          <Icon name="alertTriangle" size={13} style={{ color: "var(--dirty)", flex: "none", marginTop: 1 }} />
          <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
            <strong style={{ fontWeight: "var(--fw-semibold)" }}>Not run</strong> — {skip}. This is not a pass.
          </span>
        </div>
      ) : findings.length === 0 ? (
        <div style={{ padding: 10, borderRadius: "var(--r-md)", border: "1px solid var(--border-subtle)", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          No findings on this axis.
        </div>
      ) : (
        findings.map((f) => (
          <FindingCard
            key={f.id} f={f} axis={axis} writeEnabled={writeEnabled} busy={busyId === f.id}
            onFix={() => onFix(f)} onDismiss={() => onDismiss(f)}
          />
        ))
      )}
    </section>
  );
}

/* ---------- one review record ---------- */
function ReviewCard({ rec, writeEnabled, busyId, showResolved, onFix, onDismiss }: {
  rec: ReviewRecord; writeEnabled: boolean; busyId: string | null; showResolved: boolean;
  onFix: (rec: ReviewRecord, f: ReviewFinding) => void;
  onDismiss: (rec: ReviewRecord, f: ReviewFinding) => void;
}) {
  const skips = new Map(rec.skipped.map((s) => [s.axis, s.why]));
  const byAxis = (axis: ReviewAxis) =>
    rec.findings.filter((f) => f.axis === axis && (showResolved || f.status === "open"));

  return (
    <article style={{ border: "1px solid var(--border-default)", borderRadius: "var(--r-lg)", background: "var(--bg-elevated)", overflow: "hidden" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", padding: "11px 14px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface)" }}>
        <span className="mono" style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{rec.slug}</span>
        <span className="mono" data-tip="What HEAD was compared against" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
          {rec.fixedPoint} → {rec.head.slice(0, 7)}
        </span>
        {rec.stale && (
          <span data-tip="HEAD moved since this review — the findings are about an older diff. Re-review to refresh." style={{
            display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "1px 7px", borderRadius: 5,
            color: "var(--dirty)", background: "var(--dirty-soft)", border: "1px solid var(--border-subtle)",
          }}>
            <Icon name="clock" size={11} /> stale
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* Who ran it, not just what ran it — a finding is a claim you may need
            to go ask someone about. Pre-author records say "unknown", which is
            no information, so they show the agent glyph alone as before. */}
        {rec.author && rec.author !== "unknown" && (
          <span data-tip={`Reviewed by ${rec.author}`} style={{
            fontSize: 11, color: "var(--text-tertiary)", maxWidth: 180,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {rec.author}
          </span>
        )}
        {rec.agent && <AgentGlyph id={rec.agent as AgentId} size={16} />}
        <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{ago(rec.updatedAt)}</span>
      </header>

      {rec.partial && (
        /* A silent partial review reads as a clean one. */
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 14px", background: "var(--dirty-soft)", borderBottom: "1px solid var(--border-subtle)" }}>
          <Icon name="fileWarning" size={14} style={{ color: "var(--dirty)", flex: "none", marginTop: 1 }} />
          <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
            <strong style={{ fontWeight: "var(--fw-semibold)" }}>Partial review</strong> — {rec.partial}. Unreviewed code is not clean code.
          </span>
        </div>
      )}

      {/* Three columns, never merged. Stacks on narrow viewports. */}
      <div className="review-axes" style={{ display: "grid", gap: 14, padding: 14 }}>
        {AXES.map((axis) => (
          <AxisColumn
            key={axis} axis={axis} findings={byAxis(axis)} openCount={rec.open?.[axis] ?? 0}
            skip={skips.get(axis)} writeEnabled={writeEnabled} busyId={busyId}
            onFix={(f) => onFix(rec, f)} onDismiss={(f) => onDismiss(rec, f)}
          />
        ))}
      </div>
    </article>
  );
}

/* ---------- screen ---------- */
export function ReviewsScreen({ writeEnabled, searchSeed }: { writeEnabled: boolean; searchSeed?: { q: string; n: number } }) {
  const data = usePoll<{ reviews: ReviewRecord[]; head: string }>(() => BatonAPI.getReviews(), { interval: 30000 });
  const reviews = data.data?.reviews ?? [];

  const [q, setQ] = useState(searchSeed?.q ?? "");
  useEffect(() => { if (searchSeed) setQ(searchSeed.q); }, [searchSeed?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [showResolved, setShowResolved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ rec: ReviewRecord; f: ReviewFinding } | null>(null);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return reviews;
    return reviews
      .map((r) => ({
        ...r,
        findings: r.findings.filter((f) =>
          `${r.slug} ${f.title} ${f.file ?? ""} ${f.source} ${f.detail ?? ""} ${f.axis}`.toLowerCase().includes(needle)),
      }))
      .filter((r) => r.findings.length > 0 || r.slug.toLowerCase().includes(needle));
  }, [reviews, q]);

  /** Resolve by stable id. Refetch rather than patch state: the server is the
   *  authority on the resulting per-axis counts and staleness. */
  async function resolve(rec: ReviewRecord, f: ReviewFinding, dismiss: boolean) {
    setBusyId(f.id);
    try {
      await BatonAPI.resolveReviewFinding(rec.slug, f.id, dismiss);
      showToast({ kind: "ok", title: dismiss ? "Finding dismissed" : "Finding marked fixed", desc: f.title });
      data.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Could not resolve finding", desc: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  if (data.error && !data.data) return <ErrorState onRetry={data.refetch} retrying={data.isFetching} />;

  const totalOpen = reviews.reduce((n, r) => n + r.findings.filter((f) => f.status === "open").length, 0);
  const hasResolved = reviews.some((r) => r.findings.some((f) => f.status !== "open"));

  return (
    <>
      <ScreenHeader
        title="Code review"
        subtitle="Three axes, never merged: Standards, Spec, Security. Every finding carries its citation."
      >
        <SearchInput value={q} onChange={setQ} placeholder="Search findings, files, citations…" />
        {hasResolved && (
          <button className="btn fr" onClick={() => setShowResolved((v) => !v)}
            data-tip="Fixed and dismissed findings are hidden by default"
            style={{ height: 32 }}>
            <Icon name={showResolved ? "check" : "filter"} size={14} />
            {showResolved ? "Resolved shown" : "Show resolved"}
          </button>
        )}
      </ScreenHeader>

      {data.isLoading && !data.data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}><CardSkeleton /><CardSkeleton /></div>
      ) : reviews.length === 0 ? (
        <EmptyState
          icon="fileWarning"
          title="No reviews recorded yet"
          desc={<>Run the bundled <span className="mono">code-review</span> skill on a task, or save one from the CLI. Findings land in <span className="mono">.baton/reviews/</span> and appear here.</>}
          command="baton review save <slug>"
        />
      ) : visible.length === 0 ? (
        <EmptyState icon="search" title="No findings match" desc="Try a different term, or clear the search." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {!writeEnabled && totalOpen > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--border-subtle)", background: "var(--bg-surface-2)" }}>
              <Icon name="lock" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                Read-only — triage is disabled. Start the daemon with <span className="mono">--write</span> to fix or dismiss findings.
              </span>
            </div>
          )}
          {visible.map((rec) => (
            <ReviewCard
              key={rec.slug} rec={rec} writeEnabled={writeEnabled} busyId={busyId} showResolved={showResolved}
              onFix={(r, f) => resolve(r, f, false)}
              onDismiss={(r, f) => setConfirm({ rec: r, f })}
            />
          ))}
        </div>
      )}

      {/* Dismissal is confirmed because, unlike `fixed`, it SURVIVES a re-review
          — the finding will not come back to ask again. */}
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => { const c = confirm!; setConfirm(null); void resolve(c.rec, c.f, true); }}
        title="Dismiss this finding?"
        tone="warn"
        icon="x"
        confirmLabel="Dismiss"
        busy={!!busyId}
        body={confirm && (
          <>
            <span style={{ fontWeight: "var(--fw-medium)" }}>{confirm.f.title}</span>
            <br />
            Dismissing says “this is not a problem”. Unlike <em>fixed</em>, it survives a re-review — the finding will not be reported again.
          </>
        )}
      />
    </>
  );
}
