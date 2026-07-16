/* ============================================================
   BATON — project memory screen
   Facts agents learned (via save_memory, the CLI, or quick-add),
   evidence-checked against the current code: every fact is anchored
   to the commit + file hashes it was true at; changed anchors flip it
   to STALE instead of serving rot.

   Management: filter (freshness / server / agent), bulk-select +
   delete, a storage view, and an auto-retention policy — so memory
   never piles up or wastes disk.
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { ErrorState, CardSkeleton } from "../components/primitives";
import { AgentGlyph, getAgent } from "../lib/registry";
import { ScreenHeader, SearchInput } from "./shared";
import { BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import type { MemoryFactStatus, MemoryProject, RetentionPolicy, StorageBreakdown, PurgePreview, PurgeCategory } from "../types";

type Freshness = MemoryFactStatus["freshness"];

const FRESHNESS: Record<Freshness, { label: string; color: string; tip: string }> = {
  fresh: { label: "fresh", color: "var(--clean)", tip: "Evidence anchors verified — safe to trust" },
  aging: { label: "aging", color: "var(--dirty)", tip: "Anchored files unchanged, but the repo moved on — still served to agents" },
  stale: { label: "stale", color: "var(--conflict)", tip: "An anchored file changed — withheld from agents until verified or GC'd" },
};

const TYPE_ICON: Record<MemoryFactStatus["type"], string> = {
  decision: "check", gotcha: "alertTriangle", convention: "layers", reference: "link", preference: "sparkle",
};

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(b < 10 * 1024 ? 1 : 0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function MemoryScreen({ writeEnabled, searchSeed }: { writeEnabled: boolean; searchSeed?: { q: string; n: number } }) {
  const data = usePoll<{ facts: MemoryFactStatus[]; projects: MemoryProject[] }>(() => BatonAPI.getMemories(), { interval: 30000 });
  const facts = data.data?.facts ?? [];
  const projects = data.data?.projects ?? [];

  const [q, setQ] = useState(searchSeed?.q ?? "");
  // ⌘K deep-link: a picked fact re-seeds the search even if we're already here.
  useEffect(() => { if (searchSeed) setQ(searchSeed.q); }, [searchSeed?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const [fresh, setFresh] = useState<Freshness | null>(null);
  const [proj, setProj] = useState<string | null | undefined>(undefined); // undefined=all, null=shared
  const [agent, setAgent] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<null | "storage" | "retention">(null);

  const agents = useMemo(() => [...new Set(facts.map((f) => f.agent).filter((a): a is string => !!a))], [facts]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return facts.filter((f) => {
      if (fresh && f.freshness !== fresh) return false;
      if (proj !== undefined && f.project !== proj) return false;
      if (agent && f.agent !== agent) return false;
      if (needle && !`${f.id} ${f.fact} ${f.type} ${f.task ?? ""} ${f.agent ?? ""} ${f.anchors.files.map((a) => a.path).join(" ")}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [facts, q, fresh, proj, agent]);

  // Drop selections that scrolled out of existence (deleted elsewhere / filtered set changed).
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(facts.map((f) => f.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [facts]);

  const staleCount = facts.filter((f) => f.freshness === "stale").length;
  const visibleIds = visible.map((f) => f.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () => setSelected((p) => {
    const n = new Set(p);
    if (allVisibleSelected) visibleIds.forEach((id) => n.delete(id));
    else visibleIds.forEach((id) => n.add(id));
    return n;
  });

  const add = async () => {
    if (draft.trim().length < 10 || busy) return;
    setBusy(true);
    try {
      await BatonAPI.addMemory({ fact: draft.trim() });
      setDraft("");
      showToast({ kind: "ok", title: "Fact saved", desc: "Anchored to the current commit" });
    } catch (e) {
      showToast({ kind: "error", title: "Could not save", desc: (e as Error).message });
    } finally { setBusy(false); }
  };

  const del = async (id: string) => {
    try { await BatonAPI.deleteMemory(id); } catch (e) { showToast({ kind: "error", title: "Could not delete", desc: (e as Error).message }); }
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const r = await BatonAPI.bulkDeleteMemories(ids);
      setSelected(new Set());
      showToast({ kind: "ok", title: `Deleted ${r.removed.length} fact${r.removed.length === 1 ? "" : "s"}` });
    } catch (e) {
      showToast({ kind: "error", title: "Bulk delete failed", desc: (e as Error).message });
    }
  };

  const gc = async () => {
    try {
      const r = await BatonAPI.gcMemories();
      showToast({ kind: r.removed.length ? "ok" : "info", title: r.removed.length ? `Removed ${r.removed.length} stale fact${r.removed.length === 1 ? "" : "s"}` : "Nothing stale to remove" });
    } catch (e) { showToast({ kind: "error", title: "GC failed", desc: (e as Error).message }); }
  };

  const [repairing, setRepairing] = useState(false);
  const repair = async () => {
    setRepairing(true);
    try {
      const r = await BatonAPI.repairMemories();
      const parts = [
        r.reanchored.length ? `${r.reanchored.length} re-anchored` : null,
        r.needsReview.length ? `${r.needsReview.length} still need review` : null,
      ].filter(Boolean);
      showToast({
        kind: r.reanchored.length ? "ok" : "info",
        title: parts.length ? parts.join(" · ") : "Nothing stale to repair",
        desc: r.needsReview.length ? "Facts whose wording can't be re-verified stay withheld — re-save if still true, or delete." : undefined,
      });
      data.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Repair failed", desc: (e as Error).message });
    } finally { setRepairing(false); }
  };

  const projLabel = (id: string | null) => id ?? "shared";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <ScreenHeader title="Memory" subtitle={data.isLoading ? "Loading memory…" : `${facts.length} fact${facts.length === 1 ? "" : "s"} · stale withheld from agents automatically`}>
        <SearchInput value={q} onChange={setQ} placeholder="Search facts…" />
        <button className="btn btn-sm fr" onClick={() => setPanel(panel === "storage" ? null : "storage")} data-tip="Disk used by memory, graphs, history" aria-pressed={panel === "storage"}>
          <Icon name="layers" size={13} /> Storage
        </button>
        {writeEnabled && (
          <button className="btn btn-sm fr" onClick={() => setPanel(panel === "retention" ? null : "retention")} data-tip="Auto-prune policy" aria-pressed={panel === "retention"}>
            <Icon name="clock" size={13} /> Retention
          </button>
        )}
        {staleCount > 0 && writeEnabled && (
          <button className="btn btn-sm fr" onClick={gc} data-tip="Remove every fact whose anchored files changed — try Repair first">
            <Icon name="trash" size={13} /> GC {staleCount} stale
          </button>
        )}
      </ScreenHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14, maxWidth: 920 }}>
        {panel === "storage" && <StoragePanel />}
        {panel === "storage" && writeEnabled && <DangerZone onPurged={data.refetch} />}
        {panel === "retention" && writeEnabled && <RetentionPanel onApplied={data.refetch} />}

        {/* filters */}
        {facts.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <FilterPills label="Freshness" value={fresh} onChange={(v) => setFresh(v as Freshness | null)}
              options={(["fresh", "aging", "stale"] as Freshness[]).map((f) => ({ id: f, label: f, color: FRESHNESS[f].color, count: facts.filter((x) => x.freshness === f).length }))} />
            {projects.length > 0 && (
              <FilterPills label="Server" value={proj === undefined ? null : proj === null ? "__shared__" : proj} onChange={(v) => setProj(v === null ? undefined : v === "__shared__" ? null : v)}
                options={[
                  ...projects.map((p) => ({ id: p.id, label: p.id, count: facts.filter((x) => x.project === p.id).length })),
                  { id: "__shared__", label: "shared", count: facts.filter((x) => x.project === null).length },
                ]} />
            )}
            {agents.length > 1 && (
              <FilterPills label="Agent" value={agent} onChange={setAgent} options={agents.map((a) => ({ id: a, label: getAgent(a as never).short, count: facts.filter((x) => x.agent === a).length }))} />
            )}
          </div>
        )}

        {/* stale / needs-review band — the repair queue, surfaced */}
        {staleCount > 0 && (
          <div className="card" style={{ padding: "10px 14px", borderLeft: "3px solid var(--conflict)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Icon name="alertTriangle" size={14} style={{ color: "var(--conflict)", flex: "none" }} />
            <span style={{ fontSize: "var(--fs-13)", color: "var(--text-secondary)", flex: 1, minWidth: 200 }}>
              <b style={{ color: "var(--text-primary)", fontWeight: "var(--fw-semibold)" }}>{staleCount} stale fact{staleCount === 1 ? "" : "s"}</b> withheld from agents.
              {writeEnabled ? " Repair re-anchors the ones still verifiable in code; the rest need a human or agent to re-save or delete them." : " Start `baton serve --write` to repair them."}
            </span>
            <button className="btn btn-sm btn-ghost fr" onClick={() => setFresh("stale")}>Show stale</button>
            {writeEnabled && (
              <button className="btn btn-sm fr" onClick={repair} disabled={repairing}>
                <Icon name="refresh" size={13} /> {repairing ? "Repairing…" : "Repair"}
              </button>
            )}
          </div>
        )}

        {/* quick-add */}
        {writeEnabled && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
              placeholder="Add a fact agents should know (1–3 sentences: the fact + why + how to apply)…"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") add(); }}
              style={{ flex: 1, resize: "vertical", padding: "9px 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", lineHeight: 1.5, outline: "none" }} />
            <button className="btn btn-primary fr" disabled={draft.trim().length < 10 || busy} onClick={add} style={draft.trim().length < 10 || busy ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
              <Icon name="plus" size={14} /> Save
            </button>
          </div>
        )}

        {/* bulk toolbar */}
        {writeEnabled && visible.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 10px", borderRadius: "var(--r-sm)", background: selected.size ? "var(--accent-soft)" : "transparent", border: `1px solid ${selected.size ? "var(--accent-border)" : "transparent"}` }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: "var(--fs-12)", color: "var(--text-secondary)", cursor: "pointer" }}>
              <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} aria-label="Select all visible" />
              {selected.size ? `${selected.size} selected` : `Select all (${visible.length})`}
            </label>
            {selected.size > 0 && (
              <>
                <button className="btn btn-sm fr" onClick={bulkDelete} style={{ color: "var(--conflict-text)" }}><Icon name="trash" size={13} /> Delete {selected.size}</button>
                <button className="btn btn-sm btn-ghost fr" onClick={() => setSelected(new Set())}>Clear</button>
              </>
            )}
          </div>
        )}

        {/* list */}
        {data.error && !data.data ? (
          <ErrorState title="Couldn't load memory" desc={(data.error as Error).message}
            command="baton serve" onRetry={data.refetch} retrying={data.isFetching} />
        ) : data.isLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : visible.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 24px", textAlign: "center" }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
              <Icon name="sparkle" size={20} style={{ color: "var(--text-tertiary)" }} />
            </span>
            <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)" }}>{facts.length ? "No facts match your filters." : "No memories yet."}</div>
            {!facts.length && (
              <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", maxWidth: 460, lineHeight: 1.6 }}>
                Agents save facts with the <span className="mono">save_memory</span> MCP tool and recall them with{" "}
                <span className="mono">recall_memory</span>. You can also add facts: <span className="mono">baton memory add "…" --files src/x.ts</span>
              </p>
            )}
          </div>
        ) : (
          visible.map((f) => (
            <FactCard key={f.id} f={f} writeEnabled={writeEnabled} onDelete={del} projectLabel={projLabel} selected={selected.has(f.id)} onToggle={() => toggle(f.id)} selectMode={selected.size > 0} />
          ))
        )}
      </div>
    </div>
  );
}

