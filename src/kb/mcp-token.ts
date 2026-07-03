/** Per-repo secret embedded in the daemon's graphify proxy URL, so only clients
 *  holding Baton's written MCP config (not a random local web page) can query
 *  the graph. Persisted so it survives daemon restarts (configs stay valid). */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonDir } from '../store.js';

export function getMcpToken(root: string): string {
  const file = join(batonDir(root), 'mcp-token');
  try {
    const t = readFileSync(file, 'utf-8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* create below */ }
  const token = randomBytes(16).toString('hex');
  mkdirSync(batonDir(root), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}
