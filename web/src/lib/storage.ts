/* ============================================================
   BATON — tiny localStorage helper
   Extracted so both lib/api.ts (demo/scenario/project) and
   hooks/usePrefs.ts (theme/accent/…) can share it without an
   import cycle.
   ============================================================ */
export const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set<T>(k: string, v: T) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  },
};
