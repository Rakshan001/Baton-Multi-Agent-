/**
 * The anti-capture gate.
 *
 * The load-bearing half of this suite is `MUST BE ACCEPTED` — a corpus drawn
 * from things this repo actually believes (CLAUDE.md conventions, real gotchas
 * from src/, real code comments). A gate that rejects those is worse than no
 * gate: it would push agents to rephrase true knowledge until it slips past,
 * which is exactly how a safety check gets routed around.
 */
import { describe, it, expect } from 'vitest';
import { classifyDurability, normalizeForMatch } from '../src/memory-durability.js';

const classify = (fact: string, opts?: { anchored?: boolean }) => classifyDurability(fact, opts ?? {});

describe('MUST BE ACCEPTED — real facts from this repo', () => {
  const durable = [
    'The daemon stays zero-dependency: src/server.ts is raw node:http. No express or fastify, by explicit decision.',
    'Realtime is SSE, not socket.io — every live event flows through the bus in src/events.ts, and new event types go there first.',
    'Git calls go through src/util/exec.ts (hardened, shell-free). Never shell out to git directly.',
    'graphify RAM climbs from 720MB to 1.8GB on large repos — chunk the walk instead of loading every file.',
    'npm run build fails on node 22 because node:sqlite lacks FTS5 — the floor is node 24.',
    'check_files returns busy=false when the daemon is unreachable; never present that as "nobody is editing", it means unknown.',
    'The host rejects a revoked token with 401, so remote claims become unavailable rather than empty — callers branch on the reachable flag.',
    'Demo mode defaults ON only on the Vite dev origin; gate real-mode behaviour on BatonAPI.demo in web/src/lib/api.ts.',
    'A session at a hub root is not inside a git repo, so the guard falls back to the repo the edited file lives in.',
    'Facts with no file anchors go stale after 50 commits because nothing verifies them.',
    'The tool registry is a process singleton, so a second registration of the same name silently wins.',
    'Test x is flaky under parallel load — run it with --pool=forks when it matters.',
    // "cannot be used" reads like disparagement and is nearly always a real
    // constraint. These three are conventions this repo actually holds, and a
    // rule that rejected them was removed rather than kept and worked around.
    '.refs/ holds reference open-source code for learning — it cannot be used from src at all.',
    'SSE goes over fetch() because EventSource cannot be used with a header carrying the token.',
    'A read-only daemon cannot be used to resolve findings, so the resolve route answers 403.',
  ];

  for (const fact of durable) {
    it(`accepts: ${fact.slice(0, 58)}…`, () => {
      expect(classifyDurability(fact)).toBeNull();
    });
  }
});

describe('environment-dependent failures', () => {
  it('rejects a bare missing-binary report', () => {
    const f = classify('npm test fails with "command not found: vitest" because vitest is not installed here.');
    expect(f?.kind).toBe('environment');
    expect(f?.instead).toMatch(/save the FIX/i);
  });

  it('accepts the same knowledge once it carries the fix', () => {
    expect(classify('npm test fails with "command not found: vitest" — run npm ci first.')).toBeNull();
  });

  it('accepts it when anchored to explicit files', () => {
    expect(classify('The postinstall step reports command not found on a clean clone.', { anchored: true })).toBeNull();
  });

  it('rejects unset-credential reports', () => {
    expect(classify('graphify enrichment is skipped because the ANTHROPIC_API_KEY is not set on this machine.')?.kind)
      .toBe('environment');
  });

  it('quotes the phrase that tripped so the agent knows what to rewrite', () => {
    expect(classify('The build died: no such file or directory, over and over again today.')?.matched)
      .toBe('no such file or directory');
  });
});

describe('standalone tool disparagement', () => {
  it('rejects a bare "is broken"', () => {
    const f = classify('The browser tool is broken, so there is no point reaching for it.');
    expect(f?.kind).toBe('tool-disparagement');
    // The rationale is the whole reason this class exists — keep it in the message.
    expect(f?.instead).toMatch(/hardens into a refusal/);
  });

  it('rejects "does not work" with no remedy and no evidence', () => {
    expect(classify('Playwright does not work in this environment.')?.kind).toBe('tool-disparagement');
    expect(classify("Playwright doesn't work in this environment.")?.kind).toBe('tool-disparagement');
  });

  it('accepts the same claim when it names the workaround', () => {
    expect(classify('The Vite proxy does not work against the daemon in demo mode — point it at :7077 instead.')).toBeNull();
  });

  it('accepts it when anchored, because staleness can then police it', () => {
    expect(classify('The demo toggle does not work in real mode.', { anchored: true })).toBeNull();
  });
});

describe('transient errors — nothing waives these', () => {
  it('rejects a self-resolving failure even with a remedy word present', () => {
    expect(classify('The install failed once but it passed on the second run, so just rerun it.')?.kind).toBe('transient');
  });

  it('rejects it even when anchored', () => {
    expect(classify('The watch test failed, then the retry fixed it.', { anchored: true })?.kind).toBe('transient');
  });

  it('does NOT reject a durable flakiness gotcha', () => {
    // "flaky" alone is real knowledge; only the self-resolution phrasing trips.
    expect(classify('The checkout-edit watch tests are flaky under load because two stacked bugs race.')).toBeNull();
  });
});

