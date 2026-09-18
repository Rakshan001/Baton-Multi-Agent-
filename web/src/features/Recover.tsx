// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Recover lost work

   THE SCREEN THE REPORTER ASKED FOR, in their words: "one agent may be
   stopped in between so that worktree work will be paused, user will
   think that work is completed but that work will be lost if worktree is
   lost." This is the last line of defence for that.

   It reads `GET /api/doctor` — the junk audit — and INVERTS ITS FRAMING.
   src/cleanup.ts is written as things to delete; the person here needs
   things to rescue. Same data, opposite verb, and the verb decides which
   button is primary: RECOVER INTO A NEW TASK is the primary action on
   every row, delete is secondary, confirmed, and on most rows is not a
   button at all. features/recover.ts holds that reasoning and every
   decision this file renders.

   THREE THINGS THIS FILE REFUSES TO DO:

   1. Gate the READ. `auditJunk` never mutates, and someone hunting for
      work an agent left behind must be able to look at a read-only
      daemon. Only the two verbs are `writeEnabled`-gated, with the
      tooltip this codebase already uses (flow/panel.ts READ_ONLY_TIP).
   2. Render an unknown as a zero. A row whose commits nobody could count
      says so and sorts to the top; see the rules in features/recover.ts.
   3. Offer a one-click delete for the kinds the committed API can only
      delete in bulk. `POST /api/doctor/clean` acts on the WHOLE report,
      so those rows show the CLI command instead of a button that would
      take rows the reader never saw.
   ============================================================ */
import { useState } from "react";
import { Icon } from "../components/Icon";
import type { IconName } from "../components/Icon";
import {
  CardSkeleton, CommandLine, ConfirmDialog, EmptyState, ErrorState,
} from "../components/primitives";
import { READ_ONLY_TIP } from "../components/flow/panel";
import { useNodeMotion } from "../components/flow/useNodeMotion";
import { BatonAPI } from "../lib/api";
import type { DoctorReport, JunkItem } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import { ScreenHeader } from "./shared";
import type { Task, WorktreeRow } from "../types";
import {
  DISCARD_CLI, EXPOSURE_LABEL, RECOVER_CATEGORIES, buildStrandings, canDiscard,
  discardConsequence, exposureOf, recoverSteps, recoverTaskDescription, stakesOf,
  strandingsIn, type RecoverStep, type Stranding, type StrandingCategory,
} from "./recover";

const CATEGORY_META: Record<StrandingCategory, { title: string; icon: IconName; blurb: string }> = {
  worktree: {
    title: "Orphaned worktrees",
    icon: "folder",
    blurb:
      "A worktree nobody owns: either the task record outlived its directory, or the directory outlived its task. Whatever the agent was doing when it stopped is still in here.",
  },
  branch: {
    title: "Stranded branches",
    icon: "gitBranch",
    blurb:
      "A baton/* branch with no task and no live worktree. Its commits are real; nothing is pointing at them any more.",
  },
  snapshot: {
    title: "WIP snapshots",
    icon: "history",
    blurb:
      "refs/baton/wip/* — uncommitted work Baton snapshotted when a worktree went quiet. The ref lives in the repo's common store, so it survives the directory it was taken from. This is the only screen that can tell you it exists.",
  },
};

