import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSessionCommand, parseControlLine, repoPrefix, ScrollbackRing, sessionNameFor,
  shQuote, slugFromSession, toHexArgs, unescapeControlOutput,
  INTERACTIVE_LAUNCHERS,
} from '../src/terminals.js';
import { bus } from '../src/events.js';
import { detectTmux, exactPane, exactSession, killSessionFor, tmuxSessionExists, tmuxTry } from '../src/util/tmux.js';

describe('session naming', () => {
  const root = '/Users/me/code/repo';

  it('round-trips slug ↔ session name', () => {
    const name = sessionNameFor(root, 'fix-the-navbar');
    expect(slugFromSession(root, name)).toBe('fix-the-navbar');
  });

  it('two repos never collide on the same slug', () => {
    expect(sessionNameFor('/repo/a', 'task')).not.toBe(sessionNameFor('/repo/b', 'task'));
  });

  it('rejects sessions from another repo', () => {
    expect(slugFromSession('/repo/a', sessionNameFor('/repo/b', 'task'))).toBeNull();
  });

  it('prefix is stable for the same root', () => {
    expect(repoPrefix(root)).toBe(repoPrefix(root));
  });
});

describe('shQuote / buildSessionCommand', () => {
  it('wraps in single quotes', () => {
    expect(shQuote('hello')).toBe(`'hello'`);
  });

  it('escapes embedded single quotes the POSIX way', () => {
    expect(shQuote(`it's`)).toBe(`'it'\\''s'`);
  });

  it('neutralizes shell metacharacters in prompts', () => {
    const cmd = buildSessionCommand(INTERACTIVE_LAUNCHERS.claude, 'fix $(rm -rf /) `bad`; echo');
    expect(cmd).toBe(`claude 'fix $(rm -rf /) \`bad\`; echo'`);
  });

  it('launches bare when the agent takes no prompt', () => {
    expect(buildSessionCommand(INTERACTIVE_LAUNCHERS.aider, 'ignored')).toBe('aider');
  });

  it('uses -i for gemini so it stays interactive after the prompt', () => {
    expect(buildSessionCommand(INTERACTIVE_LAUNCHERS.gemini, 'do it')).toBe(`gemini '-i' 'do it'`);
  });

  it('prefixes identity env so the launched agent process inherits it (not tmux set-environment, which lands too late)', () => {
    const cmd = buildSessionCommand(INTERACTIVE_LAUNCHERS.claude, undefined, undefined, {
      BATON_SLUG: 'fix-auth',
      BATON_ROOT: '/repo/root',
    });
    expect(cmd).toBe(`BATON_SLUG='fix-auth' BATON_ROOT='/repo/root' claude`);
  });

  it('omits the env prefix entirely when no env is given (unchanged behavior)', () => {
    expect(buildSessionCommand(INTERACTIVE_LAUNCHERS.claude)).toBe('claude');
  });

  it('cursor uses the cursor-agent CLI, not the IDE binary', () => {
    expect(INTERACTIVE_LAUNCHERS.cursor.cmd).toBe('cursor-agent');
  });
});

describe('toHexArgs', () => {
  it('encodes arbitrary bytes including NUL and control chars', () => {
    expect(toHexArgs(Buffer.from([0x00, 0x0d, 0x1b, 0x7f, 0xff]))).toEqual(['00', '0d', '1b', '7f', 'ff']);
  });

  it('round-trips a keystroke sequence', () => {
    const up = Buffer.from('\x1b[A', 'utf8'); // arrow-up from xterm
    expect(toHexArgs(up)).toEqual(['1b', '5b', '41']);
  });
});

describe('unescapeControlOutput', () => {
  it('passes plain text through', () => {
    expect(unescapeControlOutput('hello').toString()).toBe('hello');
  });

  it('decodes octal escapes (ANSI sequences)', () => {
    expect(unescapeControlOutput('\\033[1mbold\\033[0m').toString()).toBe('\x1b[1mbold\x1b[0m');
  });

  it('decodes escaped backslashes', () => {
    expect(unescapeControlOutput('a\\\\b').toString()).toBe('a\\b');
  });

  it('decodes CRLF octal pairs', () => {
    expect(unescapeControlOutput('line\\015\\012').toString()).toBe('line\r\n');
  });

  it('decodes octal-escaped UTF-8 multibyte sequences', () => {
    // "é" = 0xC3 0xA9 → tmux escapes as \303\251
    expect(unescapeControlOutput('caf\\303\\251').toString('utf8')).toBe('café');
  });

  it('is lenient on a trailing lone backslash', () => {
    expect(unescapeControlOutput('end\\').toString()).toBe('end\\');
  });
});

