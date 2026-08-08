// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Team: who is on the hub, and who is editing what.

   The dashboard face of the federation plane (src/federation.ts) and
   the member registry (src/members.ts).

   Two things this screen must never imply:

   1. That a claim LOCKS anything. It does not, and cannot — members'
      agents run on machines we don't control, writing to their own
      clones. The word used throughout is "claimed by", a conflict is a
      loud warning rather than a blocked write, and the footer says so
      outright. Selling advisory claims as locking would be a lie the
      user only discovers when two agents have already collided.
   2. That removing someone takes the code back. It does not. The
      confirm dialog says that in the same breath as the button.

   Owner controls render from `viewer.isOwner`, but that flag decides
   only what is worth DRAWING — every one of these endpoints re-checks
   ownership server-side. A button the UI declines to render is not a
   permission check.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, CommandLine, ConfirmDialog, EmptyState, ErrorState, SegmentedControl } from "../components/primitives";
import { ScreenHeader } from "./shared";
import { basename, dirname, timeAgo } from "../lib/format";
import { BatonAPI, ApiError } from "../lib/api";
import { showToast } from "../lib/toast";
import { usePoll } from "../hooks/usePoll";
import { TeamFilter, TeamPicker, TeamsTab, groupMembersByTeam, visibleGroups } from "./TeamsPanel";
import type { AgentId, ClaimOverlap, InviteResult, MemberClaim, MemberRow, Reachability, Team, TeamState } from "../types";

/** Older than this and a claim is worth a second look — an agent that crashed
 *  mid-edit leaves one behind until the 15-minute TTL expires it. */
const STALE_CLAIM_MS = 30 * 60_000;

const at = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const ago = (iso: string | null | undefined): string => {
  const t = at(iso);
  return t === null ? "—" : timeAgo(t);
};

function Dot({ online }: { online: boolean }) {
  return (
    <span aria-hidden="true" style={{
      width: 8, height: 8, borderRadius: 99, flex: "none",
      background: online ? "var(--clean)" : "var(--text-quaternary)",
      boxShadow: online ? "0 0 0 3px color-mix(in srgb, var(--clean) 18%, transparent)" : "none",
    }} />
  );
}

