import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getMcpToken } from '../src/kb/mcp-token.js';

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('creates a stable 32-hex-char token once and reuses it', async () => {
  root = await mkdtemp(join(tmpdir(), 'baton-tok-'));
  await mkdir(join(root, '.baton'), { recursive: true });
  const a = getMcpToken(root);
  expect(a).toMatch(/^[0-9a-f]{32}$/);
  expect(getMcpToken(root)).toBe(a); // stable across calls (persisted)
  expect((await readFile(join(root, '.baton', 'mcp-token'), 'utf-8')).trim()).toBe(a);
});
