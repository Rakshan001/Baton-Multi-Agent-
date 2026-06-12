/* ============================================================
   BATON — project memory screen
   Facts agents learned (via the save_memory MCP tool, the CLI, or
   the quick-add below), evidence-checked against the current code:
   every fact is anchored to the commit + file hashes it was true
   at; changed anchors flip it to STALE instead of serving rot.
   ============================================================ */
import { useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { ScreenHeader, SearchInput } from "./shared";
import { BatonAPI } from "../lib/api";
import { usePoll } from "../hooks/usePoll";
import { showToast } from "../lib/toast";
import type { MemoryFactStatus } from "../types";

const FRESHNESS: Record<MemoryFactStatus["freshness"], { label: string; color: string; tip: string }> = {
  fresh: { label: "fresh", color: "var(--clean)", tip: "Evidence anchors verified — safe to trust" },
  aging: { label: "aging", color: "var(--dirty)", tip: "Anchored files unchanged, but the repo moved on — still served to agents" },
  stale: { label: "stale", color: "var(--conflict)", tip: "An anchored file changed — withheld from agents until verified or GC'd" },
};

const TYPE_ICON: Record<MemoryFactStatus["type"], string> = {
  decision: "check", gotcha: "alertTriangle", convention: "layers", reference: "link", preference: "sparkle",
};

function FactCard({ f, writeEnabled, onDelete }: { f: MemoryFactStatus; writeEnabled: boolean; onDelete: (id: string) => void }) {
  const fr = FRESHNESS[f.freshness];
  const attribution = [f.agent && `by ${f.agent}`, f.task && `task ${f.task}`].filter(Boolean).join(" · ");
  return (
    <article style={{ background: "var(--bg-surface)", border: `1px solid ${f.freshness === "stale" ? "var(--conflict-border)" : "var(--border-subtle)"}`, borderRadius: "var(--r-md)", padding: "13px 15px", display: "flex", flexDirection: "column", gap: 8, opacity: f.freshness === "stale" ? 0.75 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="chip" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "var(--bg-surface-2)", border: "1px solid var(--border-default)" }}>
          <Icon name={TYPE_ICON[f.type] as never} size={11} /> {f.type}
        </span>
        <span data-tip={f.staleReason ?? fr.tip} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: "var(--fw-semibold)", color: fr.color }}>
          <span style={{ width: 7, height: 7, borderRadius: 99, background: fr.color }} /> {fr.label}
          {f.commitsBehind ? <span style={{ color: "var(--text-quaternary)", fontWeight: 400 }}>· {f.commitsBehind} commits old</span> : null}
        </span>
        <span className="mono" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-quaternary)" }}>{f.id}</span>
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
          <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, overflow: "hidden", textOverflow: "ellipsis" }}>
            <Icon name="folder" size={11} /> {f.anchors.files.map((a) => a.path).join(", ")}
          </span>
        )}
        {f.anchors.commit && <span className="mono">@ {f.anchors.commit.slice(0, 7)}</span>}
      </div>
    </article>
  );
}

export function MemoryScreen({ writeEnabled }: { writeEnabled: boolean }) {
  const memories = usePoll<MemoryFactStatus[]>(() => BatonAPI.getMemories(), { interval: 30000 });
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const facts = useMemo(() => {
    const all = memories.data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((f) => `${f.fact} ${f.type} ${f.task ?? ""} ${f.agent ?? ""} ${f.anchors.files.map((a) => a.path).join(" ")}`.toLowerCase().includes(needle));
  }, [memories.data, q]);

  const staleCount = (memories.data ?? []).filter((f) => f.freshness === "stale").length;

  const add = async () => {
    if (draft.trim().length < 10 || busy) return;
    setBusy(true);
    try {
      await BatonAPI.addMemory({ fact: draft.trim() });
      setDraft("");
      showToast({ kind: "ok", title: "Fact saved", desc: "Anchored to the current commit" });
    } catch (e) {
      showToast({ kind: "error", title: "Could not save", desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const gc = async () => {
    try {
      const r = await BatonAPI.gcMemories();
      showToast({ kind: r.removed.length ? "ok" : "info", title: r.removed.length ? `Removed ${r.removed.length} stale fact${r.removed.length === 1 ? "" : "s"}` : "Nothing stale to remove" });
    } catch (e) {
      showToast({ kind: "error", title: "GC failed", desc: (e as Error).message });
    }
  };

  const del = async (id: string) => {
    try {
      await BatonAPI.deleteMemory(id);
    } catch (e) {
      showToast({ kind: "error", title: "Could not delete", desc: (e as Error).message });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <ScreenHeader title="Memory" subtitle="Facts agents learned, evidence-checked against the current code — stale facts are withheld from agents automatically.">
        <SearchInput value={q} onChange={setQ} placeholder="Search facts…" />
        {staleCount > 0 && writeEnabled && (
          <button className="btn btn-sm fr" onClick={gc} data-tip="Remove every fact whose anchored files changed">
            <Icon name="trash" size={13} /> GC {staleCount} stale
          </button>
        )}
      </ScreenHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 14, maxWidth: 860 }}>
        {writeEnabled && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2}
              placeholder="Add a fact agents should know (1–3 sentences: the fact + why + how to apply)…"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") add(); }}
              style={{ flex: 1, resize: "vertical", padding: "9px 12px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", lineHeight: 1.5, outline: "none" }} />
            <button className="btn btn-primary fr" disabled={draft.trim().length < 10 || busy} onClick={add}
              style={draft.trim().length < 10 || busy ? { opacity: 0.55, cursor: "not-allowed" } : {}}>
              <Icon name="plus" size={14} /> Save
            </button>
          </div>
        )}

        {memories.isLoading ? (
          <div style={{ color: "var(--text-tertiary)", fontSize: "var(--fs-13)", padding: 24, textAlign: "center" }}>Loading memory…</div>
        ) : facts.length === 0 ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "48px 24px", textAlign: "center" }}>
            <span style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
              <Icon name="sparkle" size={20} style={{ color: "var(--text-tertiary)" }} />
            </span>
            <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-medium)" }}>{q ? "No facts match your search." : "No memories yet."}</div>
            {!q && (
              <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-tertiary)", maxWidth: 460, lineHeight: 1.6 }}>
                Agents save facts with the <span className="mono">save_memory</span> MCP tool and recall them with{" "}
                <span className="mono">recall_memory</span> — so the next session skips re-discovering decisions, gotchas, and conventions.
                You can also add facts from the terminal: <span className="mono">baton memory add "…" --files src/x.ts</span>
              </p>
            )}
          </div>
        ) : (
          facts.map((f) => <FactCard key={f.id} f={f} writeEnabled={writeEnabled} onDelete={del} />)
        )}
      </div>
    </div>
  );
}
