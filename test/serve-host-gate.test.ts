/**
 * `baton serve --host` must FAIL CLOSED.
 *
 * Binding a network address with no member registered would publish the
 * knowledge base, the task list and every mutating endpoint to whoever can route
 * to the port. This is the one check in the codebase that must never degrade
 * into a warning, so it gets an end-to-end test rather than a unit test of the
 * predicate.
 *
 * Note these cases never reach `listen()` — the refusal happens first — so
 * running this suite does not expose a daemon on any interface.
 *
 * Gated on dist/cli.js being built (run `npm run build` first).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

const DIST_CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const hasDist = existsSync(DIST_CLI);

interface Run { exitCode: number; stderr: string; stdout: string }

async function runCli(args: string[], cwd: string): Promise<Run> {
  try {
    const r = await execa('node', [DIST_CLI, ...args], { cwd, timeout: 25_000, reject: false });
    return { exitCode: r.exitCode ?? 0, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
  } catch (e) {
    const err = e as { exitCode?: number; stderr?: string; stdout?: string };
    return { exitCode: err.exitCode ?? 1, stderr: err.stderr ?? '', stdout: err.stdout ?? '' };
  }
}

describe.runIf(hasDist)('baton serve --host fails closed', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function repo(): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'baton-hostgate-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
    return dir;
  }

  it('refuses to bind a network address when no member exists', async () => {
    const cwd = await repo();
    // 0.0.0.0 would be the widest possible exposure; it must be the one most
    // certainly refused. Nothing binds — the check runs before listen().
    const r = await runCli(['serve', '--host', '0.0.0.0', '--port', '7391'], cwd);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/refusing to bind/);
    expect(r.stderr).toMatch(/baton member add/);
  });

  it('refuses for a specific network address too, not just the wildcard', async () => {
    const cwd = await repo();
    const r = await runCli(['serve', '--host', '10.255.255.1', '--port', '7392'], cwd);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/refusing to bind/);
  });

  it('rejects a malformed --host before it reaches bind()', async () => {
    const cwd = await repo();
    const r = await runCli(['serve', '--host', 'not a host!', '--port', '7393'], cwd);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Invalid --host/);
  });

  /*
   * The corollary: a loopback daemon must NOT have gained a credential
   * requirement. Local-first is the normal way to run Baton and this whole phase
   * is supposed to be invisible to it.
   */
  it('still starts on loopback with no members at all', async () => {
    const cwd = await repo();
    const child = execa('node', [DIST_CLI, 'serve', '--port', '7394'], { cwd, reject: false });
    try {
      const deadline = Date.now() + 20_000;
      let ok = false;
      while (Date.now() < deadline && !ok) {
        try {
          const res = await fetch('http://127.0.0.1:7394/api/meta', { signal: AbortSignal.timeout(1000) });
          ok = res.ok;
        } catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      expect(ok).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await child.catch(() => undefined);
    }
  });
});

describe.runIf(hasDist)('baton member', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

  /*
   * 30 s, not the 5 s default: this spawns the real CLI eight times over. It
   * measured ~4.8 s alone — inside the default by 200 ms — so it passed on its
   * own and failed whenever the full suite loaded the machine. A test that is
   * red only sometimes is worse than one that is red, because it teaches people
   * to re-run instead of read.
   */
  it('mints a token once, lists it, and revokes it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'baton-memcli-'));
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await execa('git', ['config', 'user.email', 't@t.dev'], { cwd: dir });
    await execa('git', ['config', 'user.name', 't'], { cwd: dir });
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });

    const added = await runCli(['member', 'add', 'Priya Sharma'], dir);
    expect(added.exitCode).toBe(0);
    const token = /baton_[0-9a-f]{64}/.exec(added.stdout)?.[0];
    expect(token).toBeTruthy();
    expect(added.stdout).toMatch(/owner/);

    const listed = await runCli(['member', 'list'], dir);
    expect(listed.stdout).toMatch(/priya-sharma/);
    // the token itself must never be recoverable after mint
    expect(listed.stdout).not.toContain(token!);

    // sole owner cannot be revoked; a second member can
    const soleOwner = await runCli(['member', 'revoke', 'priya-sharma'], dir);
    expect(soleOwner.exitCode).toBe(1);
    expect(soleOwner.stderr).toMatch(/only owner/);

    await runCli(['member', 'add', 'Sam'], dir);
    const revoked = await runCli(['member', 'revoke', 'sam'], dir);
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toMatch(/revoked/);
    // and it is honest about what revocation cannot undo
    expect(revoked.stdout).toMatch(/already cloned or read stays/);
  }, 30_000);
});