/* ---------- one stranding ---------- */
function StrandingRow({ s, writeEnabled, busy, onRecover, onDiscard }: {
  s: Stranding; writeEnabled: boolean; busy: boolean;
  onRecover: () => void; onDiscard: () => void;
}) {
  const exposure = exposureOf(s);
  const meta = EXPOSURE_LABEL[exposure];
  const tone =
    exposure === "nowhere-else" ? "var(--conflict)" : exposure === "unknown" ? "var(--dirty)" : "var(--text-tertiary)";
  const soft =
    exposure === "nowhere-else" ? "var(--conflict-soft)" : exposure === "unknown" ? "var(--dirty-soft)" : "var(--bg-surface-2)";

  return (
    <article style={{
      border: "1px solid var(--border-subtle)", borderRadius: "var(--r-md)", background: "var(--bg-surface)",
      padding: 11, display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
          {s.branch ?? s.slug ?? s.id}
        </span>
        {/* Whether it exists anywhere but this disk — the other half of the
            stakes, and the half a person cannot infer from a line count. */}
        <span data-tip={meta.tip} style={{
          fontSize: "var(--text-micro)", textTransform: "uppercase", letterSpacing: "var(--ls-wide)",
          padding: "1px 6px", borderRadius: 5, color: tone, background: soft, border: "1px solid var(--border-subtle)",
        }}>{meta.label}</span>
        {s.wipRef && s.category !== "snapshot" && (
          <span data-tip={`Its last uncommitted state is snapshotted at ${s.wipRef}, and listed under WIP snapshots below.`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-tertiary)" }}>
            <Icon name="history" size={11} /> snapshot
          </span>
        )}
        {s.blockedDirty && (
          <span data-tip="The audit refuses to delete this: it still holds uncommitted changes. That is work, not junk."
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--dirty)" }}>
            <Icon name="fileWarning" size={11} /> uncommitted
          </span>
        )}
      </div>

      {/* How much work is at risk. `stakesOf` never renders an unknown as 0. */}
      <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{stakesOf(s)}</span>

      {/* The daemon's own sentence for why this is unowned, unedited. */}
      <span style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>{s.reason}</span>

      {s.path && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-quaternary)", wordBreak: "break-all" }}>{s.path}</span>
      )}
      {s.category === "snapshot" && s.wipRef && (
        <span className="mono" style={{ fontSize: 11, color: "var(--text-quaternary)", wordBreak: "break-all" }}>{s.wipRef}</span>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <button
          className="btn btn-primary fr" onClick={onRecover} disabled={!writeEnabled || busy}
          data-tip={writeEnabled
            ? "Create a task to land this work in, and show the commands that graft it across"
            : READ_ONLY_TIP}
          style={{ height: 28, padding: "0 10px", fontSize: "var(--fs-12)" }}
        >
          <Icon name="plus" size={13} /> Recover into a new task
        </button>
        <span style={{ flex: 1 }} />
        {canDiscard(s) ? (
          <button
            className="btn fr" onClick={onDiscard} disabled={!writeEnabled || busy}
            data-tip={writeEnabled ? "Delete the stale task record and its branch — confirmed, and not undoable" : READ_ONLY_TIP}
            style={{ height: 28, padding: "0 9px", fontSize: 11, color: "var(--text-tertiary)" }}
          >
            <Icon name="trash" size={12} /> Delete
          </button>
        ) : (
          /* No per-item route exists for this kind, and the bulk one would take
             rows nobody looked at. So the command is shown, not run. */
          <span data-tip={`No endpoint deletes one of these on its own. \`${DISCARD_CLI}\` acts on the whole audit — read it first.`}
            className="mono" style={{ fontSize: 11, color: "var(--text-quaternary)" }}>
            {DISCARD_CLI}
          </span>
        )}
      </div>
    </article>
  );
}

/* ---------- one category ---------- */
function CategorySection({ category, rows, writeEnabled, busyId, onRecover, onDiscard }: {
  category: StrandingCategory; rows: Stranding[]; writeEnabled: boolean; busyId: string | null;
  onRecover: (s: Stranding) => void; onDiscard: (s: Stranding) => void;
}) {
  const meta = CATEGORY_META[category];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 9, minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "grid", placeItems: "center", width: 22, height: 22, borderRadius: 6, flex: "none", color: "var(--accent)", background: "var(--accent-soft)", border: "1px solid var(--border-subtle)" }}>
          <Icon name={meta.icon} size={13} />
        </span>
        <h2 style={{ margin: 0, fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{meta.title}</h2>
        <span className="mono" data-tip="Sorted by unmerged commits, most at risk first. An uncounted row ranks above a counted one." style={{
          fontSize: 11, padding: "1px 7px", borderRadius: 999, flex: "none",
          color: rows.length ? "var(--accent-text)" : "var(--text-tertiary)",
          background: rows.length ? "var(--accent-soft)" : "var(--bg-surface-2)", border: "1px solid var(--border-subtle)",
        }}>{rows.length}</span>
      </header>
      <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>{meta.blurb}</p>
      {rows.length === 0 ? (
        <div style={{ padding: 10, borderRadius: "var(--r-md)", border: "1px solid var(--border-subtle)", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          Nothing stranded here.
        </div>
      ) : (
        rows.map((s) => (
          <StrandingRow
            key={s.id} s={s} writeEnabled={writeEnabled} busy={busyId === s.id}
            onRecover={() => onRecover(s)} onDiscard={() => onDiscard(s)}
          />
        ))
      )}
    </section>
  );
}

/* ---------- the rescue steps, after a task has been created ---------- */
interface Rescue {
  stranding: Stranding;
  task: Task;
  steps: RecoverStep[];
}

function RescueCard({ rescue, onDismiss }: { rescue: Rescue; onDismiss: () => void }) {
  // The one transition on this screen, so it asks first — flow/useNodeMotion.ts
  // explains why this is a JS decision and not a CSS one.
  const mayAnimate = useNodeMotion();
  return (
    <div style={{
      border: "1px solid var(--accent-border, var(--border-strong))", borderRadius: "var(--r-lg)",
      background: "var(--bg-elevated)", padding: 14, display: "flex", flexDirection: "column", gap: 11,
      animation: mayAnimate ? "scale-in var(--dur-2) var(--ease-out)" : undefined,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="checkCircle" size={15} style={{ color: "var(--clean-text)", flex: "none" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>
          Task <span className="mono">{rescue.task.slug}</span> created
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn fr" onClick={onDismiss} style={{ height: 26, padding: "0 9px", fontSize: 11 }} aria-label="Dismiss the rescue steps">
          <Icon name="x" size={12} /> Dismiss
        </button>
      </div>
      {/* Said plainly, because the alternative is a screen that implies the work
          already moved. POST /api/tasks branches from the base and takes no
          source ref — see recoverSteps() in features/recover.ts. */}
      <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-normal)" }}>
        The worktree and branch are real and empty. Baton has no endpoint that grafts a stranded branch or snapshot into
        a new task, so these are the commands that finish the rescue — run them in order.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {rescue.steps.map((step, i) => (
          <div key={step.command} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{i + 1}. {step.why}</span>
            <CommandLine command={step.command} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- screen ---------- */
export function RecoverScreen({ writeEnabled }: { writeEnabled: boolean }) {
  /**
   * One poll, two reads, because the join needs both: `/api/doctor` says WHAT
   * is unowned and `/api/worktrees` is the only route that carries the commit
   * counts and the wip refs. A daemon older than the worktree route 404s it,
   * and losing the counts must not lose the list — so that read degrades to
   * null and every count reads unknown, which is exactly what it is.
   *
   * 30s, like the other audit-shaped screens: nothing here changes per second,
   * and each tick costs the daemon a `listWorktrees` plus a tmp scan.
   */
  const data = usePoll<{ report: DoctorReport; rows: WorktreeRow[] | null }>(async () => {
    const report = await BatonAPI.getDoctor();
    const rows = await BatonAPI.getWorktrees().catch(() => null);
    return { report, rows };
  }, { interval: 30000 });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRecover, setConfirmRecover] = useState<Stranding | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<Stranding | null>(null);
  const [rescue, setRescue] = useState<Rescue | null>(null);

  const strandings = buildStrandings(data.data?.report ?? null, data.data?.rows ?? null);
  const degraded = !!data.data && data.data.rows === null;

  async function recover(s: Stranding) {
    setBusyId(s.id);
    try {
      // Real, and write-gated by the daemon: this makes a git branch and a
      // worktree. In a hub with several sub-projects the daemon answers 400
      // naming the valid ids, and that sentence is what the toast shows —
      // guessing a project here would put the rescue in the wrong repo.
      const task = await BatonAPI.createTask(recoverTaskDescription(s));
      setRescue({ stranding: s, task, steps: recoverSteps(s, task.worktreePath) });
      showToast({ kind: "ok", title: `Created ${task.slug}`, desc: "Now run the rescue commands to bring the work across." });
      data.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn't create the rescue task", desc: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function discard(s: Stranding) {
    setBusyId(s.id);
    try {
      // `buildStrandings` only ever sets `junkKind` from a doctor item, and
      // `canDiscard` is what gated the button — so this item is the real one.
      const item: JunkItem = {
        kind: "orphan-worktree-task",
        id: s.slug ?? s.id,
        path: s.path,
        reason: s.reason,
        action: "remove the stale task entry + its branch",
        blocked: s.blockedDirty ? "dirty" : null,
        branch: s.branch ?? undefined,
      };
      await BatonAPI.discardStranding(item);
      showToast({ kind: "ok", title: `Deleted ${item.id}`, desc: "The task record and its branch are gone." });
      data.refetch();
    } catch (e) {
      // A 409 here carries the daemon's own DirtyWorktreeError sentence; it is
      // passed through rather than softened, because it is the refusal working.
      showToast({ kind: "error", title: "Couldn't delete that", desc: (e as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  if (data.error && !data.data) return <ErrorState onRetry={data.refetch} retrying={data.isFetching} />;

  return (
    <>
      <ScreenHeader
        title="Recover lost work"
        subtitle="Worktrees, branches and snapshots nobody is holding any more. Most unmerged commits first."
      >
        <button className="btn fr" onClick={data.refetch} disabled={data.isFetching} style={{ height: 32 }}
          data-tip="Re-run the audit now">
          <Icon name="refresh" size={14} /> Rescan
        </button>
      </ScreenHeader>

      {data.isLoading && !data.data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}><CardSkeleton /><CardSkeleton /></div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {rescue && <RescueCard rescue={rescue} onDismiss={() => setRescue(null)} />}

          {!writeEnabled && strandings.length > 0 && (
            /* Reads are not gated — looking for lost work must always be
               possible. Only the two verbs are. */
            <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--border-subtle)", background: "var(--bg-surface-2)" }}>
              <Icon name="lock" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                Read-only — you can look, but not recover. Start the daemon with <span className="mono">--write</span> to act on a row.
              </span>
            </div>
          )}

          {degraded && (
            /* An unreported degradation reads as "nothing at risk", which is the
               one thing this screen must never accidentally say. */
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "9px 12px", borderRadius: "var(--r-md)", border: "1px dashed var(--border-default)", background: "var(--bg-surface-2)" }}>
              <Icon name="alertTriangle" size={14} style={{ color: "var(--dirty)", flex: "none", marginTop: 1 }} />
              <span style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
                This daemon does not serve <span className="mono">/api/worktrees</span>, so nothing could count what exists
                only on this disk, and no snapshot can be listed. Every count below reads <em>unverified</em> — that is not
                the same as zero.
              </span>
            </div>
          )}

          {strandings.length === 0 ? (
            <EmptyState
              icon="checkCircle"
              title="Nothing is stranded"
              desc={<>Every worktree has a task, every <span className="mono">baton/*</span> branch has an owner, and no worktree went quiet holding uncommitted work.</>}
              command="baton doctor"
            />
          ) : (
            RECOVER_CATEGORIES.map((category) => (
              <CategorySection
                key={category} category={category} rows={strandingsIn(strandings, category)}
                writeEnabled={writeEnabled} busyId={busyId}
                onRecover={setConfirmRecover} onDiscard={setConfirmDiscard}
              />
            ))
          )}

          {/* The gap this screen cannot close, stated where someone hunting for
              a specific slug would otherwise conclude it never existed. */}
          <p style={{ margin: 0, fontSize: 11, color: "var(--text-quaternary)", lineHeight: "var(--lh-snug)" }}>
            Snapshots are listed for worktrees the daemon still has a task record for. A{" "}
            <span className="mono">refs/baton/wip/*</span> ref whose task was already deleted exists in the repo but is
            served by no route — find those with <span className="mono">git for-each-ref refs/baton/wip/</span>.
          </p>
        </div>
      )}

      {/* Recover is the primary verb, and it still asks — it makes a branch and
          a worktree, so it names both before it does. */}
      <ConfirmDialog
        open={!!confirmRecover}
        onClose={() => setConfirmRecover(null)}
        onConfirm={() => { const s = confirmRecover!; setConfirmRecover(null); void recover(s); }}
        title="Recover into a new task?"
        icon="plus"
        confirmLabel="Create rescue task"
        busy={!!busyId}
        body={confirmRecover && (
          <span>
            Creates a new task worktree to land{" "}
            <span className="mono" style={{ color: "var(--text-primary)" }}>
              {confirmRecover.branch ?? confirmRecover.wipRef ?? confirmRecover.slug}
            </span>{" "}
            in. Nothing is deleted, and nothing about the stranded work changes — the commands to graft it across appear
            next.
          </span>
        )}
      />

      {/* Delete names the consequence, in mono, and is never the easy click. */}
      <ConfirmDialog
        open={!!confirmDiscard}
        onClose={() => setConfirmDiscard(null)}
        onConfirm={() => { const s = confirmDiscard!; setConfirmDiscard(null); void discard(s); }}
        title="Delete this stranding?"
        tone="danger"
        icon="trash"
        confirmLabel="Delete permanently"
        busy={!!busyId}
        body={confirmDiscard && (
          <span>
            <span className="mono" style={{ color: "var(--text-primary)" }}>{confirmDiscard.slug}</span>
            {confirmDiscard.branch && (
              <> · <span className="mono" style={{ color: "var(--text-primary)" }}>{confirmDiscard.branch}</span></>
            )}
            <span style={{ display: "block", marginTop: 8, color: "var(--conflict-text)" }}>
              {discardConsequence(confirmDiscard)}
            </span>
            <span style={{ display: "block", marginTop: 8 }}>
              Recover it into a task first if there is any chance you want it.
            </span>
          </span>
        )}
      />
    </>
  );
}
