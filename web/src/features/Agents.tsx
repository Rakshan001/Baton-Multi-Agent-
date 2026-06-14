/* ============================================================
   BATON — Agent roster screen
   The real roster behind GET /api/agents: which CLIs are installed,
   whether Baton can drive them, whether their MCP config is wired,
   and what each is doing right now — with one-click MCP connect and
   launch/hand-off actions. No static "all six look available" list.
   ============================================================ */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { AgentGlyph, getAgent } from "../lib/registry";
import { ScreenHeader } from "./shared";
import { BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import type { AgentRosterEntry, AgentId } from "../types";
import type { PollState } from "../hooks/usePoll";

export function AgentsScreen({
  agents, onOpen, onLaunch, onHandoff, writeEnabled,
}: {
  agents: PollState<AgentRosterEntry[]>;
  onOpen: (slug: string) => void;
  onLaunch: (agent: AgentId | null) => void;
  onHandoff: (slug: string) => void;
  writeEnabled: boolean;
}) {
  const roster = agents.data || [];
  const installed = roster.filter((a) => a.installed).length;
  const liveCount = roster.reduce((n, a) => n + a.live.length, 0);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader
        title="Agents"
        subtitle={agents.isLoading ? "Scanning your machine…" : `${installed}/${roster.length} installed · ${liveCount} live session${liveCount === 1 ? "" : "s"}`}
      >
        <button className="btn btn-primary fr" onClick={() => onLaunch(null)}><Icon name="plus" size={14} /> Launch session</button>
      </ScreenHeader>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>
        {agents.error && !roster.length ? (
          <div className="card" style={{ padding: 20, color: "var(--conflict-text)" }}>
            Couldn’t reach the daemon to list agents. <button className="btn btn-sm" onClick={agents.refetch} style={{ marginLeft: 8 }}>Retry</button>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14, alignItems: "start" }}>
            {roster.map((a) => (
              <AgentCard key={a.id} a={a} onOpen={onOpen} onLaunch={onLaunch} onHandoff={onHandoff} writeEnabled={writeEnabled} onChanged={agents.refetch} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentCard({
  a, onOpen, onLaunch, onHandoff, writeEnabled, onChanged,
}: {
  a: AgentRosterEntry;
  onOpen: (slug: string) => void;
  onLaunch: (agent: AgentId | null) => void;
  onHandoff: (slug: string) => void;
  writeEnabled: boolean;
  onChanged: () => void;
}) {
  const vis = getAgent(a.id);
  const color = vis.color;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ path: string; preview?: string } | null>(null);

  async function connect(confirmGlobal: boolean) {
    setBusy(true);
    try {
      const r = await BatonAPI.connectAgent(a.id, confirmGlobal);
      if (r.needsConfirm) {
        setConfirm({ path: r.path, preview: r.preview });
      } else {
        setConfirm(null);
        showToast({ kind: "ok", title: `${a.label} connected`, desc: `MCP wired in ${r.path}`, mono: true });
        onChanged();
      }
    } catch (e) {
      showToast({ kind: "error", title: `Couldn’t connect ${a.label}`, desc: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", opacity: a.installed ? 1 : 0.78 }}>
      {/* header */}
      <div style={{ padding: "14px 15px", display: "flex", alignItems: "center", gap: 12, borderBottom: "1px solid var(--border-subtle)", background: a.installed ? `linear-gradient(180deg, color-mix(in srgb, ${color} 8%, transparent), transparent)` : "transparent" }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, display: "grid", placeItems: "center", flex: "none", background: `color-mix(in srgb, ${color} 15%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 36%, transparent)`, filter: a.installed ? "none" : "grayscale(0.7)" }}>
          <AgentGlyph id={a.id} size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "var(--fs-15)", fontWeight: "var(--fw-semibold)" }}>{a.label}</div>
          <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)" }}>{a.binary}</div>
        </div>
        <StatusPill a={a} color={color} />
      </div>

      {/* not installed → install hint and nothing else actionable */}
      {!a.installed ? (
        <div style={{ padding: "13px 15px", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: 1.5 }}>
          Not found on your PATH. Install the <span className="mono" style={{ color: "var(--text-secondary)" }}>{a.binary}</span> CLI to launch it or hand work to it.
        </div>
      ) : (
        <>
          {/* capability + MCP chips */}
          <div style={{ padding: "12px 15px 4px", display: "flex", flexWrap: "wrap", gap: 6 }}>
            {a.headless && <Chip label="Headless" />}
            {a.interactive && <Chip label="Interactive" />}
            <McpChip a={a} />
          </div>

          {/* MCP connect action / confirm */}
          {a.mcp.supported && !a.mcp.connected && (
            <div style={{ padding: "6px 15px 2px" }}>
              {confirm ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)" }}>
                  <div style={{ fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
                    This writes a file outside the repo:
                    <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", marginTop: 3, wordBreak: "break-all" }}>{confirm.path}</div>
                  </div>
                  {confirm.preview && (
                    <pre className="mono" style={{ margin: 0, maxHeight: 120, overflow: "auto", fontSize: 10.5, color: "var(--text-tertiary)", background: "var(--bg-base)", padding: 8, borderRadius: 6 }}>{confirm.preview}</pre>
                  )}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => connect(true)}>Write file</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button
                  className="btn btn-sm fr"
                  disabled={busy || !writeEnabled}
                  data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : a.mcp.scope === "global" ? "Wires MCP in your home config (asks first)" : "Wires MCP in this repo"}
                  onClick={() => connect(false)}
                  style={{ width: "100%" }}
                >
                  <Icon name="link" size={13} /> {busy ? "Connecting…" : `Connect MCP${a.mcp.scope === "global" ? " (home config)" : ""}`}
                </button>
              )}
            </div>
          )}

          {/* live sessions */}
          {a.live.length > 0 && (
            <div style={{ padding: "8px 9px 2px", display: "flex", flexDirection: "column", gap: 3, maxHeight: 168, overflowY: "auto" }}>
              {a.live.map((s) => (
                <div key={s.slug} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: "var(--r-sm)", background: "var(--bg-surface-2)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flex: "none", animation: "pulse-dot 2s var(--ease-in-out) infinite" }} data-tip={s.kind} />
                  <button className="fr" onClick={() => onOpen(s.slug)} style={{ flex: 1, minWidth: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left", fontSize: "var(--fs-12)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.slug}</button>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-quaternary)", flex: "none" }}>{s.kind}</span>
                  <button className="btn btn-sm fr" data-tip="Hand off this session to another agent" onClick={() => onHandoff(s.slug)} style={{ flex: "none", height: 22, padding: "0 8px", fontSize: 11 }}>Hand off</button>
                </div>
              ))}
            </div>
          )}

          {/* footer launch */}
          <div style={{ marginTop: "auto", padding: "10px 12px", borderTop: "1px solid var(--border-subtle)" }}>
            <button className="btn btn-sm fr" onClick={() => onLaunch(a.id)} style={{ width: "100%" }}>
              <Icon name="zap" size={13} /> {a.idle ? `Launch ${vis.short} session` : `New ${vis.short} session`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function StatusPill({ a, color }: { a: AgentRosterEntry; color: string }) {
  if (!a.installed) {
    return <span style={pillStyle("var(--text-quaternary)", false)}>not installed</span>;
  }
  if (a.live.length > 0) {
    return (
      <span style={{ ...pillStyle(color, true), display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: color, animation: "pulse-dot 2s var(--ease-in-out) infinite" }} />
        {a.live.length} live
      </span>
    );
  }
  return <span style={pillStyle("var(--text-tertiary)", false)}>idle</span>;
}

function pillStyle(color: string, tinted: boolean) {
  return {
    fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)" as const, color,
    background: tinted ? `color-mix(in srgb, ${color} 14%, transparent)` : "var(--bg-surface-2)",
    border: tinted ? "none" : "1px solid var(--border-subtle)",
    borderRadius: 99, padding: "3px 9px", flex: "none" as const,
  };
}

function Chip({ label }: { label: string }) {
  return (
    <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "2px 8px" }}>{label}</span>
  );
}

function McpChip({ a }: { a: AgentRosterEntry }) {
  if (!a.mcp.supported) {
    return <span data-tip="No standard MCP config for this CLI" style={{ fontSize: "var(--fs-11)", color: "var(--text-quaternary)", background: "var(--bg-surface-2)", border: "1px dashed var(--border-subtle)", borderRadius: 99, padding: "2px 8px" }}>MCP n/a</span>;
  }
  if (a.mcp.connected) {
    return <span data-tip={a.mcp.path ?? undefined} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-11)", color: "var(--ok-text, #4ade80)", background: "color-mix(in srgb, #4ade80 14%, transparent)", borderRadius: 99, padding: "2px 8px" }}><Icon name="check" size={11} /> MCP connected</span>;
  }
  return <span style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", borderRadius: 99, padding: "2px 8px" }}>MCP not wired</span>;
}
