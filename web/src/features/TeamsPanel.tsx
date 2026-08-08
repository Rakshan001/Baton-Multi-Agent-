// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Teams: grouping over members.

   The dashboard face of src/teams.ts. Read that file's header before
   changing anything here; the short version is the sentence this
   screen repeats in three places and must never stop repeating:

     A team groups people and filters this view. It is not a
     permission. Every member token still reaches every project on
     this hub, and every member still has a full clone of every repo.

   The one behaviour that is not negotiable: a CONFLICT is never
   filtered out. Two members on one file on one branch is the whole
   reason the federation plane exists, and a team filter that could
   hide one would be a filter that costs data rather than noise.
   `visibleGroups` below enforces that, and says so where it does.
   ============================================================ */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { ConfirmDialog, EmptyState } from "../components/primitives";
import { BatonAPI, ApiError } from "../lib/api";
import { showToast } from "../lib/toast";
import { parseProjects } from "../lib/teams";
import type { MemberRow, Team } from "../types";

// Re-exported so the Team screen has one import for the whole feature; the
// implementations live in lib/ because they are pure and worth testing there.
export { groupMembersByTeam, teamCovers, visibleGroups, parseProjects } from "../lib/teams";

/** Style shared by every text input on this panel. */
const inputStyle: React.CSSProperties = {
  height: 30, padding: "0 10px", background: "var(--bg-input)",
  border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)",
  color: "var(--text-primary)", fontSize: "var(--fs-13)", outline: "none",
};

