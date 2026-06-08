/**
 * Side-effect module: suppress the harmless `node:sqlite` experimental warning.
 * Must be imported FIRST (before anything that loads node:sqlite) — ES import
 * hoisting means a separate first-imported module is the reliable way to do this.
 */
const orig = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message;
  if (typeof msg === 'string' && msg.includes('SQLite is an experimental')) return;
  return (orig as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;
