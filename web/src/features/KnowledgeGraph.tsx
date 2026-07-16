/* ============================================================
   BATON — Knowledge Graph (graphify)
   Force-directed view of the code graph(s) built by `baton kb init`:
   project switcher chips, search with neighbor highlight, community
   legend filter, node inspector, write-gated rebuild.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { EmptyState, CopyButton } from "../components/primitives";
import { GraphCanvas } from "../components/GraphCanvas";
import { ScreenHeader, SearchInput } from "./shared";
import { usePoll } from "../hooks/usePoll";
import { BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import type { KbStatus, KbProjectStat, GraphData, GraphNode, GraphLink } from "../types";
import { ContextPackModal } from "./ContextPackModal";

/** Fixed 12-color community palette — deliberately desaturated so the graph
 *  reads as an instrument, not a balloon chart. Hue identifies the community;
 *  the ring-not-fill node style (GraphCanvas) keeps the canvas quiet. */
const PALETTE = [
  "#8296c8", "#74ab92", "#c39d6e", "#b4839d", "#9489c2", "#77a4b2",
  "#ada374", "#b58a7f", "#84a088", "#a58bb0", "#8898a4", "#a09277",
];
const communityColor = (c: number | undefined) => PALETTE[(c ?? 0) % PALETTE.length];

const nodeId = (v: string | GraphNode): string => (typeof v === "string" ? v : v.id);

function chipStyle(on: boolean): React.CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", gap: 6, height: 28, padding: "0 11px",
    borderRadius: 99, cursor: "pointer", fontFamily: "inherit", fontSize: "var(--fs-12)",
    fontWeight: "var(--fw-semibold)", border: `1px solid ${on ? "var(--accent)" : "var(--border-default)"}`,
    background: on ? "var(--accent-soft)" : "var(--bg-surface)", color: on ? "var(--accent-text)" : "var(--text-secondary)",
  };
}