export function TeamFilter({ teams, value, onChange }: {
  teams: Team[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  if (!teams.length) return null;
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
      <Icon name="filter" size={13} />
      <span>Team</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}
        style={{ ...inputStyle, height: 28, fontSize: "var(--fs-12)" }}>
        <option value="">Everyone</option>
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}

/** The team a member is in, as an owner control. */
export function TeamPicker({ teams, value, disabled, onChange }: {
  teams: Team[];
  value: string | null;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  if (!teams.length) return null;
  return (
    <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}
      data-tip={disabled
        ? "Owner controls need a writable daemon — restart with `baton serve --write`."
        : "Moves them between groups. It does not change what they can reach."}
      style={{ ...inputStyle, height: 28, fontSize: "var(--fs-12)", maxWidth: 150, opacity: disabled ? 0.5 : 1 }}>
      <option value="">No team</option>
      {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  );
}

/* ---------- Scope ---------- */

function ScopeChips({ team, knownProjects }: { team: Team; knownProjects: string[] }) {
  if (!team.projects.length) {
    return <span style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}>whole hub</span>;
  }
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
      {team.projects.map((p) => {
        // Unknown ids are kept, not dropped (src/teams.ts) — a scope naming a
        // project that has not been added yet is a plan, not an error. Flagged
        // so it is a decision rather than a surprise.
        const known = knownProjects.length === 0 || knownProjects.includes(p);
        return (
          <span key={p} className="tag" style={known ? undefined : { color: "var(--dirty-text)", background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)" }}
            data-tip={known ? undefined : "No hub project by this id right now. Kept in case you are about to add it."}>
            {p}
          </span>
        );
      })}
    </span>
  );
}

function TeamRow({ team, count, canWrite, knownProjects, onChanged, onDelete }: {
  team: Team;
  count: number;
  canWrite: boolean;
  knownProjects: string[];
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [scope, setScope] = useState(team.projects.join(", "));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const next = name.trim();
    if (!next) return;
    setBusy(true);
    try {
      await BatonAPI.updateTeam(team.id, { name: next, projects: parseProjects(scope) });
      setEditing(false);
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Could not save the team", desc: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <Icon name="layers" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
      {editing ? (
        <>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            style={{ ...inputStyle, flex: "1 1 140px", minWidth: 110 }} />
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="projects (blank = whole hub)"
            onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEditing(false); }}
            list={`baton-projects-${team.id}`}
            style={{ ...inputStyle, flex: "1 1 180px", minWidth: 140 }} />
          <datalist id={`baton-projects-${team.id}`}>
            {knownProjects.map((p) => <option key={p} value={p} />)}
          </datalist>
          <button className="btn btn-primary fr" style={{ height: 28, flex: "none" }} disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="btn fr" style={{ height: 28, flex: "none" }} disabled={busy}
            onClick={() => { setName(team.name); setScope(team.projects.join(", ")); setEditing(false); }}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{team.name}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-quaternary)" }}>{team.id}</span>
          <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
            {count} member{count === 1 ? "" : "s"}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}>sees</span>
            <ScopeChips team={team} knownProjects={knownProjects} />
          </span>
          {canWrite && (
            <span style={{ display: "flex", gap: 6, flex: "none" }}>
              <button className="btn fr" style={{ height: 28 }} onClick={() => setEditing(true)}
                data-tip="Rename it, or change which projects its rows are filtered to.">
                Edit
              </button>
              <button className="btn fr" style={{ height: 28 }} onClick={onDelete}
                data-tip="Deletes the group. Its members keep their access and move to no team.">
                Delete
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- The tab ---------- */

export function TeamsTab({ teams, members, canAct, writeEnabled, knownProjects, onChanged }: {
  teams: Team[];
  members: MemberRow[];
  canAct: boolean;
  writeEnabled: boolean;
  knownProjects: string[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Team | null>(null);

  const canWrite = canAct && writeEnabled;
  const active = members.filter((m) => !m.revokedAt);
  const countOf = (id: string) => active.filter((m) => m.team === id).length;

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await BatonAPI.createTeam(n, parseProjects(scope));
      setName("");
      setScope("");
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Could not create the team", desc: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      const r = await BatonAPI.deleteTeam(pendingDelete.id);
      showToast({ kind: "ok", title: `${pendingDelete.name} deleted`, desc: r.note });
      setPendingDelete(null);
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Not done", desc: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  if (!canAct) {
    return <EmptyState icon="lock" title="Owner only"
      desc="Who is grouped with whom is the owner's to arrange. You can see the groups themselves on the Members tab." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="card" style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <Icon name="plus" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", flex: "none" }}>New team</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" disabled={!writeEnabled}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          style={{ ...inputStyle, flex: "1 1 150px", minWidth: 120 }} />
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="projects (blank = whole hub)" disabled={!writeEnabled}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          list="baton-projects-new"
          style={{ ...inputStyle, flex: "1 1 200px", minWidth: 150 }} />
        <datalist id="baton-projects-new">
          {knownProjects.map((p) => <option key={p} value={p} />)}
        </datalist>
        <button className="btn btn-primary fr" style={{ height: 30, flex: "none" }} disabled={!writeEnabled || busy || !name.trim()} onClick={() => void create()}
          data-tip={writeEnabled ? "Creates an empty group. Assign people on the Members tab." : "Needs a writable daemon — restart with `baton serve --write`."}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>

      {teams.length === 0 ? (
        <EmptyState icon="layers" title="No teams yet"
          desc="Members are one flat roster until you group them. A team sorts the roster and filters Editing now — worth it once two groups of people share this hub, and noise before that." />
      ) : (
        teams.map((t) => (
          <TeamRow key={t.id} team={t} count={countOf(t.id)} canWrite={canWrite} knownProjects={knownProjects}
            onChanged={onChanged} onDelete={() => setPendingDelete(t)} />
        ))
      )}

      {/* The sentence this whole feature depends on people reading. */}
      <p style={{ marginTop: 6, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", display: "flex", alignItems: "flex-start", gap: 6, maxWidth: 660, lineHeight: "var(--lh-snug)" }}>
        <Icon name="alertTriangle" size={12} style={{ color: "var(--text-quaternary)", flex: "none", position: "relative", top: 2 }} />
        <span>
          A team groups people and filters this screen — it is <strong>not a permission</strong>. Every member's
          token still reaches every project on this hub, and everyone already has a full clone of every repo
          the workspace names. To take access away, use <strong>Remove</strong> on their row.
        </span>
      </p>

      <ConfirmDialog
        open={!!pendingDelete} onClose={() => setPendingDelete(null)} onConfirm={() => void remove()} busy={busy}
        tone="warn" icon="trash" confirmLabel="Delete team"
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : ""}
        body={pendingDelete
          ? `Its ${countOf(pendingDelete.id)} member${countOf(pendingDelete.id) === 1 ? "" : "s"} move to no team and keep everything they had — nobody is disconnected and no token changes. Only the grouping goes.`
          : ""} />
    </div>
  );
}
