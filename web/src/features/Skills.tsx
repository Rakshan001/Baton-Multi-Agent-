/* ============================================================
   BATON — Skills screen
   A searchable catalog of reusable agent playbooks (bundled +
   imported). Install a skill into an agent's own config dir with one
   click — .claude/skills/<id>/SKILL.md for Claude Code, .cursor/rules
   for Cursor — or import your own from a path or URL. Mirrors
   GET /api/skills + POST/DELETE /api/skills/:id/install (src/skills).
   ============================================================ */
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { AgentGlyph, getAgent } from "../lib/registry";
import { ScreenHeader, SearchInput } from "./shared";
import { BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import type { SkillAgent, SkillStatus } from "../types";

export function SkillsScreen({ writeEnabled }: { writeEnabled: boolean }) {
  const skills = usePoll<SkillStatus[]>(() => BatonAPI.getSkills(), { interval: 30000 });
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const all = skills.data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((s) =>
      `${s.name} ${s.description} ${s.tags.join(" ")} ${s.produces.join(" ")} ${s.id}`.toLowerCase().includes(needle),
    );
  }, [skills.data, q]);

  const installedCount = (skills.data ?? []).reduce((n, s) => n + s.installs.filter((i) => i.installed).length, 0);

  const doImport = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    try {
      const s = await BatonAPI.importSkill(source.trim());
      setSource(""); setImporting(false);
      showToast({ kind: "ok", title: `Imported "${s.name}"`, desc: "Now in your catalog — install it to an agent below." });
      skills.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Import failed", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader
        title="Skills"
        subtitle={skills.isLoading ? "Loading catalog…" : `${(skills.data ?? []).length} skill${(skills.data ?? []).length === 1 ? "" : "s"} · ${installedCount} installed`}
      >
        <SearchInput value={q} onChange={setQ} placeholder="Search skills…" />
        {writeEnabled && (
          <button className="btn btn-sm fr" onClick={() => setImporting((v) => !v)} data-tip="Import a skill from a path or URL">
            <Icon name="plus" size={13} /> Import
          </button>
        )}
      </ScreenHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        {importing && writeEnabled && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", maxWidth: 860 }}>
            <input
              value={source} onChange={(e) => setSource(e.target.value)} autoFocus
              placeholder="Path or https:// URL to a SKILL.md…"
              onKeyDown={(e) => { if (e.key === "Enter") doImport(); if (e.key === "Escape") setImporting(false); }}
              style={{ flex: 1, height: 34, padding: "0 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none" }}
            />
            <button className="btn btn-primary fr" disabled={!source.trim() || busy} onClick={doImport}
              style={!source.trim() || busy ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
              {busy ? "Importing…" : "Import"}
            </button>
          </div>
        )}

        {skills.error && !(skills.data ?? []).length ? (
          <div className="card" style={{ padding: 20, color: "var(--conflict-text)" }}>
            Couldn’t load the skill catalog. <button className="btn btn-sm" onClick={skills.refetch} style={{ marginLeft: 8 }}>Retry</button>
          </div>
        ) : skills.isLoading && !(skills.data ?? []).length ? (
          <div style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-13)", padding: 24, textAlign: "center" }}>Loading skills…</div>
        ) : list.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 24px", textAlign: "center" }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
              <Icon name="command" size={20} style={{ color: "var(--text-tertiary)" }} />
            </span>
            <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)" }}>{q ? "No skills match your search." : "No skills yet."}</div>
            {!q && <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", maxWidth: 460, lineHeight: 1.6 }}>Import one from a path or URL, or run a newer Baton with bundled skills.</p>}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 14, alignItems: "start" }}>
            {list.map((s) => <SkillCard key={s.id} s={s} writeEnabled={writeEnabled} onChanged={skills.refetch} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillCard({ s, writeEnabled, onChanged }: { s: SkillStatus; writeEnabled: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<SkillAgent | null>(null);

  async function toggle(agent: SkillAgent, installed: boolean) {
    setBusy(agent);
    try {
      if (installed) {
        await BatonAPI.uninstallSkill(s.id, agent);
        showToast({ kind: "info", title: `Removed "${s.name}"`, desc: `from ${getAgent(agent).short}` });
      } else {
        const r = await BatonAPI.installSkill(s.id, agent);
        showToast({ kind: "ok", title: `Installed "${s.name}"`, desc: r.rel, mono: true });
      }
      onChanged();
    } catch (e) {
      showToast({ kind: "error", title: "Couldn’t update skill", desc: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 15px 10px", display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span style={{ width: 32, height: 32, borderRadius: 9, display: "grid", placeItems: "center", flex: "none", background: "var(--accent-soft)", border: "1px solid var(--accent-border)", color: "var(--accent-text)" }}>
            <Icon name="command" size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)" }}>{s.name}</div>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--text-quaternary)" }}>{s.id}</div>
          </div>
          <span style={{ fontSize: "var(--fs-11)", fontWeight: "var(--fw-semibold)", color: s.source === "imported" ? "var(--accent-text)" : "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "2px 8px", flex: "none" }}>{s.source}</span>
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-13)", lineHeight: 1.55, color: "var(--text-secondary)" }}>{s.description}</p>
        {s.produces.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {s.produces.map((p) => (
              <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-11)", color: "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "2px 8px" }}>
                <Icon name="layers" size={10} /> {p}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* per-agent install controls */}
      <div style={{ padding: "4px 15px 12px", display: "flex", flexWrap: "wrap", gap: 7 }}>
        {s.installs.map((inst) => {
          const a = getAgent(inst.agent);
          return (
            <button
              key={inst.agent}
              className="btn btn-sm fr"
              disabled={!writeEnabled || busy !== null}
              data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : inst.installed ? `Installed at ${inst.rel} — click to remove` : `Write ${inst.rel}`}
              onClick={() => toggle(inst.agent, inst.installed)}
              style={{
                gap: 6,
                background: inst.installed ? `color-mix(in srgb, ${a.color} 14%, transparent)` : "var(--bg-surface-2)",
                borderColor: inst.installed ? `color-mix(in srgb, ${a.color} 40%, transparent)` : "var(--border-default)",
              }}
            >
              <AgentGlyph id={inst.agent} size={13} />
              {busy === inst.agent ? "…" : inst.installed ? <><Icon name="check" size={12} /> {a.short}</> : `Add to ${a.short}`}
            </button>
          );
        })}
        <button className="btn btn-sm btn-ghost fr" onClick={() => setOpen((v) => !v)} data-tip="Preview the playbook" style={{ marginLeft: "auto" }}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} /> Playbook
        </button>
      </div>

      {open && (
        <pre className="mono" style={{ margin: 0, padding: "12px 15px", maxHeight: 300, overflow: "auto", fontSize: 11, lineHeight: 1.55, color: "var(--text-secondary)", background: "var(--bg-base)", borderTop: "1px solid var(--border-subtle)", whiteSpace: "pre-wrap" }}>{s.body}</pre>
      )}
    </div>
  );
}