describe('parseControlLine', () => {
  it('parses %output with pane id and escaped data', () => {
    expect(parseControlLine('%output %3 hi\\015\\012')).toEqual({ kind: 'output', pane: '3', data: 'hi\\015\\012' });
  });

  it('parses %exit with and without a reason', () => {
    expect(parseControlLine('%exit').kind).toBe('exit');
    expect(parseControlLine('%exit detached').kind).toBe('exit');
  });

  it('parses %error', () => {
    expect(parseControlLine('%error bad command').kind).toBe('error');
  });

  it('ignores command-reply and notification chatter', () => {
    for (const line of ['%begin 1 2 1', '%end 1 2 1', '%session-changed $0 name', '%layout-change @0 …']) {
      expect(parseControlLine(line).kind).toBe('other');
    }
  });

  it('does not treat %exited-like output lines as exit', () => {
    expect(parseControlLine('%output %0 %exit').kind).toBe('output');
  });
});

describe('ScrollbackRing', () => {
  it('concatenates pushed chunks in order', () => {
    const ring = new ScrollbackRing(1024);
    ring.push(Buffer.from('a'));
    ring.push(Buffer.from('b'));
    expect(ring.snapshot().toString()).toBe('ab');
  });

  it('evicts oldest chunks past the byte cap', () => {
    const ring = new ScrollbackRing(10);
    ring.push(Buffer.from('aaaaa'));
    ring.push(Buffer.from('bbbbb'));
    ring.push(Buffer.from('ccccc'));
    const snap = ring.snapshot().toString();
    expect(snap.length).toBeLessThanOrEqual(10);
    expect(snap.endsWith('ccccc')).toBe(true);
    expect(snap.includes('aaaaa')).toBe(false);
  });

  it('always keeps the newest chunk even if it exceeds the cap', () => {
    const ring = new ScrollbackRing(4);
    ring.push(Buffer.from('123456789'));
    expect(ring.snapshot().toString()).toBe('123456789');
  });
});

describe('events ring exclusion', () => {
  it('terminal.output is emitted live but never replayed from the ring', () => {
    let saw = 0;
    const unsub = bus.onType('terminal.output', () => { saw += 1; });
    const stamped = bus.publish({ type: 'terminal.output', slug: 't', data: 'aGk=' });
    unsub();
    expect(saw).toBe(1);
    expect(bus.since(stamped.id - 1).some((e) => e.event.type === 'terminal.output')).toBe(false);
  });

  it('terminal.started/exited do replay from the ring', () => {
    const stamped = bus.publish({ type: 'terminal.started', slug: 't', agent: 'claude' });
    expect(bus.since(stamped.id - 1).some((e) => e.event.type === 'terminal.started')).toBe(true);
  });
});

/**
 * tmux resolves `-t <name>` exact → fnmatch → PREFIX, so every bare target
 * aimed at the wrong session whenever one slug prefixed another. Verified
 * against real tmux 3.6b before the fix: with only `probe-x-long` alive,
 * `attach-session -t probe-x` attached to it, and `kill-session -t probe-x`
 * killed it.
 *
 * The two helpers are not interchangeable — a bare `=name` given to
 * capture-pane fails ("can't find pane") and to set-option ("no such
 * session"), so the pane/window form carries the trailing colon.
 */
describe('exact tmux targets', () => {
  it('session targets use =name', () => {
    expect(exactSession('baton-abc123-fix')).toBe('=baton-abc123-fix');
  });

  it('pane and window targets use =name: — the bare form is rejected by tmux', () => {
    expect(exactPane('baton-abc123-fix')).toBe('=baton-abc123-fix:');
  });

  it('a prefix no longer resolves: the two targets differ by more than the slug', () => {
    const short = sessionNameFor('/repo', 'fix');
    const long = sessionNameFor('/repo', 'fix-login');
    expect(long.startsWith(short)).toBe(true);           // the collision is real
    expect(exactSession(long).startsWith(exactSession(short))).toBe(true);
    expect(exactPane(short)).not.toBe(exactPane(long));   // ...but the colon terminates it
    expect(exactPane(long).startsWith(exactPane(short))).toBe(false);
  });
});

/**
 * The real proof, against a live tmux server: only `<prefix>fix-login` exists,
 * and nothing addressed to `fix` may touch it. Before the fix both assertions
 * failed — has-session matched and kill-session destroyed another task's agent.
 * Session names are hashed from a unique temp root, so these can never collide
 * with a session the developer is actually using.
 */
const HAS_TMUX = await detectTmux();

describe.runIf(HAS_TMUX)('tmux targeting against a live server', () => {
  const root = `/tmp/baton-target-test-${process.pid}`;
  const victim = sessionNameFor(root, 'fix-login');

  beforeEach(async () => {
    await tmuxTry(['new-session', '-d', '-s', victim, 'sleep 300']);
  });
  afterEach(async () => {
    await tmuxTry(['kill-session', '-t', exactSession(victim)]);
  });

  it('a session that only PREFIX-matches is reported as absent', async () => {
    expect(await tmuxSessionExists(root, 'fix-login')).toBe(true);
    expect(await tmuxSessionExists(root, 'fix')).toBe(false);
  });

  it('killing "fix" leaves "fix-login" running', async () => {
    await killSessionFor(root, 'fix');
    expect(await tmuxSessionExists(root, 'fix-login')).toBe(true);
  });

  it('killing the exact slug still works', async () => {
    expect(await killSessionFor(root, 'fix-login')).toBe(true);
    expect(await tmuxSessionExists(root, 'fix-login')).toBe(false);
  });
});
