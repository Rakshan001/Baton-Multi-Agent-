/* ============================================================
   BATON — Git diff viewer (ported from diff.jsx)
   Real mode streams GET /api/tasks/:slug/diff (commits + working
   tree vs the task's base); demo mode renders scripted fixtures.
   ============================================================ */
import { useState, useRef, useEffect, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { AgentBadge, SegmentedControl, EmptyState, CopyButton } from "../components/primitives";
import { getAgent } from "../lib/registry";
import { branchFor, BatonAPI } from "../lib/api";
import { useMediaQuery } from "../hooks/useMediaQuery";
import type { StatusRow, DiffHunk, DiffLine, FileStatus, DiffFile } from "../types";

const SYN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(import|export|from|const|let|var|return|async|await|function|new|type|interface|enum|if|else|for|while|do|switch|case|class|extends|implements|default|true|false|null|undefined|void|public|private|protected|readonly|this|in|of|as|CREATE|INDEX|ON|TABLE|SELECT|FROM|WHERE)\b|\b([A-Z][A-Za-z0-9_]*)\b|\b(\d[\d_.]*)\b/g;
function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = []; let last = 0; let m: RegExpExecArray | null; let key = 0;
  SYN.lastIndex = 0;
  while ((m = SYN.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? "--syn-com" : m[2] ? "--syn-str" : m[3] ? "--syn-key" : m[4] ? "--syn-type" : m[5] ? "--syn-num" : null;
    out.push(<span key={key++} style={{ color: `var(${cls})` }}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

const FILE_STATUS: Record<FileStatus, { c: string; soft: string; glyph: string; tip: string }> = {
  added: { c: "var(--clean-text)", soft: "var(--clean-soft)", glyph: "A", tip: "Added" },
  modified: { c: "var(--dirty-text)", soft: "var(--dirty-soft)", glyph: "M", tip: "Modified" },
  deleted: { c: "var(--conflict-text)", soft: "var(--conflict-soft)", glyph: "D", tip: "Deleted" },
};

export function DiffStat({ add, del, size = "md" }: { add: number; del: number; size?: "sm" | "md" }) {
  const total = Math.max(1, add + del); const blocks = 5;
  const addBlocks = Math.round((add / total) * blocks);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className="mono" style={{ fontSize: size === "sm" ? 11 : 12, color: "var(--diff-add-mark)" }}>+{add}</span>
      <span className="mono" style={{ fontSize: size === "sm" ? 11 : 12, color: "var(--diff-del-mark)" }}>−{del}</span>
      <span style={{ display: "inline-flex", gap: 1.5 }} aria-hidden="true">
        {Array.from({ length: blocks }).map((_, i) => (
          <span key={i} style={{ width: 6, height: 6, borderRadius: 1.5, background: i < addBlocks ? "var(--diff-add-mark)" : (add + del > 0 && i < addBlocks + Math.max(1, blocks - addBlocks) ? "var(--diff-del-mark)" : "var(--border-default)") }} />
        ))}
      </span>
    </span>
  );
}

function zipHunk(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.t === "ctx") { rows.push({ left: l, right: l }); i++; continue; }
    const dels: DiffLine[] = [], adds: DiffLine[] = [];
    while (i < lines.length && lines[i].t === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].t === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return rows;
}

function CodeLine({ children }: { children: ReactNode }) {
  return <span style={{ whiteSpace: "pre", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: "20px" }}>{children}</span>;
}

function UnifiedLines({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="mono" style={{ display: "flex", padding: "3px 0", background: "var(--accent-soft)", color: "var(--accent-text)", fontSize: 12, borderTop: hi ? "1px solid var(--border-subtle)" : "none", borderBottom: "1px solid var(--border-subtle)" }}>
            <span style={{ width: 96, flex: "none" }} /> <span style={{ paddingLeft: 8 }}>{h.header}</span>
          </div>
          {h.lines.map((l, i) => {
            const bg = l.t === "add" ? "var(--diff-add-bg)" : l.t === "del" ? "var(--diff-del-bg)" : "transparent";
            const gut = l.t === "add" ? "var(--diff-add-gutter)" : l.t === "del" ? "var(--diff-del-gutter)" : "transparent";
            const mark = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
            const markC = l.t === "add" ? "var(--diff-add-mark)" : l.t === "del" ? "var(--diff-del-mark)" : "var(--text-quaternary)";
            return (
              <div key={i} style={{ display: "flex", background: bg, minHeight: 20 }}>
                <span className="mono" style={{ width: 48, flex: "none", textAlign: "right", padding: "0 8px", color: "var(--code-gutter)", fontSize: 11.5, lineHeight: "20px", background: gut, userSelect: "none" }}>{l.o ?? ""}</span>
                <span className="mono" style={{ width: 48, flex: "none", textAlign: "right", padding: "0 8px", color: "var(--code-gutter)", fontSize: 11.5, lineHeight: "20px", background: gut, userSelect: "none" }}>{l.n ?? ""}</span>
                <span style={{ width: 16, flex: "none", textAlign: "center", color: markC, fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: "20px", userSelect: "none" }}>{mark}</span>
                <CodeLine>{highlight(l.s)}</CodeLine>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SplitCol({ line }: { line: DiffLine | null }) {
  if (!line) return <div style={{ flex: 1, background: "var(--code-line-hover)", minHeight: 20 }} />;
  const bg = line.t === "add" ? "var(--diff-add-bg)" : line.t === "del" ? "var(--diff-del-bg)" : "transparent";
  const gut = line.t === "add" ? "var(--diff-add-gutter)" : line.t === "del" ? "var(--diff-del-gutter)" : "transparent";
  const no = line.t === "add" ? line.n : line.o;
  return (
    <div style={{ flex: 1, display: "flex", background: bg, minHeight: 20, minWidth: 0 }}>
      <span className="mono" style={{ width: 44, flex: "none", textAlign: "right", padding: "0 8px", color: "var(--code-gutter)", fontSize: 11.5, lineHeight: "20px", background: gut, userSelect: "none" }}>{no ?? ""}</span>
      <span style={{ overflowX: "auto" }}><CodeLine>{highlight(line.s)}</CodeLine></span>
    </div>
  );
}
function SplitLines({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <div>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="mono" style={{ padding: "3px 12px", background: "var(--accent-soft)", color: "var(--accent-text)", fontSize: 12, borderTop: hi ? "1px solid var(--border-subtle)" : "none", borderBottom: "1px solid var(--border-subtle)" }}>{h.header}</div>
          {zipHunk(h.lines).map((r, i) => (
            <div key={i} style={{ display: "flex" }}>
              <SplitCol line={r.left} />
              <span style={{ width: 1, background: "var(--border-subtle)", flex: "none" }} />
              <SplitCol line={r.right} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DiffViewer({
  slug, session, onClose, onHandoff, writeEnabled,
}: {
  slug: string;
  session?: StatusRow;
  onClose: () => void;
  onHandoff: (slug: string) => void;
  writeEnabled: boolean;
}) {
  const [files, setFiles] = useState<DiffFile[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let on = true;
    setFiles(null); setLoadError(null); setActive(0);
    BatonAPI.getDiff(slug)
      .then((f) => { if (on) setFiles(f); })
      .catch((e) => { if (on) { setFiles([]); setLoadError((e as Error).message); } });
    return () => { on = false; };
  }, [slug]);
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const isWide = useMediaQuery("(min-width: 980px)");
  const ref = useRef<HTMLDivElement>(null);
  const agentId = session?.agent ?? null;
  const taskTitle = session?.task || slug;
  const list = files ?? [];
  const totals = list.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 });

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "[" && active > 0) setActive((a) => a - 1);
      else if (e.key === "]" && active < list.length - 1) setActive((a) => a + 1);
    };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => ref.current?.focus(), 40);
    return () => { document.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [active, list.length, onClose]);

  const f = list[active];

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: "var(--z-overlay)" as unknown as number, display: "grid", placeItems: "center", padding: "min(4vh, 32px) min(4vw, 40px)" }}>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "var(--bg-scrim)", backdropFilter: "blur(3px)", animation: "fade-in var(--dur-2)" }} />
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Changes for ${taskTitle}`} style={{
        position: "relative", width: "min(1180px, 100%)", height: "min(820px, 100%)", background: "var(--bg-surface)",
        border: "1px solid var(--border-strong)", borderRadius: "var(--r-xl)", boxShadow: "var(--shadow-xl)", overflow: "hidden",
        display: "flex", flexDirection: "column", animation: "scale-in var(--dur-3) var(--ease-out)" }}>

        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 12px 11px 16px", borderBottom: "1px solid var(--border-subtle)", background: "var(--bg-surface-2)", flex: "none" }}>
          <span style={{ display: "flex", gap: 6 }} aria-hidden="true">
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} style={{ width: 11, height: 11, borderRadius: 99, background: c, opacity: 0.9 }} />)}
          </span>
          <AgentBadge id={agentId} size="sm" showLabel={false} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "var(--fs-13)", fontWeight: "var(--fw-semibold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{taskTitle}</span>
              {BatonAPI.demo && <span style={{ fontSize: 10, fontWeight: "var(--fw-semibold)", letterSpacing: "var(--ls-caps)", textTransform: "uppercase", color: "var(--text-tertiary)", background: "var(--bg-surface)", border: "1px dashed var(--border-default)", borderRadius: 99, padding: "2px 7px" }} data-tip="Demo mode — this diff is illustrative.">Preview</span>}
            </div>
            <div className="mono" style={{ fontSize: "var(--fs-11)", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="gitBranch" size={11} /> {branchFor(slug)} <span style={{ color: "var(--text-quaternary)" }}>·</span> <DiffStat add={totals.add} del={totals.del} size="sm" />
            </div>
          </div>
          {isWide && <SegmentedControl size="sm" ariaLabel="Diff view" value={mode} onChange={setMode}
            options={[{ value: "unified", label: "Unified", icon: "list" }, { value: "split", label: "Split", icon: "columns" }]} />}
          <button className="btn btn-ghost btn-icon fr" onClick={onClose} aria-label="Close diff · Esc" data-tip="Close · Esc" data-tip-side="bottom"><Icon name="x" size={16} /></button>
        </div>

        {files === null ? (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            <div className="skeleton" style={{ width: 320, height: 14 }} aria-label="Loading diff…" />
          </div>
        ) : list.length === 0 ? (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            {loadError
              ? <EmptyState icon="gitCommit" title="Couldn't load the diff" desc={loadError} />
              : <EmptyState icon="gitCommit" title="No changes on this branch" desc="This session hasn't produced any file changes yet." />}
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div style={{ width: 256, flex: "none", borderRight: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", background: "var(--bg-surface)" }}>
              <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border-subtle)", display: "flex", alignItems: "center", gap: 7 }}>
                <Icon name="folder" size={13} style={{ color: "var(--text-tertiary)" }} />
                <span className="tag">{list.length} changed file{list.length === 1 ? "" : "s"}</span>
              </div>
              <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
                {list.map((file, i) => {
                  const st = FILE_STATUS[file.status]; const on = i === active;
                  return (
                    <button key={file.path} className="fr" onClick={() => setActive(i)} aria-current={on} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", borderRadius: "var(--r-sm)", border: "none", cursor: "pointer", textAlign: "left", background: on ? "var(--bg-active)" : "transparent", marginBottom: 1 }}
                      onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = "transparent"; }}>
                      <span style={{ width: 16, height: 16, flex: "none", borderRadius: 4, display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: st.c, background: st.soft }} data-tip={st.tip}>{st.glyph}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: "block", fontSize: "var(--fs-12)", color: on ? "var(--text-primary)" : "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left" }}>{file.path}</span>
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--text-quaternary)", flex: "none" }}>+{file.add}</span>
                    </button>
                  );
                })}
              </div>
              <div style={{ padding: 10, borderTop: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", gap: 7 }}>
                <button className={"btn fr " + (writeEnabled ? "btn-primary" : "")} disabled={!writeEnabled} onClick={writeEnabled ? () => onHandoff(slug) : undefined}
                  data-tip={writeEnabled ? undefined : "Read-only — start `baton serve --write`"} style={{ width: "100%", ...(writeEnabled ? {} : { opacity: 0.55, cursor: "not-allowed" }) }}>
                  <Icon name="share" size={13} /> Hand off this work
                </button>
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "var(--code-bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid var(--border-subtle)", flex: "none", background: "var(--bg-surface)" }}>
                <span style={{ width: 16, height: 16, flex: "none", borderRadius: 4, display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: FILE_STATUS[f.status].c, background: FILE_STATUS[f.status].soft }}>{FILE_STATUS[f.status].glyph}</span>
                <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-12)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path}</span>
                <DiffStat add={f.add} del={f.del} size="sm" />
                <CopyButton value={f.path} iconOnly className="btn btn-sm btn-ghost" title="Copy path" />
              </div>
              <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                {mode === "split" && isWide ? <SplitLines hunks={f.hunks} /> : <UnifiedLines hunks={f.hunks} />}
                <div style={{ padding: "10px 14px", color: "var(--text-quaternary)", fontSize: "var(--fs-11)", display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border-subtle)" }}>
                  <span className="kbd">[</span><span className="kbd">]</span> switch files · <span className="kbd">esc</span> close
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
