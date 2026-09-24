// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Phase 7 / I1 + I2 — one resolver, one slug. Every caller (CLI and MCP) asks
 * `resolveIdentity`, so the self-review ban compares ids produced the same way.
 * Ancestry is injected: nothing here depends on the live process table.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveIdentity, resolveSessionSlug, presenceSlugOf, sessionSlug } from '../src/identity.js';
import { detectAncestry, resetAgentDetectionForTests, type AncestryHit, type Ancestor } from '../src/agents.js';

const env = (e: Record<string, string> = {}) => e as NodeJS.ProcessEnv;
const hit = (agent: string, strict: boolean): (() => Promise<AncestryHit>) => async () => ({ agent, strict, pid: 10 });
const none = async (): Promise<null> => null;

describe('resolveIdentity — env → strict ancestry → client → lenient ancestry → none', () => {
  it('env beats a strict ancestry hit', async () => {
    expect(await resolveIdentity(env({ BATON_AGENT: 'codex' }), undefined, undefined, hit('claude', true))).toEqual({ agent: 'codex', source: 'env' });
  });
  it('strict ancestry beats a client match', async () => {
    const r = await resolveIdentity(env(), undefined, 'x', hit('claude', true), { x: 'gemini' });
    expect(r).toEqual({ agent: 'claude', source: 'ancestry' });
  });
  it('a client match beats a lenient hit', async () => {
    const r = await resolveIdentity(env(), undefined, 'x', hit('claude', false), { x: 'gemini' });
    expect(r).toEqual({ agent: 'gemini', source: 'client' });
  });
  it('a lenient hit alone is ancestry-inferred', async () => {
    expect(await resolveIdentity(env(), undefined, undefined, hit('cursor', false))).toEqual({ agent: 'cursor', source: 'ancestry-inferred' });
  });
  it('nothing → unknown / none', async () => {
    expect(await resolveIdentity(env(), undefined, undefined, none)).toEqual({ agent: 'unknown', source: 'none' });
  });
  it('an ancestry walk that throws is treated as no hit', async () => {
    const boom = async (): Promise<AncestryHit | null> => { throw new Error('ps'); };
    expect(await resolveIdentity(env(), undefined, undefined, boom)).toEqual({ agent: 'unknown', source: 'none' });
  });
  it('BATON_AGENT is sanitized (the real value, not an idealised one)', async () => {
    expect(await resolveIdentity(env({ BATON_AGENT: 'co​dex\n' }), undefined, undefined, none)).toEqual({ agent: 'co dex', source: 'env' });
  });
  it('a clientName with control characters is sanitized before lookup', async () => {
    const r = await resolveIdentity(env(), undefined, 'my\nclient', none, { 'my client': 'gemini' });
    expect(r).toEqual({ agent: 'gemini', source: 'client' });
  });
  it('CLI and MCP agree on the agent when the client name is unmapped', async () => {
    for (const a of [hit('claude', true), hit('cursor', false), none]) {
      const cli = await resolveIdentity(env(), undefined, undefined, a);
      const mcp = await resolveIdentity(env(), undefined, 'some-unmapped-client', a);
      expect(mcp.agent).toBe(cli.agent);
    }
  });
});

describe('a CLI call resolves once, so it waits out a slow ps inline', () => {
  afterEach(() => resetAgentDetectionForTests());
  it('two timeouts, then a success → found in ONE resolveIdentity call', async () => {
    let calls = 0;
    const claude = '/Users/me/.local/bin/claude --resume';
    resetAgentDetectionForTests(async () => (++calls <= 2 ? null : `${process.ppid} 1 ${claude}`));
    expect(await resolveIdentity(env())).toEqual({ agent: 'claude', source: 'ancestry' });
    expect(calls).toBe(3);
  });
  it('gives up at the 3-attempt cap → none', async () => {
    let calls = 0;
    resetAgentDetectionForTests(async () => { calls++; return null; });
    expect(await resolveIdentity(env())).toEqual({ agent: 'unknown', source: 'none' });
    expect(calls).toBe(3);
  });
});

describe('project-defined agents need the root', () => {
  let root: string;
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it('resolves a .baton/agents.json agent only when the root is passed', async () => {
    root = await mkdtemp(join(tmpdir(), 'baton-ident-'));
    await mkdir(join(root, '.baton'), { recursive: true });
    await writeFile(join(root, '.baton', 'agents.json'), JSON.stringify({ agents: [{ id: 'acme', binary: 'acme' }] }));
    const chain = async (): Promise<Ancestor[]> => [{ pid: 5, command: '/usr/local/bin/acme --x' }];
    const walk = (r?: string) => detectAncestry(r, chain);
    expect((await resolveIdentity(env(), root, undefined, walk)).agent).toBe('acme');
    expect((await resolveIdentity(env(), undefined, undefined, walk)).agent).not.toBe('acme');
  });
});

describe('one slug (I1)', () => {
  it('resolveSessionSlug without BATON_SLUG is the presence slug sess-p<pid>', () => {
    expect(resolveSessionSlug(env())).toBe(sessionSlug(`p${process.pid}`));
    expect(resolveSessionSlug(env())).toBe(`sess-p${process.pid}`);
  });
  it('BATON_SLUG still wins', () => {
    expect(resolveSessionSlug(env({ BATON_SLUG: 't-login' }))).toBe('t-login');
  });
  it('presenceSlugOf maps a legacy pid- claim slug and leaves others alone', () => {
    expect(presenceSlugOf('pid-4242')).toBe('sess-p4242');
    expect(presenceSlugOf('sess-p4242')).toBe('sess-p4242');
    expect(presenceSlugOf('t-login')).toBe('t-login');
  });
});
