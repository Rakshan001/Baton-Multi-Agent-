// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Attachments (spec D Rev 3 §9, Team Sync §12.4)
   Chips plus previews. `kind` comes from the blob server's sniffing, not
   the file name. Images and PDFs preview only from the separate loopback
   blob origin (`blobUrl`): images in <img>, PDFs in a sandboxed iframe.
   Markdown shows as plain text. SVG and HTML are download-only.
   Without a blobUrl (demo fixtures), stand-ins are drawn instead.
   ============================================================ */
import { useState, type DragEvent } from "react";
import { Download, File, FileCode2, FileImage, FileText, FileType, Paperclip, Upload, type LucideIcon } from "lucide-react";
import { cn, focusRing } from "@/lib/utils";
import { inlinePreviewable, kindFromMime, safeBlobUrl, sanitizeName } from "@/lib/teamApi";
import { showToast } from "@/lib/toast";
import type { TeamAttachment } from "@/types";
import { fmtBytes } from "./ui";

const ICON: Record<TeamAttachment["kind"], LucideIcon> = {
  image: FileImage, pdf: FileText, markdown: FileType, svg: FileCode2, html: FileCode2, other: File,
};

function Preview({ a }: { a: TeamAttachment }) {
  const src = safeBlobUrl(a.blobUrl);
  if (a.kind === "image") {
    if (src) return <img src={src} alt={`Preview of ${a.name}`} className="h-56 w-full rounded-md border border-border-subtle object-contain max-sm:h-40" />;
    return (
      <div role="img" aria-label={`Preview of ${a.name}`} className="grid h-56 place-items-center rounded-md border border-border-subtle text-xs text-white max-sm:h-40"
        style={{ background: `linear-gradient(135deg, hsl(${Number(a.previewHue) || 210} 45% 32%), hsl(${((Number(a.previewHue) || 210) + 40) % 360} 45% 22%))` }}>
        {a.name}
      </div>
    );
  }
  if (a.kind === "pdf") {
    // sandbox="" : no scripts, no forms, no same-origin, no top navigation.
    if (src) return <iframe src={src} sandbox="" title={`PDF: ${a.name}`} className="h-96 w-full rounded-md border border-border-subtle bg-background" />;
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-1 rounded-md border border-border-subtle bg-background text-xs text-muted-foreground max-sm:h-40">
        <FileText aria-hidden className="size-6" />
        <span>{a.previewText ?? a.name}</span>
        <span className="text-[11px]">Opens in the sandboxed PDF viewer</span>
      </div>
    );
  }
  // Markdown: raw text, never parsed into HTML.
  return (
    <pre className="max-h-48 overflow-auto rounded-md border border-border-subtle bg-background p-3 font-mono text-[12px] break-words whitespace-pre-wrap">{a.previewText ?? ""}</pre>
  );
}

export function AttachmentList({ items, previews = true }: { items: TeamAttachment[]; previews?: boolean }) {
  const [open, setOpen] = useState<string | null>(items.find(inlinePreviewable)?.id ?? null);
  if (items.length === 0) return <p className="text-[13px] text-muted-foreground">No attachments.</p>;
  const shown = items.find((a) => a.id === open);
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex list-none flex-wrap gap-1.5" aria-label="Attachments">
        {items.map((a) => {
          const Icon = ICON[a.kind];
          return (
            <li key={a.id}>
              {inlinePreviewable(a) ? (
                <button type="button" aria-pressed={open === a.id} onClick={() => setOpen(a.id)}
                  className={cn("inline-flex h-8 max-w-64 items-center gap-1.5 rounded-md border border-border-subtle bg-background px-2 text-xs hover:bg-accent aria-pressed:border-border-strong aria-pressed:bg-selected max-md:h-11", focusRing)}>
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-muted-foreground">{fmtBytes(a.sizeBytes)}</span>
                </button>
              ) : (
                <span className="inline-flex h-8 max-w-72 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-xs max-md:h-11">
                  <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-muted-foreground">Download only</span>
                  {safeBlobUrl(a.blobUrl) ? (
                    <a href={safeBlobUrl(a.blobUrl)!} download={a.name} aria-label={`Download ${a.name}`} className={cn("ml-0.5 grid size-6 place-items-center rounded hover:bg-accent", focusRing)}>
                      <Download aria-hidden className="size-3.5" />
                    </a>
                  ) : (
                    <button type="button" aria-label={`Download ${a.name}`}
                      onClick={() => showToast({ kind: "info", title: `Downloading ${a.name}`, desc: "Saved as a file; never opened in the dashboard." })}
                      className={cn("ml-0.5 grid size-6 place-items-center rounded hover:bg-accent", focusRing)}>
                      <Download aria-hidden className="size-3.5" />
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {previews && shown && <Preview a={shown} />}
    </div>
  );
}

/** Drag-and-drop or pick files. Designers may attach images and PDFs only (Team Sync §5.2). */
export function AttachmentDrop({ onAdd, designer = false }: { onAdd: (a: TeamAttachment[]) => void; designer?: boolean }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accept = designer ? "image/*,application/pdf" : "image/*,application/pdf,text/markdown,.md,image/svg+xml,text/html";

  const take = (files: FileList | null) => {
    if (!files?.length) return;
    const out: TeamAttachment[] = [];
    const refused: string[] = [];
    for (const f of Array.from(files)) {
      // Demo stand-in for the server's sniffing: the browser's MIME type, not the name.
      const kind = kindFromMime(f.type || (f.name.toLowerCase().endsWith(".md") ? "text/markdown" : ""));
      if (designer && kind !== "image" && kind !== "pdf") { refused.push(`${f.name}: designers can attach images and PDFs`); continue; }
      if (f.size > 25 * 1_048_576) { refused.push(`${f.name}: over 25 MB`); continue; }
      out.push({ id: `up-${Date.now()}-${out.length}`, name: sanitizeName(f.name), kind, sizeBytes: f.size, previewText: kind === "markdown" ? "(preview after upload)" : undefined, previewHue: 200 });
    }
    setError(refused.length ? `Not added: ${refused.join("; ")}.` : null);
    if (out.length) onAdd(out);
  };

  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); };

  return (
    <div className="flex flex-col gap-1.5">
      <label onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        className={cn("flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground transition-colors hover:bg-accent/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background", over && "border-border-strong bg-accent")}>
        <Upload aria-hidden className="size-4" />
        <span><span className="font-medium text-foreground">Drop files</span> or choose</span>
        <span>{designer ? "Images or PDF" : "Images, PDF or Markdown. SVG and HTML are download-only."}</span>
        <input type="file" multiple accept={accept} className="sr-only" onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      </label>
      {error && <p role="alert" className="text-xs text-status-danger-foreground">{error}</p>}
    </div>
  );
}

export function AttachmentCount({ n }: { n: number }) {
  if (!n) return null;
  return <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"><Paperclip aria-hidden className="size-3" />{n}<span className="sr-only"> attachments</span></span>;
}
