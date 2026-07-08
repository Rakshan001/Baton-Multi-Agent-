/**
 * Output contracts for the coordination MCP server. Every agent pays tokens for
 * each response, so responses are compact (no pretty-print) and unbounded lists
 * are capped with an honest "N more" — Serena's "shortened result" discipline.
 */

/** Wrap data as an MCP text result — compact JSON (indenting is a ~15-25% tax). */
export const asText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});

/** Cap a list, reporting how many were dropped so the agent knows it's partial. */
export function capList<T>(items: T[], limit: number): { items: T[]; more: number } {
  if (items.length <= limit) return { items, more: 0 };
  return { items: items.slice(0, limit), more: items.length - limit };
}
