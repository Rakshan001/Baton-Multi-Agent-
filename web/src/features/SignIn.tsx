/* ============================================================
   BATON — member sign-in gate

   Shown when the daemon refuses this browser's credential, which is the
   normal first contact for anyone reaching a hub over `--host`. It
   stands in FRONT of the offline screen on purpose: a 401 is not a dead
   daemon, and telling someone "Baton isn't running" when it is running
   and simply doesn't know them sends them to debug the wrong machine.

   The token is validated against the daemon before it is stored, so a
   bad paste is answered here rather than by every screen behind it.
   ============================================================ */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { BatonMark } from "../components/BatonMark";
import { Switch } from "../components/primitives";
import { BatonAPI, ApiError } from "../lib/api";
import { looksLikeToken, normalizeToken } from "../lib/auth";
import type { Meta } from "../types";

export function SignIn({ baseUrl, refused, onSignedIn }: {
  /** Which daemon we are signing in to ("" = this origin). */
  baseUrl: string;
  /** True when we HELD a token and it was refused — a different situation
   *  from never having had one, and the copy has to say so. */
  refused: boolean;
  onSignedIn: (meta: Meta) => void;
}) {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the paste is malformed: the next submit tries it anyway, so a
   *  format guess can never be the final word on a real credential. */
  const [override, setOverride] = useState(false);

  const where = baseUrl || window.location.origin;
  const value = normalizeToken(token);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!value) return setError("Paste the token from your invite.");
    if (!looksLikeToken(value) && !override) {
      setOverride(true);
      return setError(
        "That doesn't look like a Baton token — they start with `baton_`. Check you copied the whole thing after `--token`. Submit again to try it anyway.",
      );
    }
    setBusy(true);
    try {
      const meta = await BatonAPI.probeToken(value);
      BatonAPI.signIn(value, remember);
      onSignedIn(meta);
    } catch (err) {
      const api = err as ApiError;
      setOverride(false);
      setError(
        api.code === "UNAUTHORIZED"
          ? "This hub refused that token. It may have been revoked or reissued, or the invite may have expired — ask the owner for a fresh one."
          : api.code === "OFFLINE"
            ? `Couldn't reach Baton at ${where}. The token wasn't checked.`
            : api.message || "Sign-in failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center", padding: 24, overflowY: "auto", background: "radial-gradient(120% 90% at 50% -10%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%)" }}>
      <div style={{ width: "min(460px, 100%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 20, animation: "fade-up var(--dur-4) var(--ease-out)" }}>
        <BatonMark size={40} withWord />

        <div style={{ width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center", background: "var(--bg-surface-2)", border: "1px solid var(--border-default)", color: "var(--text-secondary)" }}>
          <Icon name="lock" size={24} strokeWidth={1.7} />
        </div>

        <div style={{ textAlign: "center" }}>
          <h1 style={{ margin: 0, fontSize: "var(--fs-21)", fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-tight)" }}>
            {refused ? "Your access was refused" : "This hub needs your member token"}
          </h1>
          <p style={{ margin: "7px auto 0", maxWidth: 400, fontSize: "var(--fs-14)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>
            {refused
              ? "Baton is running and reachable — it just no longer accepts the credential this browser is holding."
              : <>You're reaching Baton over the network, so it needs to know who you are. Members sign in with the token from their invite.</>}
          </p>
          <p className="mono" style={{ margin: "8px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", wordBreak: "break-all" }}>{where}</p>
        </div>

        <form onSubmit={submit} style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              autoFocus
              type={show ? "text" : "password"}
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(null); setOverride(false); }}
              placeholder="baton_…"
              aria-label="Member token"
              aria-invalid={!!error}
              spellCheck={false}
              autoComplete="off"
              className="mono"
              style={{
                flex: 1, minWidth: 0, height: 38, padding: "0 10px", fontSize: "var(--fs-13)",
                background: "var(--bg-input)", color: "var(--text-primary)",
                border: `1px solid ${error ? "var(--conflict-border)" : "var(--border-default)"}`,
                borderRadius: "var(--r-sm)",
              }}
            />
            <button type="button" className="btn fr" onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide token" : "Show token"} style={{ flex: "none", height: 38 }}>
              {show ? "Hide" : "Show"}
            </button>
          </div>

          <Switch checked={remember} onChange={setRemember} id="baton-remember"
            label="Keep me signed in on this device" />
          <p style={{ margin: "-4px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
            {remember
              ? "The token is stored in this browser until you sign out."
              : "The token is kept for this tab only and is gone when you close it — the safer choice on a shared machine."}
          </p>

          {error && (
            <div role="alert" style={{ display: "flex", gap: 8, padding: "9px 11px", borderRadius: "var(--r-sm)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)", color: "var(--conflict-text)", fontSize: "var(--fs-13)", lineHeight: "var(--lh-snug)" }}>
              <Icon name="alertTriangle" size={15} style={{ flex: "none", marginTop: 1 }} />
              <span>{error}</span>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-lg fr" disabled={busy || !value} style={{ width: "100%" }}>
            {busy ? <><Icon name="refresh" size={15} style={{ animation: "spin 0.8s linear infinite" }} />Checking…</> : "Connect"}
          </button>
        </form>

        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 9, padding: "13px 14px", borderRadius: "var(--r-md)", background: "var(--bg-surface)", border: "1px solid var(--border-subtle)" }}>
          <Note icon="link">
            Your invite command carries the token — it's the part after{" "}
            <span className="mono" style={{ fontSize: "var(--fs-12)" }}>--token</span>.
          </Note>
          <Note icon="inbox">
            No invite? Ask the hub owner to create one from the <strong>Team</strong> screen.
          </Note>
          {/* Said here rather than discovered later as a button that always
              fails: terminals are refused for every remote viewer by design. */}
          <Note icon="terminal">
            Terminals stay on the host machine — they're never served over the network. Use SSH
            port-forwarding if you need one.
          </Note>
        </div>
      </div>
    </div>
  );
}

function Note({ icon, children }: { icon: "link" | "inbox" | "terminal"; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>
      <Icon name={icon} size={14} style={{ flex: "none", marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}