function FilterPills({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string | null) => void; options: { id: string; label: string; color?: string; count?: number }[] }) {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10.5, color: "var(--text-quaternary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</span>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button key={o.id} className="chip fr" aria-pressed={on} onClick={() => onChange(on ? null : o.id)}
            style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, background: on ? "var(--accent-soft)" : "var(--bg-surface-2)", borderColor: on ? "var(--accent-border)" : "var(--border-default)", color: on ? "var(--accent-text)" : "var(--text-secondary)", opacity: o.count === 0 ? 0.55 : 1 }}>
            {o.color && <span style={{ width: 6, height: 6, borderRadius: 99, background: o.color }} />}{o.label}
            {o.count !== undefined && <span className="mono" style={{ fontSize: 10, color: on ? "var(--accent-text)" : "var(--text-quaternary)" }}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function FactCard({ f, writeEnabled, onDelete, projectLabel, selected, onToggle, selectMode }: {
  f: MemoryFactStatus; writeEnabled: boolean; onDelete: (id: string) => void; projectLabel: (id: string | null) => string;
  selected: boolean; onToggle: () => void; selectMode: boolean;
}) {
  const fr = FRESHNESS[f.freshness];
  const attribution = [f.agent && `by ${f.agent}`, f.task && `task ${f.task}`].filter(Boolean).join(" · ");
  return (
    <article style={{ background: selected ? "var(--accent-soft)" : "var(--bg-surface)", border: `1px solid ${selected ? "var(--accent-border)" : "var(--border-subtle)"}`, borderLeft: `3px solid ${selected ? "var(--accent)" : fr.color}`, borderRadius: "var(--r-md)", padding: "12px 15px", display: "flex", gap: 11, opacity: f.freshness === "stale" ? 0.85 : 1 }}>
      {writeEnabled && (
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${f.id}`}
          style={{ marginTop: 3, flex: "none", cursor: "pointer", opacity: selectMode || selected ? 1 : 0.5 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
        {/* One quiet eyebrow line instead of three competing chips. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", minHeight: 20 }}>
          <span className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name={TYPE_ICON[f.type] as never} size={11} /> {f.type}
            {f.project !== null && <span data-tip="Scoped to this server (by its anchored files)" style={{ color: "var(--text-quaternary)" }}>· {projectLabel(f.project)}</span>}
          </span>
          <span data-tip={f.staleReason ?? fr.tip} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: "var(--fw-medium)", color: fr.color }}>
            <span style={{ width: 6, height: 6, borderRadius: 99, background: fr.color }} /> {fr.label}
            {f.commitsBehind ? <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}> · {f.commitsBehind} commits old</span> : null}
          </span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-quaternary)" }}>{f.id}</span>
          {writeEnabled && (
            <button className="btn btn-ghost btn-icon fr" onClick={() => onDelete(f.id)} aria-label={`Delete ${f.id}`} data-tip="Delete this fact" style={{ width: 26, height: 26 }}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
        <p style={{ margin: 0, fontSize: "var(--fs-13)", lineHeight: 1.55, color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{f.fact}</p>
        {f.freshness === "stale" && f.staleReason && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--fs-12)", color: "var(--conflict-text)" }}>
            <Icon name="alertTriangle" size={12} /> {f.staleReason} — withheld from agents
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11, color: "var(--text-quaternary)", flexWrap: "wrap" }}>
          {attribution && <span>{attribution}</span>}
          {f.anchors.files.length > 0 && (
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0, maxWidth: "100%" }}>
              <Icon name="folder" size={11} style={{ flex: "none" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.anchors.files.map((a) => a.path).join(", ")}
              </span>
            </span>
          )}
          {f.anchors.commit && <span className="mono">@ {f.anchors.commit.slice(0, 7)}</span>}
        </div>
      </div>
    </article>
  );
}

function StoragePanel() {
  const [s, setS] = useState<StorageBreakdown | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { BatonAPI.getStorage().then(setS).catch((e) => setErr((e as Error).message)); }, []);
  if (err) return <div className="card" style={{ padding: 14, color: "var(--conflict-text)", fontSize: "var(--fs-13)" }}>Couldn’t read storage: {err}</div>;
  if (!s) return <div className="card" style={{ padding: 14, color: "var(--text-tertiary)", fontSize: "var(--fs-13)" }}>Measuring disk…</div>;
  const rows: { label: string; bytes: number; note?: string; color: string }[] = [
    { label: "Knowledge graphs", bytes: s.graphsTotal, note: `${s.graphs.length} project${s.graphs.length === 1 ? "" : "s"}`, color: "var(--accent)" },
    { label: "History (history.db)", bytes: s.history.bytes, note: "append-only", color: "#6ea8fe" },
    { label: "Memory", bytes: s.memory.bytes, note: `${s.memory.facts} facts`, color: "#4ade80" },
    { label: "Reports", bytes: s.reports.bytes, note: `${s.reports.count}`, color: "#a78bfa" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  return (
    <div className="card" style={{ padding: 15, display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Disk footprint</div>
        <div className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>{fmtBytes(s.total)} total</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 150, flex: "none", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{r.label}</div>
            <div style={{ flex: 1, height: 8, borderRadius: 99, background: "var(--bg-surface-2)", overflow: "hidden" }}>
              <div style={{ width: `${(r.bytes / max) * 100}%`, height: "100%", background: r.color, borderRadius: 99 }} />
            </div>
            <div className="mono" style={{ width: 92, flex: "none", textAlign: "right", fontSize: "var(--fs-12)", color: "var(--text-primary)" }}>{fmtBytes(r.bytes)}</div>
            <div style={{ width: 64, flex: "none", fontSize: 10.5, color: "var(--text-quaternary)" }}>{r.note}</div>
          </div>
        ))}
      </div>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>
        Graphs are gitignored and rebuilt on demand. Memory is hard-capped (500 facts). History grows append-only — set a retention policy to keep it tidy.
      </p>
    </div>
  );
}

/**
 * Danger Zone — permanently delete Baton data and reclaim disk. Three deliberate
 * steps (select → review → type-to-confirm), collapsed by default, with the
 * knowledge base (memory) guarded behind an extra explicit acknowledgement.
 */
function DangerZone({ onPurged }: { onPurged: () => void }) {
  const [open, setOpen] = useState(false);
  const [prev, setPrev] = useState<PurgePreview | null>(null);
  const [sel, setSel] = useState<Set<PurgeCategory>>(new Set());
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [phrase, setPhrase] = useState("");
  const [kbAck, setKbAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => BatonAPI.getPurgePreview().then(setPrev).catch(() => setPrev(null));
  useEffect(() => { if (open && !prev) void load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => { setStep(1); setSel(new Set()); setPhrase(""); setKbAck(false); };
  const items = prev?.items ?? [];
  const chosen = items.filter((i) => sel.has(i.category));
  const selectedBytes = chosen.reduce((n, i) => n + i.bytes, 0);
  const memorySelected = sel.has("memory");
  const phraseOk = !!prev && phrase.trim() === prev.confirmPhrase;
  const canDelete = phraseOk && (!memorySelected || kbAck) && !busy && chosen.length > 0;

  const toggle = (c: PurgeCategory) => setSel((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  const doPurge = async () => {
    if (!prev || !canDelete) return;
    setBusy(true);
    try {
      const r = await BatonAPI.purgeStorage([...sel], prev.confirmPhrase);
      showToast({ kind: "ok", title: `Freed ${fmtBytes(r.freedBytes)}`, desc: r.gcRan ? "Deleted selected data and ran git gc to reclaim packed objects." : "Deleted the selected data.", mono: false });
      reset();
      await load();
      onPurged();
    } catch (e) {
      showToast({ kind: "error", title: "Purge failed", desc: (e as Error).message });
    } finally { setBusy(false); }
  };

  const RED = "#f87171", REDBG = "color-mix(in srgb, #f87171 12%, transparent)", REDBORDER = "color-mix(in srgb, #f87171 42%, transparent)";

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", flexShrink: 0, border: `1px solid ${REDBORDER}` }}>
      <button onClick={() => { setOpen((v) => !v); if (open) reset(); }}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "12px 15px", background: REDBG, border: "none", cursor: "pointer", color: "inherit", textAlign: "left" }}>
        <Icon name="alertTriangle" size={15} style={{ color: RED }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", color: RED }}>Danger Zone — permanently delete data</div>
          <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>Free disk by deleting Baton data for good. This cannot be undone.</div>
        </div>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} style={{ color: "var(--text-tertiary)" }} />
      </button>

      {open && (
        <div style={{ padding: 15, display: "flex", flexDirection: "column", gap: 12 }}>
          {!prev ? (
            <div style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-13)" }}>Measuring what can be deleted…</div>
          ) : step === 1 ? (
            <>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>Step 1 of 3 — choose what to permanently delete:</div>
              {items.map((it) => (
                <label key={it.category} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 11px", borderRadius: "var(--r-sm)", cursor: "pointer", background: sel.has(it.category) ? REDBG : "var(--bg-surface-2)", border: `1px solid ${sel.has(it.category) ? REDBORDER : "var(--border-subtle)"}` }}>
                  <input type="checkbox" checked={sel.has(it.category)} onChange={() => toggle(it.category)} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-medium)", color: it.destructive ? RED : "var(--text-primary)" }}>{it.label}</span>
                      <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", flex: "none" }}>{fmtBytes(it.bytes)}{it.count ? ` · ${it.count}` : ""}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.45 }}>{it.detail}</div>
                    {it.warning && <div style={{ fontSize: 11, color: RED, marginTop: 3 }}>⚠ {it.warning}</div>}
                  </div>
                </label>
              ))}
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button className="btn btn-sm" disabled={!chosen.length} onClick={() => setStep(2)} style={{ opacity: chosen.length ? 1 : 0.5 }}>Review {chosen.length || ""} →</button>
              </div>
            </>
          ) : step === 2 ? (
            <>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>Step 2 of 3 — review. This permanently deletes:</div>
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                {chosen.map((it) => (
                  <li key={it.category} style={{ fontSize: "var(--fs-13)", color: it.destructive ? RED : "var(--text-secondary)" }}>
                    <b>{it.label}</b> — {fmtBytes(it.bytes)}{it.count ? `, ${it.count} item(s)` : ""}
                  </li>
                ))}
              </ul>
              <div className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>≈ {fmtBytes(selectedBytes)} reclaimed{sel.has("archives") ? " (after git gc)" : ""}.</div>
              {memorySelected && <div style={{ fontSize: "var(--fs-12)", color: RED, background: REDBG, border: `1px solid ${REDBORDER}`, borderRadius: "var(--r-sm)", padding: "8px 10px" }}>You are deleting the <b>knowledge base</b>. Every saved memory fact will be gone forever — this is usually a big loss.</div>}
              <div style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>This action cannot be undone.</div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <button className="btn btn-sm btn-ghost" onClick={() => setStep(1)}>← Back</button>
                <button className="btn btn-sm" onClick={() => setStep(3)}>Continue →</button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>Step 3 of 3 — type <span className="mono" style={{ color: RED }}>{prev.confirmPhrase}</span> to confirm:</div>
              <input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoFocus placeholder={prev.confirmPhrase}
                style={{ width: "100%", height: 36, padding: "0 12px", background: "var(--bg-input)", border: `1px solid ${phraseOk ? REDBORDER : "var(--border-default)"}`, borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "var(--font-mono, monospace)", outline: "none" }} />
              {memorySelected && (
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: "var(--fs-12)", color: RED, cursor: "pointer" }}>
                  <input type="checkbox" checked={kbAck} onChange={(e) => setKbAck(e.target.checked)} style={{ marginTop: 2 }} />
                  I understand my knowledge base ({prev.items.find((i) => i.category === "memory")?.count ?? 0} fact(s)) will be permanently deleted.
                </label>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <button className="btn btn-sm btn-ghost" onClick={() => setStep(2)}>← Back</button>
                <button className="btn btn-sm fr" disabled={!canDelete} onClick={doPurge}
                  style={{ background: canDelete ? RED : "var(--bg-surface-2)", borderColor: REDBORDER, color: canDelete ? "#fff" : "var(--text-tertiary)", opacity: canDelete ? 1 : 0.6 }}>
                  {busy ? "Deleting…" : "Permanently delete"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RetentionPanel({ onApplied }: { onApplied: () => void }) {
  const [policy, setPolicy] = useState<RetentionPolicy>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { BatonAPI.getRetention().then((p) => { setPolicy(p); setLoaded(true); }).catch(() => setLoaded(true)); }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await BatonAPI.setRetention(policy);
      showToast({ kind: "ok", title: "Retention policy saved", desc: r.removed.length ? `Pruned ${r.removed.length} fact${r.removed.length === 1 ? "" : "s"} now` : "Applied on every daemon start" });
      onApplied();
    } catch (e) {
      showToast({ kind: "error", title: "Could not save policy", desc: (e as Error).message });
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ padding: 15, display: "flex", flexDirection: "column", gap: 11 }}>
      <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>Auto-retention</div>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5 }}>Applied on every daemon start (and immediately when you save) so memory self-maintains.</p>
      <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>
        Drop facts older than
        <input type="number" min={0} value={policy.maxAgeDays ?? ""} placeholder="∞" disabled={!loaded}
          onChange={(e) => setPolicy((p) => ({ ...p, maxAgeDays: e.target.value ? Math.max(0, Number(e.target.value)) : undefined }))}
          style={{ width: 72, padding: "5px 8px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none" }} />
        days
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: "var(--fs-13)", color: "var(--text-secondary)", cursor: "pointer" }}>
        <input type="checkbox" checked={!!policy.dropStale} onChange={(e) => setPolicy((p) => ({ ...p, dropStale: e.target.checked }))} /> Drop <b style={{ color: FRESHNESS.stale.color, fontWeight: 600 }}>stale</b> facts (anchored files changed)
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: "var(--fs-13)", color: "var(--text-secondary)", cursor: "pointer" }}>
        <input type="checkbox" checked={!!policy.dropAging} onChange={(e) => setPolicy((p) => ({ ...p, dropAging: e.target.checked }))} /> Drop <b style={{ color: FRESHNESS.aging.color, fontWeight: 600 }}>aging</b> facts (repo moved on)
      </label>
      <div>
        <button className="btn btn-primary btn-sm fr" disabled={busy || !loaded} onClick={save}>{busy ? "Saving…" : "Save policy"}</button>
      </div>
    </div>
  );
}
