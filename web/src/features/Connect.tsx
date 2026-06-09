/* ============================================================
   BATON — Connect / onboarding (ported from admin.jsx)
   ============================================================ */
import { Icon } from "../components/Icon";
import { BatonMark } from "../components/BatonMark";
import { CommandLine } from "../components/primitives";

export function Connect({ phase, onRetry, retrying }: { phase: "connecting" | "offline"; onRetry: () => void; retrying: boolean }) {
  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24, background: "radial-gradient(120% 90% at 50% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%)" }}>
      <div style={{ width: "min(520px, 100%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 22, textAlign: "center", animation: "fade-up var(--dur-4) var(--ease-out)" }}>
        <BatonMark size={44} withWord />
        {phase === "connecting" ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div style={{ position: "relative", width: 64, height: 64, display: "grid", placeItems: "center" }}>
              <span style={{ position: "absolute", inset: 0, borderRadius: 99, border: "2px solid var(--border-default)", borderTopColor: "var(--accent)", animation: "spin 0.9s linear infinite" }} />
              <Icon name="link" size={24} style={{ color: "var(--accent)" }} />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: "var(--fs-18)", fontWeight: "var(--fw-semibold)" }}>Connecting to Baton</h1>
              <p style={{ margin: "5px 0 0", fontSize: "var(--fs-13)", color: "var(--text-tertiary)" }}>Detecting the daemon on <span className="mono">localhost:7077</span>…</p>
            </div>
          </div>
        ) : (
          <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
            <div style={{ width: 60, height: 60, borderRadius: 16, display: "grid", placeItems: "center", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", color: "var(--conflict)" }}>
              <Icon name="wifiOff" size={28} strokeWidth={1.7} />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: "var(--fs-21)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-tight)" }}>Baton isn't running</h1>
              <p style={{ margin: "7px auto 0", maxWidth: 400, fontSize: "var(--fs-14)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
                We couldn't reach the local API. Start the daemon in your repo, then retry — Baton will pick up your worktrees automatically.
              </p>
            </div>
            <ol style={{ listStyle: "none", margin: 0, padding: 0, width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
              {[{ n: 1, t: "Open a terminal in your git repository" }, { n: 2, t: "Start the Baton daemon", cmd: "baton serve" }, { n: 3, t: "Come back and retry the connection" }].map((step) => (
                <li key={step.n} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span className="mono" style={{ width: 22, height: 22, flex: "none", borderRadius: 7, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-default)", fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>{step.n}</span>
                  <div style={{ flex: 1, paddingTop: 1 }}>
                    <div style={{ fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>{step.t}</div>
                    {step.cmd && <div style={{ marginTop: 7 }}><CommandLine command={step.cmd} /></div>}
                  </div>
                </li>
              ))}
            </ol>
            <button className="btn btn-primary btn-lg fr" onClick={onRetry} disabled={retrying} style={{ minWidth: 200 }}>
              <Icon name="refresh" size={15} style={{ animation: retrying ? "spin 0.8s linear infinite" : "none" }} />
              {retrying ? "Retrying…" : "Retry connection"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
