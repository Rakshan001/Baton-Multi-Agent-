// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — skill detail

   The card answers "what is this and is it wired in?". This answers
   "what will this actually make my agent DO?" — the full playbook,
   plus the facts that were too small to earn space on a card: where
   each install landed on disk, every reference file, every artifact.

   A dialog rather than a route: the Skills screen is a browse
   surface, and reading one playbook should not cost you your place
   in the list or your search.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { AgentGlyph, getAgent } from "../lib/registry";
import { ApiError, BatonAPI } from "../lib/api";
import { showToast } from "../lib/toast";
import { ConfirmDialog } from "../components/primitives";
import { Label, rule } from "./shared";
import { isUserSkill, type SkillStatus } from "../types";

/** One sidebar block. Renders nothing when it has nothing to say, so a skill
 *  with no reference files doesn't show an empty "Ships" heading. */
function Facet({ title, children }: { title: string; children?: React.ReactNode }) {
  if (children === undefined || children === null || children === false) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Label>{title}</Label><span style={rule} />
      </div>
      {children}
    </div>
  );
}

export function SkillDetail({ skill, writeEnabled, onClose, onChanged, onDelete, onBookmark }: {
  skill: SkillStatus;
  writeEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
  onDelete: () => void;
  onBookmark: (on: boolean) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [updating, setUpdating] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);

  /**
   * Re-fetch from the recorded origin.
   *
   * A skill nobody fetched (a hand upload) has no source, which is an ordinary
   * answer rather than a failure. A local edit is refused, and the refusal
   * offers to overwrite — asked at the moment it matters rather than guessed.
   */
  const doUpdate = async (force: boolean) => {
    setUpdating(true);
    try {
      const r = await BatonAPI.updateSkill(skill.id, force);
      if (r.status === "no-origin") {
        showToast({ kind: "warn", title: "Nothing to update from", desc: `${skill.id} was uploaded rather than fetched from a URL, so there is no source to re-read.` });
      } else if (r.status === "already-current") {
        showToast({ kind: "ok", title: `${skill.id} is already current` });
      } else {
        const n = r.changed?.length ?? 0;
        showToast({ kind: "ok", title: `Updated ${skill.id}`, desc: n ? `${n} file${n === 1 ? "" : "s"} changed.` : undefined });
        onChanged();
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "CONFLICT") setConfirmForce(true);
      else showToast({ kind: "error", title: "Couldn't update that skill", desc: (e as Error).message });
    } finally {
      setUpdating(false);
    }
  };

  // Escape closes, and focus moves into the dialog so a keyboard user is not
  // left tabbing through the list behind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus(), 30);
    return () => { document.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [onClose]);

  const installed = skill.installs.filter((i) => i.installed);
  const mine = isUserSkill(skill.source);

  return (
    <div role="dialog" aria-modal="true" aria-label={`${skill.id} skill`} onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "var(--bg-scrim)", display: "grid", placeItems: "center", padding: 24 }}>
      <div ref={panel} onClick={(e) => e.stopPropagation()}
        style={{ width: "min(980px, 100%)", maxHeight: "86vh", display: "flex", flexDirection: "column", background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: 14, boxShadow: "0 24px 64px rgba(0,0,0,.35)", overflow: "hidden" }}>

        {/* Header */}
        <div style={{ padding: "16px 18px", display: "flex", alignItems: "flex-start", gap: 10, borderBottom: "1px solid var(--border-subtle)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: "var(--fs-21)", fontWeight: "var(--fw-semibold)", color: "var(--accent-text)", letterSpacing: "-0.01em" }}>
              /{skill.id}
            </div>
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-tertiary)", marginTop: 2 }}>
              {mine ? "Your skill" : "Ships with Baton"}
              {skill.source === "imported" && " · this project only"}
              {skill.tags.length > 0 && ` · ${skill.tags.slice(0, 4).join(", ")}`}
            </div>
          </div>
          <button className="btn btn-icon fr" disabled={!writeEnabled}
            aria-label={skill.bookmarked ? `Remove the bookmark on ${skill.id}` : `Bookmark ${skill.id}`}
            aria-pressed={skill.bookmarked}
            data-tip-side="bottom"
            data-tip={!writeEnabled ? "Read-only — run `baton serve --write`" : skill.bookmarked ? "Remove bookmark" : "Pin this to the top of the list"}
            onClick={() => onBookmark(!skill.bookmarked)}
            style={{ flex: "none", color: skill.bookmarked ? "var(--dirty-text)" : undefined }}>
            <Icon name={skill.bookmarked ? "starFilled" : "star"} size={14} />
          </button>
          {mine && writeEnabled && (
            <button className="btn btn-icon fr" disabled={updating} data-tip-side="bottom"
              aria-label={`Re-fetch ${skill.id} from where it came from`}
              data-tip={updating ? "Checking…" : "Re-fetch from source"}
              onClick={() => void doUpdate(false)} style={{ flex: "none" }}>
              <Icon name="refresh" size={13} />
            </button>
          )}
          {mine && (
            <a className="btn btn-icon fr" href={BatonAPI.skillFileUrl(skill.id)} download={`${skill.id}.md`}
              aria-label={`Download ${skill.id}.md`} data-tip-side="bottom" data-tip="Download this skill's markdown"
              style={{ flex: "none", textDecoration: "none" }}>
              <Icon name="share" size={13} />
            </a>
          )}
          {mine && writeEnabled && (
            <button className="btn btn-icon fr" onClick={onDelete}
              aria-label={`Delete the ${skill.id} skill`} data-tip-side="bottom" data-tip="Delete this skill" style={{ flex: "none" }}>
              <Icon name="trash" size={13} />
            </button>
          )}
          <button className="btn btn-sm fr" data-autofocus onClick={onClose} style={{ flex: "none", height: 28 }}>Close</button>
        </div>

        {/* Body: playbook left, facts right. Stacks under 820px. */}
        <div className="skill-detail-body" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: 20, padding: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <Label>Summary</Label><span style={rule} />
              </div>
              {skill.explain ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {([["What", skill.explain.what], ["How", skill.explain.how], ["Win", skill.explain.win]] as const).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                      <span style={{ flex: "none", width: 30 }}><Label tone={k === "Win" ? "accent" : undefined}>{k}</Label></span>
                      <span style={{ fontSize: "var(--fs-13)", lineHeight: 1.6, color: "var(--text-secondary)" }}>{v}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: "var(--fs-13)", lineHeight: 1.65, color: "var(--text-secondary)" }}>
                  {skill.description}
                </p>
              )}
            </div>

            {/* The trigger text is what the AGENT reads to decide relevance —
                distinct from the human summary above, and the thing to edit if
                a skill never fires when you expect it to. */}
            {skill.explain && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <Label>Agent trigger</Label><span style={rule} />
                </div>
                <p style={{ margin: 0, fontSize: "var(--fs-12)", lineHeight: 1.6, color: "var(--text-tertiary)" }}>
                  {skill.description}
                </p>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <Label>Playbook</Label>
                <span className="mono" style={{ fontSize: 9.5, color: "var(--text-quaternary)" }}>
                  {(skill.body.length / 1024).toFixed(1)} KB
                </span>
                <span style={rule} />
              </div>
              <pre className="mono" style={{ margin: 0, padding: "12px 14px", background: "var(--bg-base)", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", fontSize: 11, lineHeight: 1.6, color: "var(--text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 420, overflow: "auto" }}>
                {skill.body.trim() || "This skill has no body."}
              </pre>
            </div>
          </div>

          {/* Facts sidebar */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <Facet title="Invoke with">
              <span className="mono" style={{ fontSize: "var(--fs-13)", color: "var(--accent-text)" }}>/{skill.id}</span>
            </Facet>

            <Facet title="Wired into">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {skill.installs.map((i) => (
                  <div key={i.agent} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span style={{ opacity: i.installed ? 1 : 0.4, display: "inline-flex", flex: "none" }}>
                      <AgentGlyph id={i.agent} size={12} />
                    </span>
                    <span style={{ fontSize: "var(--fs-11)", color: i.installed ? "var(--text-primary)" : "var(--text-quaternary)", flex: "none" }}>
                      {getAgent(i.agent).short}
                    </span>
                    {i.installed
                      ? <span className="mono" data-tip-side="bottom" data-tip={i.rel} style={{ fontSize: 9.5, color: "var(--text-quaternary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.rel}</span>
                      : <span style={{ fontSize: 9.5, color: "var(--text-quaternary)" }}>not installed</span>}
                  </div>
                ))}
                {installed.length === 0 && writeEnabled && (
                  <button className="btn btn-sm btn-primary fr" style={{ marginTop: 4, height: 26 }}
                    onClick={() => void BatonAPI.installSkillEverywhere(skill.id).then(onChanged)}>
                    <Icon name="zap" size={12} /> Add to all
                  </button>
                )}
              </div>
            </Facet>

            {skill.produces.length > 0 && (
              <Facet title="Produces">
                <div style={{ fontSize: "var(--fs-11)", lineHeight: 1.75, color: "var(--text-tertiary)" }}>
                  {skill.produces.join("  ·  ")}
                </div>
              </Facet>
            )}

            {skill.references.length > 0 && (
              <Facet title={`Ships ${skill.references.length} file${skill.references.length === 1 ? "" : "s"}`}>
                <div className="mono" style={{ fontSize: 10.5, lineHeight: 1.8, color: "var(--text-tertiary)", wordBreak: "break-word" }}>
                  {skill.references.map((r) => r.replace(/^references\//, "")).join("  ·  ")}
                </div>
              </Facet>
            )}
          </div>
        </div>
      </div>

      {/* Overwriting someone's own edits is the one thing this feature must
          never do quietly, so it is asked for explicitly. */}
      <ConfirmDialog
        open={confirmForce} onClose={() => setConfirmForce(false)}
        onConfirm={() => { setConfirmForce(false); void doUpdate(true); }}
        tone="warn" icon="refresh" confirmLabel="Overwrite my edits"
        title={`Replace your edits to "${skill.id}"?`}
        body="You have changed this skill since it was fetched. Updating replaces every file with the version from its source, and nothing here can bring your changes back." />
    </div>
  );
}