describe('session narratives — nothing waives these either', () => {
  it('rejects first-person session narration', () => {
    expect(classify('In this session I fixed the guard bug and pushed the branch.')?.kind).toBe('narrative');
    expect(classify('Today we implemented the anti-capture gate and ran the suite.')?.kind).toBe('narrative');
    expect(classify('I just fixed the reconcile path after two failed attempts.')?.kind).toBe('narrative');
  });

  it('rejects narration even when anchored to files', () => {
    expect(classify('In this session we changed src/memory.ts and src/mcp.ts.', { anchored: true })?.kind)
      .toBe('narrative');
  });

  it('does NOT reject collective decisions phrased with "we"', () => {
    // "we chose/decided" is how a convention is stated — only session-scoped
    // markers ("this session", "today we fixed") are narratives.
    expect(classify('We chose SSE over socket.io so the daemon keeps zero dependencies.')).toBeNull();
    expect(classify('We just use the repo default when no author is configured.')).toBeNull();
  });
});

describe('the remedy waiver — a remedy-shaped WORD is not a remedy', () => {
  // Found by review: the waiver tested for bare `run`/`set`/`install`/`export`
  // anywhere in the fact, so a standalone grudge waived itself on a noun that
  // proposed nothing. Each of these states no fix at all.
  it('does not accept a noun that merely spells a remedy verb', () => {
    expect(classify('The tool is broken, full stop. It affects every user of the export path.')?.kind)
      .toBe('tool-disparagement');
    expect(classify('The daemon does not work; every request 500s. We set aside a day for it.')?.kind)
      .toBe('tool-disparagement');
    expect(classify('The vitest binary is not installed on a fresh install of this repo.')?.kind)
      .toBe('environment');
  });

  it('does not accept a remedy word that is part of a URL', () => {
    // A link is a citation, not an assertion, and its path segments are words.
    // Linking TO a workaround is not stating one.
    expect(classify('The tool is broken — see https://example.com/workaround for details.')?.kind)
      .toBe('tool-disparagement');
    expect(classify('The tool is broken; details at www.example.com/the-fix.')?.kind)
      .toBe('tool-disparagement');
    // …but a stated workaround still waives, URL or no URL.
    expect(classify('The tool is broken on node 22 — use the docker image instead (see example.com).')).toBeNull();
  });

  it('still accepts the imperative forms, which are real remedies', () => {
    expect(classify('vitest exits with "command not found" on a fresh clone — run npm ci first.')).toBeNull();
    expect(classify('The ANTHROPIC_API_KEY is not set for graphify; export it in .envrc before running.')).toBeNull();
    expect(classify('The bridge is broken under node 22 — install node 24 and it works.')).toBeNull();
    expect(classify('The proxy does not work against the daemon; set BATON_PORT=7077 instead.')).toBeNull();
  });
});

describe('coverage — each class is keyed to the class, not one idiom', () => {
  it('catches environment failures beyond the canonical phrasing', () => {
    expect(classify('The GITHUB_TOKEN is unconfigured in CI.')?.kind).toBe('environment');
    expect(classify('The vitest package is uninstalled here.')?.kind).toBe('environment');
    expect(classify('node is missing from PATH after the brew migration.')?.kind).toBe('environment');
  });

  it('catches disparagement beyond "is broken"', () => {
    expect(classify('The graphify backend is unreliable.')?.kind).toBe('tool-disparagement');
    expect(classify('The watch test fails every time.')?.kind).toBe('tool-disparagement');
  });

  it('catches self-resolution however it is worded', () => {
    expect(classify('The second attempt succeeded, so it was nothing.')?.kind).toBe('transient');
    expect(classify('It passed when I ran it again.')?.kind).toBe('transient');
    expect(classify('The error resolved after a rerun.')?.kind).toBe('transient');
    expect(classify('The flake cleared on its own.')?.kind).toBe('transient');
  });

  it('catches narration beyond "in this session"', () => {
    expect(classify('Today I reviewed the diff and found nothing.')?.kind).toBe('narrative');
    expect(classify('During this task we rewrote the poller.')?.kind).toBe('narrative');
    expect(classify('I spent this session tracing the SSE bug.')?.kind).toBe('narrative');
    expect(classify('This conversation started with a broken build.')?.kind).toBe('narrative');
  });
});

describe('normalizeForMatch — where false positives would be born', () => {
  it('sees through markdown emphasis, curly quotes, case and line breaks', () => {
    expect(classify('The runner **is broken**.')?.kind).toBe('tool-disparagement');
    expect(classify('The runner doesn’t work.')?.kind).toBe('tool-disparagement');
    expect(classify('The runner does not\n   work at all.')?.kind).toBe('tool-disparagement');
    expect(classify('THE RUNNER IS BROKEN.')?.kind).toBe('tool-disparagement');
  });

  it('treats a quoted error message as evidence, not as the claim', () => {
    // The fact IS durable; the banned phrase is inside backticks as the symptom
    // it explains. Stripping code spans is what keeps this savable.
    expect(classify('graphify prints `command not found` when the CLI is absent, and falls back to AST-only extraction.')).toBeNull();
    expect(classify('The doctor check greps for:\n```\nno such file or directory\n```\nand reports a broken worktree link.')).toBeNull();
  });

  it('still catches the claim when only the tool name is in backticks', () => {
    expect(classify('The `playwright` MCP server is broken.')?.kind).toBe('tool-disparagement');
  });

  it('normalizes without throwing on empty, whitespace, and fence-only input', () => {
    expect(normalizeForMatch('')).toBe('');
    expect(normalizeForMatch('   \n\t ')).toBe('');
    expect(normalizeForMatch('```\nanything\n```')).toBe('');
    expect(classifyDurability('')).toBeNull();
    expect(classifyDurability('```\nis broken\n```')).toBeNull();
  });

  it('does not hang on a long fact with many backticks or an unterminated fence', () => {
    // Guards against a pathological pattern: every rule must stay linear.
    const long = `${'`x` '.repeat(400)}is broken`;
    const started = Date.now();
    expect(classifyDurability(long)?.kind).toBe('tool-disparagement');
    expect(classifyDurability(`\`\`\`\n${'a'.repeat(5000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