function RoleBadge({ role, revoked }: { role: string; revoked: boolean }) {
  if (revoked) {
    return (
      <span className="tag" style={{ color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)" }}
        data-tip="Their token no longer works. Anything already cloned stays on their machine.">
        removed
      </span>
    );
  }
  if (role === "owner") {
    return (
      <span className="tag" style={{ color: "var(--accent-text)", background: "var(--accent-soft)", border: "1px solid var(--border-default)" }}
        data-tip="Can warn, disconnect and remove members. A hub always keeps at least one owner.">
        owner
      </span>
    );
  }
  return <span className="tag" style={{ color: "var(--text-tertiary)" }}>member</span>;
}

/* ---------- Members ---------- */

/** Invite state: minted, never redeemed. `null` once they have actually used it. */
function inviteState(m: MemberRow): "pending" | "expired" | null {
  if (m.firstUsedAt || !m.expiresAt) return null;
  const t = at(m.expiresAt);
  return t !== null && Date.now() > t ? "expired" : "pending";
}

function MemberCard({ m, teams, canAct, writeEnabled, onWarn, onDisconnect, onRemove, onReissue, onTeam }: {
  m: MemberRow; teams: Team[]; canAct: boolean; writeEnabled: boolean;
  onWarn: () => void; onDisconnect: () => void; onRemove: () => void; onReissue: () => void;
  onTeam: (team: string | null) => void;
}) {
  const revoked = !!m.revokedAt;
  const invite = revoked ? null : inviteState(m);
  const roTip = "Owner controls need a writable daemon.\nRestart with `baton serve --write`, or run `baton member revoke <id>` on the host.";
  return (
    <div className="card" style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, opacity: revoked ? 0.6 : 1 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, flex: "none", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 800, color: "#fff", background: revoked ? "var(--text-quaternary)" : m.online ? "var(--accent)" : "var(--idle)" }}>
        {m.name[0]?.toUpperCase() ?? "?"}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          {!revoked && <Dot online={m.online} />}
          <span style={{ fontSize: "var(--fs-14)", fontWeight: "var(--fw-semibold)" }}>{m.name}</span>
          {/* Two people can pick the same display name; the id is the identity. */}
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-quaternary)" }}>{m.id}</span>
          <RoleBadge role={m.role} revoked={revoked} />
          {!m.registered && (
            <span className="tag" style={{ color: "var(--text-tertiary)" }} data-tip="Reporting from this machine over loopback — no member record, no token needed.">
              this machine
            </span>
          )}
          {invite === "pending" && (
            <span className="tag" style={{ color: "var(--dirty-text)", background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)" }}
              data-tip={`Invite sent but never used. It stops working ${m.expiresAt ? new Date(m.expiresAt).toLocaleString() : "soon"}.`}>
              invite pending
            </span>
          )}
          {invite === "expired" && (
            // An expired invite is not a member who might turn up — the token is
            // already dead server-side, so the row says so rather than showing
            // them as merely offline.
            <span className="tag" style={{ color: "var(--conflict-text)", background: "var(--conflict-soft)", border: "1px solid var(--conflict-border)" }}
              data-tip="Never used before its deadline — the token no longer works. Reissue to send a fresh one.">
              invite expired
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 3, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", flexWrap: "wrap" }}>
          {revoked ? (
            <span>removed {ago(m.revokedAt)}</span>
          ) : m.online ? (
            <>
              <span>connected {ago(m.since)}</span>
              {m.device && <span className="mono" style={{ fontSize: 11 }}>{m.device}</span>}
              <span>{m.sessions} session{m.sessions === 1 ? "" : "s"}</span>
              <span style={{ color: m.claims ? "var(--text-secondary)" : undefined }}>
                {m.claims} file{m.claims === 1 ? "" : "s"} claimed
              </span>
            </>
          ) : (
            // Absence is the only signal there is — a member that crashes or
            // loses its tunnel never sends a goodbye.
            <span>{m.lastSeen ? `last seen ${ago(m.lastSeen)}` : "never connected"}</span>
          )}
        </div>
        {m.warnings.length > 0 && (
          <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 4 }}>
            {m.warnings.slice(-2).map((w) => (
              <div key={w.id} style={{ display: "flex", alignItems: "baseline", gap: 7, fontSize: "var(--fs-12)", color: "var(--dirty-text)", background: "var(--dirty-soft)", border: "1px solid var(--dirty-border)", borderRadius: "var(--r-sm)", padding: "5px 8px" }}>
                <Icon name="alertTriangle" size={12} style={{ flex: "none", position: "relative", top: 2 }} />
                <span style={{ flex: 1, minWidth: 0 }}>{w.message}</span>
                <span style={{ flex: "none", fontSize: 10.5, color: "var(--text-quaternary)" }}>sent {ago(w.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {canAct && !revoked && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: "none" }}>
          {/* Only for a registered member: a loopback heartbeat has no registry
              row to write a team onto, so offering the control would produce a
              select that silently forgets. */}
          {m.registered && <TeamPicker teams={teams} value={m.team} disabled={!writeEnabled} onChange={onTeam} />}
          {m.registered && (
            <button className="btn fr" style={{ height: 28 }} disabled={!writeEnabled} onClick={onReissue}
              data-tip={!writeEnabled ? roTip : "Mint a replacement token. Their current one stops working immediately."}>
              Reissue
            </button>
          )}
          <button className="btn fr" style={{ height: 28 }} disabled={!writeEnabled || !m.online} onClick={onWarn}
            data-tip={!writeEnabled ? roTip : !m.online ? "They're offline — a warning has nowhere to be delivered." : "Send them a notice. It appears in their daemon's output."}>
            Warn
          </button>
          <button className="btn fr" style={{ height: 28 }} disabled={!writeEnabled || !m.online} onClick={onDisconnect}
            data-tip={!writeEnabled ? roTip : !m.online ? "They're not connected." : "Drop them from the live view. Their token still works — they reconnect on their next heartbeat."}>
            Disconnect
          </button>
          <button className="btn btn-danger fr" style={{ height: 28 }} disabled={!writeEnabled} onClick={onRemove}
            data-tip={!writeEnabled ? roTip : "Revoke their token."}>
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- Who's editing ---------- */

interface FileGroup {
  key: string;
  relPath: string;
  projectId: string | null;
  claims: MemberClaim[];
  overlap: ClaimOverlap | null;
}

function groupClaims(team: TeamState): FileGroup[] {
  const byKey = new Map<string, FileGroup>();
  for (const c of team.claims) {
    const key = `${c.projectId ?? ""}\u0000${c.relPath}`;
    const at_ = byKey.get(key);
    if (at_) at_.claims.push(c);
    else byKey.set(key, { key, relPath: c.relPath, projectId: c.projectId, claims: [c], overlap: null });
  }
  for (const o of team.overlaps) {
    const g = byKey.get(`${o.projectId ?? ""}\u0000${o.relPath}`);
    if (g) g.overlap = o;
  }
  // Real conflicts first, then anything shared, then by path.
  return [...byKey.values()].sort((a, b) => {
    const rank = (g: FileGroup) => (g.overlap?.sameBranch ? 0 : g.claims.length > 1 ? 1 : 2);
    return rank(a) - rank(b) || a.relPath.localeCompare(b.relPath);
  });
}

function ClaimGroup({ g, canAct, writeEnabled, onClear }: {
  g: FileGroup; canAct: boolean; writeEnabled: boolean; onClear: (c: MemberClaim) => void;
}) {
  const conflict = !!g.overlap?.sameBranch;
  const shared = g.claims.length > 1;
  return (
    <div style={{
      borderRadius: "var(--r-md)", padding: "9px 11px",
      background: conflict ? "var(--conflict-soft)" : "var(--bg-surface-2)",
      border: `1px solid ${conflict ? "var(--conflict-border)" : "var(--border-subtle)"}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {conflict
          ? <Icon name="alertTriangle" size={13} style={{ color: "var(--conflict)", flex: "none" }} />
          : <span style={{ width: 7, height: 7, borderRadius: 99, background: "var(--accent)", flex: "none", margin: "0 3px" }} />}
        <div style={{ minWidth: 0, flex: 1 }}>
          <span className="mono" style={{ fontSize: "var(--fs-12)", color: conflict ? "var(--conflict-text)" : "var(--text-secondary)" }}>{basename(g.relPath)}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-quaternary)", marginLeft: 7 }}>{dirname(g.relPath)}</span>
        </div>
        {g.projectId && <span className="tag" style={{ flex: "none" }}>{g.projectId}</span>}
        {conflict && (
          <span style={{ flex: "none", fontSize: 10, fontWeight: "var(--fw-semibold)", color: "var(--conflict-text)", background: "color-mix(in srgb, var(--conflict) 16%, transparent)", padding: "1px 7px", borderRadius: 99 }}
            data-tip="Same file, same branch, two members. Nothing is blocked — decide between you who takes it.">
            same branch
          </span>
        )}
        {shared && !conflict && (
          // Divergent branches meet at merge, not in a working tree. Flagging
          // this as a conflict would train people to ignore the real ones.
          <span className="tag" style={{ flex: "none", color: "var(--text-tertiary)" }}
            data-tip="Different branches — they meet at merge, not in a working tree. Worth knowing, not a conflict.">
            different branches
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6, paddingLeft: 21 }}>
        {g.claims.map((c) => {
          const opened = at(c.openedAt);
          const stale = opened !== null && Date.now() - opened > STALE_CLAIM_MS;
          return (
            <div key={`${c.memberId}-${c.relPath}`} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <AgentBadge id={(c.agent as AgentId) ?? null} size="sm" showLabel={false} />
              <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-medium)", flex: "none" }}>{c.memberName}</span>
              {c.branch && <span className="mono" style={{ fontSize: 10.5, color: "var(--text-tertiary)", flex: "none" }}>{c.branch}</span>}
              <span style={{ fontSize: 11, color: stale ? "var(--dirty-text)" : "var(--text-quaternary)", flex: 1, minWidth: 0 }}
                data-tip={stale ? "Held a long time — if their agent crashed mid-edit, the claim lingers until it expires." : undefined}>
                held {ago(c.openedAt)}{stale ? " · looks stale" : ""}
              </span>
              {canAct && (
                <button className="btn fr" style={{ height: 24, fontSize: 11, flex: "none" }} disabled={!writeEnabled} onClick={() => onClear(c)}
                  data-tip={writeEnabled
                    ? "Clear it from the shared view. If their agent is still on the file, their next heartbeat re-states it."
                    : "Needs a writable daemon — restart with `baton serve --write`."}>
                  Clear
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Invite ---------- */

/**
 * The "one copied command" panel.
 *
 * The command embeds a live credential, which is the whole reason it is a
 * single paste — and the reason the panel says so before showing it rather
 * than after. It is displayed exactly once: nothing on the server stores the
 * token, so a closed dialog means rotating, not looking it up. Saying that
 * plainly is cheaper than a support conversation later.
 */
function InvitePanel({ writeEnabled, onInvited }: { writeEnabled: boolean; onInvited: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<InviteResult | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      setIssued(await BatonAPI.inviteMember(n));
      setName("");
      onInvited();
    } catch (e) {
      showToast({ kind: "error", title: "Could not create the invite", desc: (e as ApiError).message });
    } finally {
      setBusy(false);
    }
  };

  if (issued) {
    return (
      <div className="card" style={{ padding: 14, marginBottom: 12, borderColor: "var(--accent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <Icon name="link" size={14} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Invite for {issued.member.name}</span>
          <span className="tag" style={{ marginLeft: "auto", color: "var(--dirty-text)" }}>shown once</span>
        </div>
        <p style={{ margin: "0 0 9px", fontSize: "var(--fs-12)", color: "var(--dirty-text)" }}>
          {issued.note}{issued.expiresAt ? ` Unused, it stops working ${new Date(issued.expiresAt).toLocaleString()}.` : ""}
        </p>
        <CommandLine command={issued.command} />
        <p style={{ margin: "9px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
          They run it in an empty folder: it clones every repo into the same layout, remembers this
          host, and finishes setup. If they lose it, use <strong>Reissue</strong> on their row — nothing
          here can show this token again.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn fr" style={{ height: 28 }} onClick={() => setIssued(null)}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: "11px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
      <Icon name="plus" size={14} style={{ color: "var(--text-tertiary)", flex: "none" }} />
      <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", flex: "none" }}>Invite someone</span>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" disabled={!writeEnabled}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
        style={{ flex: "1 1 180px", minWidth: 140, height: 30, padding: "0 10px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", outline: "none" }} />
      <button className="btn btn-primary fr" style={{ height: 30, flex: "none" }} disabled={!writeEnabled || busy || !name.trim()} onClick={() => void submit()}
        data-tip={writeEnabled ? "Mints a token and builds their one-line join command." : "Needs a writable daemon — restart with `baton serve --write`."}>
        {busy ? "Creating…" : "Create invite"}
      </button>
    </div>
  );
}

/* ---------- Share ---------- */

/**
 * "Can anyone else actually reach this hub?"
 *
 * The failure this exists to prevent: an owner mints invites from a dashboard
 * that works perfectly — because they are looking at it over loopback — and
 * every person they send it to gets connection refused. Nothing on any other
 * screen would tell them.
 *
 * Baton detects and instructs; it does not start tunnels. See the note on
 * TunnelTool in src/reachability.ts for why that line is deliberate.
 */
function ShareTab({ canAct }: { canAct: boolean }) {
  const reach = usePoll<Reachability>(() => BatonAPI.getReachability(), { interval: 30_000 });
  const r = reach.data;

  if (!canAct) {
    return <EmptyState icon="lock" title="Owner only"
      desc="How this hub is exposed — and which addresses reach it — is the owner's to see. It maps the host's network, which is of no use to a member." />;
  }
  if (reach.isLoading && !r) return <div className="skeleton" style={{ height: 200, borderRadius: 12 }} />;
  if (reach.error && !r) {
    return <ErrorState title="Couldn't check reachability" desc={(reach.error as Error).message}
      command="baton serve" onRetry={reach.refetch} retrying={reach.isFetching} />;
  }
  if (!r) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {r.blockers.map((b, i) => (
        <div key={i} className="card" style={{ padding: "11px 14px", display: "flex", gap: 9, alignItems: "flex-start", background: "var(--conflict-soft)", borderColor: "var(--conflict-border)" }}>
          <Icon name="alertTriangle" size={14} style={{ color: "var(--conflict)", flex: "none", position: "relative", top: 2 }} />
          <span style={{ fontSize: "var(--fs-13)", color: "var(--conflict-text)" }}>{b}</span>
        </div>
      ))}
      {r.notes.map((n, i) => (
        <div key={i} className="card" style={{ padding: "11px 14px", display: "flex", gap: 9, alignItems: "flex-start", background: "var(--dirty-soft)", borderColor: "var(--dirty-border)" }}>
          <Icon name="alertTriangle" size={14} style={{ color: "var(--dirty)", flex: "none", position: "relative", top: 2 }} />
          <span style={{ fontSize: "var(--fs-13)", color: "var(--dirty-text)" }}>{n}</span>
        </div>
      ))}

      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
          <Icon name="share" size={14} style={{ color: "var(--text-tertiary)" }} />
          <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Right now</span>
          <span className="tag" style={{ marginLeft: "auto" }}>bound to {r.bind}:{r.port}</span>
        </div>
        {r.urls.length ? (
          <>
            <p style={{ margin: "0 0 8px", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              Members should be able to reach this hub at:
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {r.urls.map((u) => <CommandLine key={u} command={u} prompt="→" />)}
            </div>
            <p style={{ margin: "9px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              {/* "Should" is doing real work here: the daemon can see what it bound,
                  never what a firewall, router or VPN between here and them does. */}
              Baton can see what it bound, not what the network between you and a member does — the
              only proof is a member actually connecting.
            </p>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: "var(--fs-13)", color: "var(--text-secondary)" }}>
            Loopback only — reachable from this machine and nothing else. Pick a route below.
          </p>
        )}
      </div>

      {r.tools.map((t) => (
        <div key={t.id} className="card" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>{t.label}</span>
            {!t.needsBinary ? (
              <span className="tag" style={{ color: "var(--clean-text)", background: "var(--clean-soft)", border: "1px solid var(--clean-border)" }}>nothing to install</span>
            ) : t.installed ? (
              <span className="tag" style={{ color: "var(--clean-text)", background: "var(--clean-soft)", border: "1px solid var(--clean-border)" }}>installed</span>
            ) : (
              // Detected up front rather than failing halfway through a flow.
              <span className="tag" style={{ color: "var(--text-tertiary)" }} data-tip="Not found on this machine — install it first, or use another route.">not installed</span>
            )}
          </div>
          <p style={{ margin: "0 0 9px", fontSize: "var(--fs-12)", color: "var(--text-secondary)", lineHeight: "var(--lh-snug)" }}>{t.why}</p>
          {t.install && (
            <p style={{ margin: "0 0 8px", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
              Install: <span className="mono">{t.install}</span>
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 5, opacity: t.installed || !t.needsBinary ? 1 : 0.6 }}>
            {t.steps.map((s, i) => <CommandLine key={i} command={s} />)}
          </div>
          {t.then && (
            <p style={{ margin: "9px 0 0", fontSize: "var(--fs-12)", color: "var(--text-tertiary)", lineHeight: "var(--lh-snug)" }}>{t.then}</p>
          )}
        </div>
      ))}

      <p style={{ margin: 0, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", maxWidth: 660 }}>
        Baton shows you the commands rather than running them. Starting a tunnel means owning a
        long-lived process, its credentials and its cleanup — a start button that had never been
        observed working would be worse than a command whose output you can see.
      </p>
    </div>
  );
}

/* ---------- Audit strip ---------- */

/**
 * Owner actions and comings-and-goings, as they happen.
 *
 * Scoped to this page view, and it says so. The event bus is a live stream with
 * no backlog — nothing on this plane is persisted — so a strip that implied it
 * showed "the audit trail" would be claiming a history it does not have. What
 * it is actually good for is the case you'd use these controls in: watching a
 * collision unfold while you deal with it.
 */
interface AuditLine { id: number; at: number; text: string }

function useAudit(subscribe?: (type: string, fn: (e: any) => void) => () => void): AuditLine[] {
  const [lines, setLines] = useState<AuditLine[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (!subscribe) return;
    const push = (text: string) =>
      setLines((prev) => [{ id: ++seq.current, at: Date.now(), text }, ...prev].slice(0, 30));
    const offs = [
      subscribe("member.joined", (e) => push(`${e.memberName} connected`)),
      subscribe("member.left", (e) => push(`${e.memberName} dropped off (no heartbeat)`)),
      // The fact of the warning is room-visible; the TEXT is private to the
      // warned member (their heartbeat delivers it) and never rides the bus.
      subscribe("member.warned", (e) => push(`${e.by} warned ${e.memberName}`)),
      subscribe("member.disconnected", (e) => push(`${e.by} disconnected ${e.memberName}`)),
      subscribe("member.revoked", (e) => push(`${e.by} removed ${e.memberName}`)),
      subscribe("claim.cleared", (e) => push(`${e.by} cleared ${e.memberId}'s claim on ${e.relPath}`)),
      subscribe("team.changed", (e) => push(
        e.action === "assigned" ? `${e.by} moved ${e.memberId} to ${e.teamName}`
          : e.action === "created" ? `${e.by} created team ${e.teamName}`
            : e.action === "removed" ? `${e.by} deleted team ${e.teamName}`
              : `${e.by} changed team ${e.teamName}`)),
      subscribe("claim.conflict", (e) =>
        push(e.sameBranch
          ? `${e.relPath} claimed by ${(e.memberIds ?? []).length} members on one branch`
          : `${e.relPath} claimed on more than one branch`)),
    ];
    return () => offs.forEach((off) => off());
  }, [subscribe]);
  return lines;
}

function AuditStrip({ lines }: { lines: AuditLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="card" style={{ marginTop: 16, padding: "11px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon name="history" size={13} style={{ color: "var(--text-tertiary)" }} />
        <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>Since you opened this page</span>
        {/* Said plainly: this plane keeps no backlog, so neither does the strip. */}
        <span className="tag" style={{ color: "var(--text-tertiary)" }} data-tip="Presence and claims are a live view with no history — reloading clears this list.">
          not kept
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {lines.slice(0, 8).map((l) => (
          <div key={l.id} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: "var(--fs-12)", color: "var(--text-secondary)" }}>
            <span style={{ flex: "none", width: 52, color: "var(--text-quaternary)", fontSize: 11 }}>{timeAgo(l.at)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Screen ---------- */

type Pending =
  | { kind: "warn"; m: MemberRow }
  | { kind: "disconnect"; m: MemberRow }
  | { kind: "remove"; m: MemberRow }
  | { kind: "reissue"; m: MemberRow }
  | { kind: "clear"; c: MemberClaim };

export function TeamScreen({ writeEnabled, subscribe, knownProjects = [] }: {
  writeEnabled: boolean;
  subscribe?: (type: string, fn: (e: any) => void) => () => void;
  /** Hub project ids, for the scope picker. Empty on a single-repo hub. */
  knownProjects?: string[];
}) {
  const team = usePoll<TeamState>(() => BatonAPI.getTeam(), { interval: 10_000 });
  const audit = useAudit(subscribe);
  const [tab, setTab] = useState<"members" | "editing" | "teams" | "share">("members");
  const [pending, setPending] = useState<Pending | null>(null);
  const [warnText, setWarnText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reissued, setReissued] = useState<InviteResult | null>(null);
  const [filterTeam, setFilterTeam] = useState<string | null>(null);

  const data = team.data;
  const canAct = !!data?.viewer.isOwner;
  const members = data?.members ?? [];
  const teams = data?.teams ?? [];
  const active = members.filter((m) => !m.revokedAt);
  const online = active.filter((m) => m.online);
  const allGroups = data ? groupClaims(data) : [];
  const conflicts = allGroups.filter((g) => g.overlap?.sameBranch).length;

  const rosterGroups = groupMembersByTeam(members, teams);
  // Resolved once per render and passed down: the claim list keys off member
  // id, and re-deriving the lookup per row would be the same map N times.
  const memberTeam = new Map(members.map((m) => [m.id, m.team]));
  const selectedTeam = teams.find((t) => t.id === filterTeam) ?? null;
  const groups = visibleGroups(allGroups, selectedTeam, memberTeam);
  const hiddenByFilter = allGroups.length - groups.length;

  const setTeamOf = (m: MemberRow, next: string | null) => {
    void run(next ? `${m.name} moved` : `${m.name} removed from their team`,
      () => BatonAPI.assignMemberTeam(m.id, next).then(() => ({})));
  };

  const close = () => { setPending(null); setWarnText(""); setBusy(false); };

  const run = async (label: string, fn: () => Promise<{ note?: string }>) => {
    setBusy(true);
    try {
      const r = await fn();
      showToast({ kind: "ok", title: label, desc: r.note });
      close();
      team.refetch();
    } catch (e) {
      // Every refusal here is one the server made for a reason worth reading —
      // last owner, member offline, read-only daemon — so show its words.
      showToast({ kind: "error", title: "Not done", desc: (e as ApiError).message });
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === "warn") {
      const msg = warnText.trim();
      if (!msg) return;
      void run(`Notice sent to ${pending.m.name}`, () => BatonAPI.warnMember(pending.m.id, msg).then(() => ({})));
    } else if (pending.kind === "disconnect") {
      void run(`${pending.m.name} disconnected`, () => BatonAPI.disconnectMember(pending.m.id));
    } else if (pending.kind === "remove") {
      void run(`${pending.m.name} removed`, () => BatonAPI.revokeMember(pending.m.id));
    } else if (pending.kind === "reissue") {
      // The new token is shown once, so it goes to its own panel rather than a
      // toast that auto-dismisses while the owner is still copying it.
      void run(`New invite for ${pending.m.name}`, async () => {
        const r = await BatonAPI.rotateMember(pending.m.id);
        setReissued(r);
        return {};
      });
    } else {
      void run("Claim cleared", () => BatonAPI.releaseClaim(pending.c.memberId, pending.c.relPath, pending.c.projectId));
    }
  };

  const subtitle = data
    ? `${online.length} of ${active.length} online · ${data.claims.length} file${data.claims.length === 1 ? "" : "s"} claimed${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"}` : ""}`
    : "Members, presence and file claims across machines";

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ScreenHeader title="Team" subtitle={subtitle}>
        <SegmentedControl value={tab} onChange={setTab} options={[
          { value: "members", label: "Members", icon: "bot" },
          { value: "editing", label: "Editing now", icon: "zap" },
          { value: "teams", label: "Teams", icon: "layers" },
          { value: "share", label: "Share", icon: "share" },
        ]} />
      </ScreenHeader>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 20 }}>
        {team.isLoading && !data ? (
          <div className="skeleton" style={{ height: 220, borderRadius: 12 }} />
        ) : team.error && !data ? (
          /* E5: the host being unreachable must not read as "nobody is here" —
             that is the one false signal this screen cannot afford. */
          <ErrorState title="Couldn't load the team" desc={(team.error as Error).message}
            command="baton serve" onRetry={team.refetch} retrying={team.isFetching} />
        ) : tab === "share" ? (
          <ShareTab canAct={canAct} />
        ) : tab === "teams" ? (
          <TeamsTab teams={teams} members={members} canAct={canAct} writeEnabled={writeEnabled}
            knownProjects={knownProjects} onChanged={team.refetch} />
        ) : members.length === 0 ? (
          /* The invite panel belongs HERE too, not only once a roster exists —
             an empty hub is exactly when someone wants to add the first person. */
          <>
            {canAct && <InvitePanel writeEnabled={writeEnabled} onInvited={team.refetch} />}
            <EmptyState icon="bot" title="Nobody has joined this hub yet"
              desc="Baton runs solo by default. Invite someone above and they get one command to paste in an empty folder — it clones every repo into the same layout and connects them to this hub." />
          </>
        ) : tab === "members" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {canAct ? (
              <InvitePanel writeEnabled={writeEnabled} onInvited={team.refetch} />
            ) : (
              <p style={{ margin: "0 0 4px", fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                You're viewing as a member — inviting, warning, disconnecting and removing are the owner's.
              </p>
            )}
            {reissued && (
              <div className="card" style={{ padding: 14, borderColor: "var(--accent)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Icon name="link" size={14} style={{ color: "var(--accent)" }} />
                  <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)" }}>New invite for {reissued.member.name}</span>
                  <span className="tag" style={{ marginLeft: "auto", color: "var(--dirty-text)" }}>shown once</span>
                </div>
                <p style={{ margin: "0 0 9px", fontSize: "var(--fs-12)", color: "var(--dirty-text)" }}>{reissued.note}</p>
                <CommandLine command={reissued.command} />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button className="btn fr" style={{ height: 28 }} onClick={() => setReissued(null)}>Done</button>
                </div>
              </div>
            )}
            {rosterGroups.map((g) => (
              <div key={g.team?.id ?? "__none"} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* No heading at all until there are teams — on a hub with one
                    flat roster a "No team" bar would be a label for nothing. */}
                {teams.length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                    <Icon name="layers" size={12} style={{ color: "var(--text-quaternary)" }} />
                    <span style={{ fontSize: "var(--fs-12)", fontWeight: "var(--fw-semibold)", color: "var(--text-secondary)" }}>
                      {g.team?.name ?? "No team"}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--text-quaternary)" }}>
                      {g.members.length} member{g.members.length === 1 ? "" : "s"}
                    </span>
                    {g.team && g.team.projects.length > 0 && (
                      <span className="tag" style={{ color: "var(--text-tertiary)" }}
                        data-tip="Which projects this team's rows are filtered to on Editing now. A filter, not a permission.">
                        sees {g.team.projects.join(", ")}
                      </span>
                    )}
                    <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
                  </div>
                )}
                {g.members.length === 0 ? (
                  <p style={{ margin: "0 0 2px", fontSize: "var(--fs-12)", color: "var(--text-quaternary)" }}>
                    Nobody in this team yet — pick it from the dropdown on someone's row.
                  </p>
                ) : g.members.map((m) => (
                  <MemberCard key={m.id} m={m} teams={teams} canAct={canAct} writeEnabled={writeEnabled}
                    onWarn={() => { setWarnText(""); setPending({ kind: "warn", m }); }}
                    onDisconnect={() => setPending({ kind: "disconnect", m })}
                    onRemove={() => setPending({ kind: "remove", m })}
                    onReissue={() => setPending({ kind: "reissue", m })}
                    onTeam={(next) => setTeamOf(m, next)} />
                ))}
              </div>
            ))}
          </div>
        ) : allGroups.length === 0 ? (
          <EmptyState icon="checkCircle" title="Nobody is holding a file right now"
            desc="Files appear here while another member's agent is editing them, so yours can pick something else." />
        ) : (
          <>
            {teams.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
                <TeamFilter teams={teams} value={filterTeam} onChange={setFilterTeam} />
                {selectedTeam && (
                  /* Stated wherever the filter is on, not only in the docs: the
                     one thing this control must never appear to do is hide a
                     collision, so it says out loud that it doesn't. */
                  <span style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)" }}>
                    {hiddenByFilter > 0 ? `${hiddenByFilter} file${hiddenByFilter === 1 ? "" : "s"} hidden. ` : ""}
                    Conflicts are always shown, whichever team they involve.
                  </span>
                )}
              </div>
            )}
            {groups.length === 0 ? (
              /* Filtered to nothing is NOT "nobody is editing" — saying so would
                 send someone to debug a hub that is working perfectly. */
              <EmptyState icon="filter" title={`Nobody in ${selectedTeam?.name ?? "this team"} is holding a file`}
                desc={`${allGroups.length} file${allGroups.length === 1 ? " is" : "s are"} held by members of other teams. Switch the filter to Everyone to see them.`} />
            ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {groups.map((g) => (
                <ClaimGroup key={g.key} g={g} canAct={canAct} writeEnabled={writeEnabled}
                  onClear={(c) => setPending({ kind: "clear", c })} />
              ))}
            </div>
            )}
            {/* Said once, plainly, rather than implied by the absence of a lock icon. */}
            <p style={{ marginTop: 14, fontSize: "var(--fs-12)", color: "var(--text-tertiary)", display: "flex", alignItems: "flex-start", gap: 6, maxWidth: 640 }}>
              <Icon name="alertTriangle" size={12} style={{ color: "var(--text-quaternary)", flex: "none", position: "relative", top: 2 }} />
              <span>
                Claims are advisory — nothing here blocks a write. Agents that call <span className="mono">check_files</span> before
                editing are told who holds a path; the wall against bad code is your protected branch and review, not this list.
              </span>
            </p>
          </>
        )}
        {members.length > 0 && <AuditStrip lines={audit} />}
      </div>

      <ConfirmDialog
        open={pending?.kind === "warn"} onClose={close} onConfirm={confirm} busy={busy}
        tone="warn" icon="alertTriangle" confirmLabel="Send notice"
        title={pending?.kind === "warn" ? `Warn ${pending.m.name}` : ""}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span>It appears in their daemon's output on the next heartbeat, and stays on their row here.</span>
            <textarea value={warnText} onChange={(e) => setWarnText(e.target.value)} rows={3} autoFocus
              placeholder="e.g. src/server.ts is mid-refactor on my side — please take the API tests instead."
              style={{ resize: "vertical", padding: "8px 10px", background: "var(--bg-input)", border: "1px solid var(--border-default)", borderRadius: "var(--r-sm)", color: "var(--text-primary)", fontSize: "var(--fs-13)", fontFamily: "inherit", outline: "none" }} />
          </div>
        } />

      <ConfirmDialog
        open={pending?.kind === "disconnect"} onClose={close} onConfirm={confirm} busy={busy}
        tone="warn" icon="wifiOff" confirmLabel="Disconnect"
        title={pending?.kind === "disconnect" ? `Disconnect ${pending.m.name}?` : ""}
        body="This drops them from the live view and releases their claims. Their token still works, so their daemon reconnects on its next heartbeat — use Remove if that's not what you want." />

      <ConfirmDialog
        open={pending?.kind === "remove"} onClose={close} onConfirm={confirm} busy={busy}
        tone="danger" icon="alertTriangle" confirmLabel="Remove member"
        title={pending?.kind === "remove" ? `Remove ${pending.m.name}?` : ""}
        body={
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span>Their token stops working immediately — the next request they make is refused.</span>
            {/* The sentence people most need before clicking, not buried after. */}
            <strong style={{ fontWeight: "var(--fw-semibold)", color: "var(--text-primary)" }}>
              Anything already cloned or synced stays on their machine. If trust is genuinely broken, rotate your real
              secrets separately — this button cannot.
            </strong>
          </div>
        } />

      <ConfirmDialog
        open={pending?.kind === "reissue"} onClose={close} onConfirm={confirm} busy={busy}
        tone="warn" icon="link" confirmLabel="Reissue token"
        title={pending?.kind === "reissue" ? `Reissue ${pending.m.name}'s token?` : ""}
        body="Their current token stops working immediately, so any machine already using it will need the new command. This replaces rather than adds — two live tokens for one person would make revoking a leaked one guesswork." />

      <ConfirmDialog
        open={pending?.kind === "clear"} onClose={close} onConfirm={confirm} busy={busy}
        tone="warn" icon="trash" confirmLabel="Clear claim"
        title="Clear this claim?"
        body={pending?.kind === "clear"
          ? `Removes ${pending.c.memberName}'s claim on ${pending.c.relPath} from the shared view. If their agent is in fact still editing it, their next heartbeat re-states it — which is correct, and worth knowing.`
          : ""} />
    </div>
  );
}