export function KnowledgeGraphScreen({ writeEnabled }: { writeEnabled: boolean }) {
  const kb = usePoll<KbStatus>(() => BatonAPI.getKb(), { interval: 10000 });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const [query, setQuery] = useState("");
  const [community, setCommunity] = useState<number | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const r = await BatonAPI.importKbPack(file);
      const ok = r.projects.filter((p) => p.status === "ok").length;
      const skipped = r.projects.length - ok;
      const behind = r.commitsBehind && r.commitsBehind > 0 ? ` · ${r.commitsBehind} commit${r.commitsBehind === 1 ? "" : "s"} behind — hit Rebuild` : "";
      showToast({ kind: skipped ? "info" : "ok", title: `Imported ${ok}/${r.projects.length} project${r.projects.length === 1 ? "" : "s"}`, desc: `${r.warnings[0] ?? ""}${behind}`.trim() || undefined });
      kb.refetch();
    } catch (e) {
      showToast({ kind: "error", title: "Import failed", desc: (e as Error).message });
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const projects: KbProjectStat[] = useMemo(() => {
    if (!kb.data?.initialized) return [];
    return kb.data.merged ? [...kb.data.projects, kb.data.merged] : kb.data.projects;
  }, [kb.data]);

  const activeId = projectId ?? projects[projects.length - 1]?.id ?? null;
  const active = projects.find((p) => p.id === activeId) ?? null;

  // fetch the graph blob when the active project changes
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    setGraphLoading(true);
    setGraphError(null);
    setSelected(null); setQuery(""); setCommunity(null);
    BatonAPI.getKbGraph(activeId)
      .then((g) => { if (!cancelled) setGraph(g); })
      .catch((e) => {
        if (!cancelled) {
          setGraph(null);
          setGraphError((e as Error).message);
          showToast({ kind: "error", title: "Could not load graph", desc: (e as Error).message });
        }
      })
      .finally(() => { if (!cancelled) setGraphLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, retryTick]);

  // Legend entries: a community is named after where its nodes live (dominant
  // directory) or, failing that, its best-connected node — "src/skills" or
  // "AuthService" beats an anonymous "community 7".
  const communities = useMemo(() => {
    if (!graph) return [];
    const degree = new Map<string, number>();
    for (const l of graph.links as GraphLink[]) {
      degree.set(nodeId(l.source), (degree.get(nodeId(l.source)) ?? 0) + 1);
      degree.set(nodeId(l.target), (degree.get(nodeId(l.target)) ?? 0) + 1);
    }
    const acc = new Map<number, { count: number; dirs: Map<string, number>; hub: GraphNode | null }>();
    for (const n of graph.nodes) {
      const c = n.community ?? 0;
      const e = acc.get(c) ?? { count: 0, dirs: new Map<string, number>(), hub: null };
      e.count++;
      if (!e.hub || (degree.get(n.id) ?? 0) > (degree.get(e.hub.id) ?? 0)) e.hub = n;
      if (n.source_file?.includes("/")) {
        // Directory only (drop the filename), at most two segments deep.
        const dir = n.source_file.split("/").slice(0, -1).slice(0, 2).join("/");
        if (dir) e.dirs.set(dir, (e.dirs.get(dir) ?? 0) + 1);
      }
      acc.set(c, e);
    }
    return [...acc.entries()]
      .map(([id, e]) => {
        const top = [...e.dirs.entries()].sort((a, b) => b[1] - a[1])[0];
        // A deep dominant directory names the cluster best; a flat repo (every
        // file straight under src/) says nothing, so fall back to the hub node.
        const label = top && top[1] >= e.count * 0.4 && top[0].includes("/")
          ? top[0]
          : e.hub?.label ?? `community ${id}`;
        return { id, label, count: e.count };
      })
      .sort((a, b) => b.count - a.count);
  }, [graph]);

  // neighbor index for the inspector + search highlighting
  const neighborsOf = useMemo(() => {
    const map = new Map<string, { node: GraphNode; relation: string; dir: "out" | "in" }[]>();
    if (!graph) return map;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const l of graph.links as GraphLink[]) {
      const s = byId.get(nodeId(l.source)), t = byId.get(nodeId(l.target));
      if (!s || !t) continue;
      if (!map.has(s.id)) map.set(s.id, []);
      if (!map.has(t.id)) map.set(t.id, []);
      map.get(s.id)!.push({ node: t, relation: l.relation ?? "related", dir: "out" });
      map.get(t.id)!.push({ node: s, relation: l.relation ?? "related", dir: "in" });
    }
    return map;
  }, [graph]);

  // highlight = search hits (+ their neighbors) ∩ community filter
  const highlightIds = useMemo<Set<string> | null>(() => {
    if (!graph) return null;
    const q = query.trim().toLowerCase();
    if (!q && community === null) return null;
    let ids = new Set<string>();
    if (q) {
      for (const n of graph.nodes) {
        if (n.label.toLowerCase().includes(q) || n.norm_label?.includes(q)) {
          ids.add(n.id);
          for (const nb of neighborsOf.get(n.id) ?? []) ids.add(nb.node.id);
        }
      }
    } else {
      ids = new Set(graph.nodes.map((n) => n.id));
    }
    if (community !== null) {
      ids = new Set([...ids].filter((id) => (graph.nodes.find((n) => n.id === id)?.community ?? 0) === community));
    }
    return ids;
  }, [graph, query, community, neighborsOf]);

  const matchCount = useMemo(() => {
    if (!graph || !query.trim()) return null;
    const q = query.trim().toLowerCase();
    return graph.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.norm_label?.includes(q)).length;
  }, [graph, query]);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await BatonAPI.rebuildKb(activeId === "merged" ? undefined : activeId ?? undefined);
      showToast({ kind: "info", title: "Rebuild queued", desc: "The graph refreshes when extraction finishes." });
    } catch (e) {
      showToast({ kind: "error", title: "Rebuild failed", desc: (e as Error).message });
    } finally {
      setRebuilding(false);
    }
  };

  /* ---- empty / error states ---- */
  if (kb.isLoading && !kb.data) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <ScreenHeader title="Knowledge Graph" subtitle="Code graph built by graphify" />
        <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 320, borderRadius: 12 }} /></div>
      </div>
    );
  }
  if (kb.data && !kb.data.initialized) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <ScreenHeader title="Knowledge Graph" subtitle="Code graph built by graphify" />
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 20 }}>
          <EmptyState icon="network" title="No knowledge base yet"
            desc={kb.data.graphifyInstalled
              ? "Index this repo so agents (and you) can navigate it as a graph."
              : "Install graphify first (uv tool install graphifyy), then initialize."}
            command="baton kb init" />
        </div>
      </div>
    );
  }

  const inspectorNeighbors = selected ? (neighborsOf.get(selected.id) ?? []) : [];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Knowledge Graph"
        subtitle={active
          ? `${active.nodes.toLocaleString()} nodes · ${active.edges.toLocaleString()} edges · ${active.communities} communities${active.lastBuiltAt ? ` · built ${new Date(active.lastBuiltAt).toLocaleTimeString()}` : ""}${
              active.mapTokens && active.repoTokens && active.repoTokens > active.mapTokens
                ? ` · map ≈ ${active.mapTokens.toLocaleString()} tokens vs ≈ ${(active.repoTokens / 1000).toFixed(0)}k reading the project (~${Math.round(active.repoTokens / active.mapTokens)}× cheaper)`
                : ""}`
          : "Code graph built by graphify"}>
        <button className="btn fr" onClick={() => setShareOpen(true)}
          data-tip="Markdown brief of this project for any external chatbot"
          style={{ height: 30 }}>
          <Icon name="share" size={14} /> Share context
        </button>
        {BatonAPI.kbExportUrl() ? (
          <a className="btn fr" href={BatonAPI.kbExportUrl()!} download data-tip="Download the KB as a shareable .tar.gz pack" style={{ height: 30, textDecoration: "none" }}>
            <Icon name="arrowRight" size={14} style={{ transform: "rotate(90deg)" }} /> Export
          </a>
        ) : (
          <button className="btn fr" disabled data-tip="Not available in demo mode" style={{ height: 30, opacity: 0.55 }}>
            <Icon name="arrowRight" size={14} style={{ transform: "rotate(90deg)" }} /> Export
          </button>
        )}
        <input ref={fileRef} type="file" accept=".tar.gz,.tgz,application/gzip" style={{ display: "none" }}
          onChange={(e) => void onImportFile(e.target.files?.[0])} />
        <button className="btn fr" onClick={() => fileRef.current?.click()}
          disabled={!writeEnabled || importing}
          data-tip={!writeEnabled ? "Start `baton serve --write` to enable" : "Import a KB pack exported elsewhere"}
          style={{ height: 30 }}>
          <Icon name="arrowRight" size={14} style={{ transform: "rotate(-90deg)" }} />
          {importing ? "Importing…" : "Import"}
        </button>
        <button className="btn fr" onClick={rebuild}
          disabled={!writeEnabled || rebuilding || !!active?.building}
          data-tip={!writeEnabled ? "Start `baton serve --write` to enable" : "Incremental re-extract (no LLM needed)"}
          style={{ height: 30 }}>
          <Icon name="zap" size={14} />
          {active?.building || rebuilding ? "Rebuilding…" : "Rebuild"}
        </button>
      </ScreenHeader>

      {/* controls row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", flexWrap: "wrap", borderBottom: "1px solid var(--border-subtle)" }}>
        {projects.map((p) => (
          <button key={p.id} className="fr" style={chipStyle(p.id === activeId)} onClick={() => setProjectId(p.id)}>
            <Icon name={p.id === "merged" ? "share" : "folder"} size={12} />
            {p.name}
            {p.building && <span className="mono" style={{ fontSize: 9, opacity: 0.8 }}>building…</span>}
          </button>
        ))}
        <span className="vdivider" style={{ height: 18 }} />
        <div style={{ width: 220 }}>
          <SearchInput value={query} onChange={setQuery} placeholder="Search nodes…" />
        </div>
        {matchCount !== null && (
          <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>{matchCount} match{matchCount === 1 ? "" : "es"}</span>
        )}
        <div style={{ flex: 1 }} />
        {communities.length > 1 && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", maxWidth: 560, justifyContent: "flex-end" }}>
            {communities.slice(0, 10).map((c) => {
              const on = community === c.id;
              return (
                <button key={c.id} className="fr mono" onClick={() => setCommunity(on ? null : c.id)}
                  data-tip={`${c.count} node${c.count === 1 ? "" : "s"} — click to isolate`} aria-pressed={on}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px",
                    borderRadius: 99, cursor: "pointer", fontSize: 10.5,
                    border: `1px solid ${on ? "var(--text-primary)" : "var(--border-default)"}`,
                    background: on ? "var(--bg-active)" : "var(--bg-surface)",
                    color: on ? "var(--text-primary)" : "var(--text-secondary)",
                    opacity: community !== null && !on ? 0.45 : 1,
                  }}>
                  <span style={{ width: 7, height: 7, borderRadius: 99, background: communityColor(c.id), flex: "none" }} />
                  <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                </button>
              );
            })}
            {communities.length > 10 && (
              <span className="mono" data-tip="Smaller communities — zoom the canvas to explore them"
                style={{ fontSize: 10.5, color: "var(--text-quaternary)", padding: "0 4px" }}>+{communities.length - 10}</span>
            )}
          </div>
        )}
      </div>

      {/* canvas + inspector */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
        <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
          {graphLoading && <div className="skeleton" style={{ position: "absolute", inset: 16, borderRadius: 12, zIndex: 1 }} />}
          {graph && !graphLoading && (
            <GraphCanvas data={graph} communityColor={communityColor} selectedId={selected?.id ?? null}
              highlightIds={highlightIds} onNodeClick={setSelected} />
          )}
          {!graph && !graphLoading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              {graphError ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", maxWidth: 380 }}>
                  <EmptyState icon="alertTriangle" title="Couldn't load the graph" desc={graphError} />
                  <button className="btn btn-primary fr" onClick={() => setRetryTick((t) => t + 1)}>
                    <Icon name="refresh" size={14} /> Retry
                  </button>
                </div>
              ) : (
                <EmptyState icon="alertTriangle" title="Graph not built yet" desc="Run `baton kb rebuild` (or the Rebuild button with --write) to build it." />
              )}
            </div>
          )}
        </div>

        {selected && (
          <aside style={{ width: 300, flex: "none", borderLeft: "1px solid var(--border-subtle)", background: "var(--bg-surface)", overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <span style={{ width: 12, height: 12, borderRadius: 4, background: communityColor(selected.community), flex: "none", marginTop: 4 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)", wordBreak: "break-word" }}>{selected.label}</div>
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  {selected.file_type && <span className="tag">{selected.file_type}</span>}
                  <span className="tag">{communities.find((c) => c.id === (selected.community ?? 0))?.label ?? `community ${selected.community ?? 0}`}</span>
                </div>
              </div>
              <button className="btn btn-ghost btn-icon fr" onClick={() => setSelected(null)} aria-label="Close inspector"><Icon name="x" size={14} /></button>
            </div>
            {selected.source_file && (
              <div>
                <div className="tag" style={{ marginBottom: 6 }}>Source</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="mono" style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)", wordBreak: "break-all" }}>
                    {selected.source_file}{selected.source_location ? `:${selected.source_location.replace(/^L/, "")}` : ""}
                  </span>
                  <CopyButton value={`${selected.source_file}${selected.source_location ? `:${selected.source_location.replace(/^L/, "")}` : ""}`} iconOnly />
                </div>
              </div>
            )}
            <div>
              <div className="tag" style={{ marginBottom: 6 }}>{inspectorNeighbors.length} connection{inspectorNeighbors.length === 1 ? "" : "s"}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {inspectorNeighbors.slice(0, 60).map((nb, i) => (
                  <button key={`${nb.node.id}-${i}`} className="fr" onClick={() => setSelected(nb.node)} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--r-sm)", border: "none",
                    background: "transparent", cursor: "pointer", textAlign: "left", width: "100%", fontFamily: "inherit" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                    <Icon name="arrowRight" size={11} style={{ color: "var(--text-quaternary)", flex: "none", transform: nb.dir === "in" ? "rotate(180deg)" : "none" }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nb.node.label}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--text-tertiary)", flex: "none" }}>{nb.relation}</span>
                  </button>
                ))}
                {inspectorNeighbors.length > 60 && (
                  <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", padding: "4px 8px" }}>+{inspectorNeighbors.length - 60} more…</span>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
      {shareOpen && (
        <ContextPackModal
          project={activeId === "merged" ? null : activeId}
          onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}
