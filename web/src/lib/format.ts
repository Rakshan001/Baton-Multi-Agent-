/* ============================================================
   BATON — shared formatting helpers (ported from api.jsx)
   ============================================================ */

export function timeAgo(input: string | number | null | undefined): string {
  if (!input) return "—";
  const t = typeof input === "number" ? input : new Date(input).getTime();
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7);
  if (w < 5) return w + "w ago";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function timeAgoShort(input: string | number | null | undefined): string {
  return timeAgo(input).replace(" ago", "");
}

export function basename(p: string): string {
  return p.split("/").pop() || p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
}

/** Progress is an ESTIMATE derived from `ahead` (commits). Never a fake %. */
export function progressEstimate(ahead: number): number {
  if (ahead <= 0) return 0;
  return Math.min(1, 1 - Math.pow(0.72, ahead));
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
    return true;
  }
}
