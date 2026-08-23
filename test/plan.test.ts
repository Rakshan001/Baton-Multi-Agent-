// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { loadPlan, parsePlan, PlanError, scopesOverlap, validatePlan } from '../src/plan.js';

const PLAN = `---
plan: 2026-08-05-auth
goal: Ship JWT auth end to end
requireReview: true
---

## Phase 1 — Foundation

### auth-schema @claude
**scope:** \`src/db/**\`
**expects:** migration runs up and down; vitest test/schema passes
**principles:** no raw SQL outside src/db

Add users + refresh_tokens tables.

## Phase 2 — API

### auth-api @cursor
**after:** auth-schema
**scope:** \`src/auth/**\`

Issue and verify tokens.

### rate-limit
**scope:** \`src/middleware/**\`

Throttle the login route.
`;

describe('parsePlan', () => {
  const { plan, issues } = parsePlan(PLAN);

  it('reads the frontmatter', () => {
    expect(issues).toEqual([]);
    expect(plan.id).toBe('2026-08-05-auth');
    expect(plan.goal).toBe('Ship JWT auth end to end');
    expect(plan.requireReview).toBe(true);
  });

  it('assigns each task to the phase it appears under', () => {
    expect(plan.tasks.map((t) => [t.slug, t.phase])).toEqual([
      ['auth-schema', 1], ['auth-api', 2], ['rate-limit', 2],
    ]);
  });

  it('reads @agent as the assignee, and no @ as the open pool', () => {
    expect(plan.tasks.map((t) => t.assignee)).toEqual(['claude', 'cursor', null]);
  });

  it('reads the contract fields an agent is handed at claim time', () => {
    const schema = plan.tasks[0];
    expect(schema.scope).toEqual(['src/db/**']);
    expect(schema.principles).toEqual(['no raw SQL outside src/db']);
    expect(schema.expects).toEqual(['migration runs up and down', 'vitest test/schema passes']);
    expect(schema.task).toBe('Add users + refresh_tokens tables.');
  });

  it('accepts either "after" or "dependsOn"', () => {
    expect(plan.tasks[1].dependsOn).toEqual(['auth-schema']);
    const alt = parsePlan('## Phase 1\n\n### b\n**dependsOn:** a\n\nwork\n').plan;
    expect(alt.tasks[0].dependsOn).toEqual(['a']);
  });

  it('defaults requireReview ON — opting out has to be written down', () => {
    // The evidence gate proves work happened, not that it is correct. Review is
    // the only layer aimed at correctness, so silence must not disable it.
    expect(parsePlan('## Phase 1\n\n### a\n\nwork\n').plan.requireReview).toBe(true);
    expect(parsePlan('---\nrequireReview: false\n---\n## Phase 1\n\n### a\n\nwork\n').plan.requireReview).toBe(false);
  });

  it('flags a task written before any phase heading', () => {
    const { issues: i } = parsePlan('### orphan\n\nwork\n');
    expect(i.some((x) => x.message.includes('before any'))).toBe(true);
  });

  it('flags an unknown field rather than silently dropping it', () => {
    const { issues: i } = parsePlan('## Phase 1\n\n### a\n**assigne:** claude\n\nwork\n');
    expect(i[0].message).toContain("unknown field 'assigne'");
  });

  /**
   * A heading that fails the regex is indistinguishable from prose, so the task
   * AND everything under it used to disappear with no issue raised — a plan
   * that applies "successfully" while quietly missing work.
   */
  it('reports a multi-word task name instead of dropping the task in silence', () => {
    const { plan: p, issues: i } = parsePlan('## Phase 1\n\n### add auth schema @claude\n**scope:** `src/db/**`\n\nBuild it.\n\n### rate-limit\n\nThrottle.\n');
    expect(i[0].message).toContain("write it as 'add-auth-schema'");
    expect(p.tasks.map((t) => t.slug)).toEqual(['rate-limit']);   // and the NEXT task still parses
  });

  it('calls a case/spacing slip a slip, and a traversal unsafe', () => {
    expect(parsePlan('## Phase 1\n\n### Auth Schema\n\nw\n').issues[0].message).toContain('must be a lowercase slug');
    expect(parsePlan('## Phase 1\n\n### ../../.ssh\n\nw\n').issues[0].message).toContain('unsafe task name');
  });

  it('still reads an assignee off a heading that needs no repair', () => {
    expect(parsePlan('## Phase 1\n\n### auth-api @cursor\n\nw\n').plan.tasks[0].assignee).toBe('cursor');
  });

  /**
   * "## Phase two" parses as prose, so every task under it joined the PREVIOUS
   * phase — work meant to be serialized silently running in parallel, which is
   * the exact outcome the barrier exists to prevent.
   */
  it('refuses to guess the number on a phase heading that has none', () => {
    const src = '## Phase 1\n\n### a\n\nw\n\n## Phase two — API\n\n### b\n\nw\n';
    expect(parsePlan(src).issues[0].message).toContain('has no number');
    // The invariant that matters: b silently joining phase 1 would run it
    // alongside a, so this plan must not be appliable at all.
    expect(() => loadPlan(src)).toThrow(PlanError);
  });

  it('ends a task at an ordinary ## section without moving the phase', () => {
    const { plan: p, issues: i } = parsePlan('## Phase 1\n\n### a\n\nwork\n\n## Notes\n\nwhy we chose this\n\n### b\n\nmore\n');
    expect(i).toEqual([]);
    expect(p.tasks.map((t) => [t.slug, t.phase])).toEqual([['a', 1], ['b', 1]]);
    // The note is NOT appended to a's description — that prose would reach an
    // agent's context as if it were instruction.
    expect(p.tasks[0].task).toBe('work');
  });
});

/**
 * A slug becomes a branch name, a directory under .baton/wt, and a CLI
 * argument. Slugs used to come from a human typing `baton new`; a plan file may
 * arrive over git from a repo nobody here wrote, so this is now an untrusted
 * input path.
 */
describe('slug safety on ingest', () => {
  const traversal = (name: string) => parsePlan(`## Phase 1\n\n### ${name}\n\nwork\n`);

  it('refuses a traversing task name instead of quietly repairing it', () => {
    const { plan, issues } = traversal('../../.ssh');
    // Rejected, NOT rewritten: silently turning ../../.ssh into "ssh" would
    // create a task the plan's author never wrote and never reviewed.
    expect(plan.tasks).toEqual([]);
    expect(issues[0].message).toContain('unsafe task name');
  });

  it('refuses absolute and separator-bearing names', () => {
    for (const name of ['/etc/passwd', 'a/b', '..', './x']) {
      expect(traversal(name).plan.tasks, name).toEqual([]);
    }
  });

  it('refuses a name that would collide with an option or a dotfile', () => {
    for (const name of ['--force', '.hidden']) {
      expect(traversal(name).plan.tasks, name).toEqual([]);
    }
  });

  it('accepts an ordinary slug unchanged', () => {
    expect(traversal('auth-schema').plan.tasks.map((t) => t.slug)).toEqual(['auth-schema']);
  });

  it('sanitises the plan id, which becomes a filename', () => {
    expect(parsePlan('---\nplan: ../../../evil\n---\n## Phase 1\n\n### a\n\nw\n').plan.id).toBe('evil');
  });

  it('refuses a path-shaped assignee, and does not keep it as a value', () => {
    // An assignee is matched against agent ids and written into tasks.json.
    const { plan, issues } = parsePlan('## Phase 1\n\n### a @../../etc/passwd\n\nwork\n');
    expect(issues.some((i) => i.message.includes('unsafe assignee'))).toBe(true);
    expect(plan.tasks[0].assignee).toBeNull();
  });

  it('refuses a task named __proto__ rather than letting it reach a lookup key', () => {
    const { plan, issues } = parsePlan('## Phase 1\n\n### __proto__\n\nwork\n');
    expect(plan.tasks).toEqual([]);
    expect(issues[0].message).toContain('unsafe task name');
  });
});

describe('validatePlan', () => {
  const base = (body: string) => parsePlan(`## Phase 1\n\n${body}`).plan;

  it('accepts a well-formed plan', () => {
    expect(validatePlan(parsePlan(PLAN).plan)).toEqual([]);
  });

  it('rejects a duplicate task name', () => {
    const issues = validatePlan(base('### a\n\nwork\n\n### a\n\nother\n'));
    expect(issues.some((i) => i.message === 'duplicate task name')).toBe(true);
  });

  it('rejects a dependency this plan does not define', () => {
    const issues = validatePlan(base('### a\n**after:** ghost\n\nwork\n'));
    expect(issues[0].message).toContain("depends on 'ghost', which this plan does not define");
  });

  it('rejects a dependency in a LATER phase — it can never be satisfied', () => {
    // The barrier will not open phase 2 until phase 1 finishes, and phase 1 is
    // waiting on phase 2. Deadlock caught at apply time rather than at 3am.
    const plan = parsePlan('## Phase 1\n\n### early\n**after:** late\n\nw\n\n## Phase 2\n\n### late\n\nw\n').plan;
    expect(validatePlan(plan)[0].message).toContain('later phase (2 > 1)');
  });

  it('allows a dependency in an EARLIER phase', () => {
    const plan = parsePlan('## Phase 1\n\n### first\n\nw\n\n## Phase 2\n\n### second\n**after:** first\n\nw\n').plan;
    expect(validatePlan(plan)).toEqual([]);
  });

  it('rejects a dependency cycle', () => {
    const issues = validatePlan(base('### a\n**after:** b\n\nw\n\n### b\n**after:** a\n\nw\n'));
    expect(issues.some((i) => i.message.startsWith('dependency cycle'))).toBe(true);
  });

  it('rejects a three-task cycle, reported once', () => {
    const issues = validatePlan(base('### a\n**after:** c\n\nw\n\n### b\n**after:** a\n\nw\n\n### c\n**after:** b\n\nw\n'));
    expect(issues.filter((i) => i.message.startsWith('dependency cycle'))).toHaveLength(1);
  });

  it('rejects a self-dependency', () => {
    expect(validatePlan(base('### a\n**after:** a\n\nw\n')).some((i) => i.message.startsWith('dependency cycle'))).toBe(true);
  });

  it('rejects an empty plan', () => {
    expect(validatePlan(base('')).some((i) => i.message === 'no tasks')).toBe(true);
  });

  it('requires a description — an agent needs to know what to build', () => {
    expect(validatePlan(base('### a\n**scope:** src/x\n')).some((i) => i.message.includes('no description'))).toBe(true);
  });

  /**
   * The phase barrier gates BETWEEN phases and does nothing WITHIN one — and
   * within a phase is exactly where parallel agents run. Overlapping scope
   * there is not a warning; it is two agents editing one file at once.
   */
  describe('within-phase scope overlap is a hard error', () => {
    it('rejects two same-phase tasks claiming the same directory', () => {
      const issues = validatePlan(base('### a\n**scope:** `src/db/**`\n\nw\n\n### b\n**scope:** `src/db/schema.ts`\n\nw\n'));
      expect(issues.some((i) => i.message.includes('run in parallel over the same files'))).toBe(true);
    });

    it('allows the same scope in DIFFERENT phases, which are serialized', () => {
      const plan = parsePlan('## Phase 1\n\n### a\n**scope:** `src/db/**`\n\nw\n\n## Phase 2\n\n### b\n**scope:** `src/db/**`\n\nw\n').plan;
      expect(validatePlan(plan)).toEqual([]);
    });

    it('allows disjoint scopes in the same phase', () => {
      expect(validatePlan(base('### a\n**scope:** `src/db/**`\n\nw\n\n### b\n**scope:** `src/ui/**`\n\nw\n'))).toEqual([]);
    });

    it('does not guess when a task declares no scope at all', () => {
      // No scope means "unknown", and refusing a plan on an unknown would block
      // work that may be perfectly fine. The edit-time guard still covers it.
      expect(validatePlan(base('### a\n\nw\n\n### b\n**scope:** `src/db/**`\n\nw\n'))).toEqual([]);
    });
  });
});

describe('scopesOverlap', () => {
  it('matches a glob against a file beneath it', () => {
    expect(scopesOverlap(['src/db/**'], ['src/db/schema.ts'])).toBe(true);
  });
  it('matches identical entries', () => {
    expect(scopesOverlap(['src/a.ts'], ['src/a.ts'])).toBe(true);
  });
  it('separates sibling directories', () => {
    expect(scopesOverlap(['src/db/**'], ['src/ui/**'])).toBe(false);
  });
  /**
   * A bare startsWith made `src/db` cover `src/dbutil.ts`. Overlap is a HARD
   * error, so the false positive rejects a good plan — and a tool that is
   * confidently wrong is the one nobody debugs.
   */
  it('requires the prefix to land on a path boundary', () => {
    expect(scopesOverlap(['src/db'], ['src/dbutil.ts'])).toBe(false);
    expect(scopesOverlap(['src/db/**'], ['src/dbx/thing.ts'])).toBe(false);
    expect(scopesOverlap(['src/db'], ['src/db/schema.ts'])).toBe(true);   // real parent
    expect(scopesOverlap(['src/db/'], ['src/db'])).toBe(true);            // spelling, not scope
  });
  it('treats a repo-wide glob as overlapping everything', () => {
    expect(scopesOverlap(['**'], ['src/a.ts'])).toBe(true);
  });
  it('normalises ./ and backslashes so one spelling cannot dodge the check', () => {
    expect(scopesOverlap(['./src/db/**'], ['src\\db\\schema.ts'])).toBe(true);
  });
  it('is empty-safe', () => {
    expect(scopesOverlap([], ['src/a.ts'])).toBe(false);
  });
});

describe('loadPlan', () => {
  it('returns the plan when everything holds', () => {
    expect(loadPlan(PLAN).tasks).toHaveLength(3);
  });

  it('throws with EVERY problem at once, not just the first', () => {
    let err: PlanError | null = null;
    try {
      loadPlan('## Phase 1\n\n### a\n**after:** ghost\n\nw\n\n### a\n\nw\n');
    } catch (e) { err = e as PlanError; }
    expect(err).toBeInstanceOf(PlanError);
    expect(err!.issues.length).toBeGreaterThan(1);
    expect(err!.message).toContain('plan is not valid');
  });

  /**
   * The mistake the probe made: `- scope:` reads perfectly to a person and is
   * prose to the parser, so the task ships with no scope — and scope is what
   * keeps two agents in one phase off the same file. `**foo:**` already errored
   * as an unknown field; this closes the looser half of the same hole.
   */
  it('refuses a field written as prose instead of silently dropping it', () => {
    for (const line of ['- scope: src/**', 'scope: src/**', '*scope*: src/**', '- **expects:** it works']) {
      const { plan, issues } = parsePlan(`## Phase 1\n\n### auth-api\nDo it.\n${line}\n`, 'p');
      expect(issues.length, line).toBe(1);
      expect(issues[0]!.message, line).toMatch(/written as prose/);
      expect(issues[0]!.message, line).toMatch(/\*\*(scope|expects):\*\*/);
      expect(plan.tasks[0]!.scope, line).toEqual([]);
    }
  });

  it('still accepts the documented form, and prose that merely mentions a word', () => {
    const { plan, issues } = parsePlan(
      '## Phase 1\n\n### auth-api\n**scope:** `src/**`\nKeep the scope tight and the expects honest.\n',
      'p',
    );
    expect(issues).toEqual([]);
    expect(plan.tasks[0]!.scope).toEqual(['src/**']);
    expect(plan.tasks[0]!.task).toContain('Keep the scope tight');
  });
});

/**
 * P3 step 1 — `model` is intent, so the plan owns it.
 *
 * The same split as `assignee` (intent) vs `claimedBy.agent` (fact): what a
 * plan asks for is one field, what actually launched is a record in the runs
 * ledger. Merging them would make "the plan wanted sonnet but opus ran"
 * unrepresentable, which is precisely the drift a board has to be able to show.
 */
describe('parsePlan — model', () => {
  it('reads **model:** as a field, not as an unknown one', () => {
    const { plan, issues } = parsePlan('## Phase 1\n\n### auth-api @claude\n**model:** sonnet\n', 'p');
    expect(issues).toEqual([]);
    expect(plan.tasks[0]!.model).toBe('sonnet');
  });

  it('keeps a provider-qualified model intact', () => {
    // `ollama/qwen3-coder` is a native model string agents pass straight
    // through; slugifying it the way an assignee is slugified would destroy it.
    const { plan } = parsePlan('## Phase 1\n\n### t\n**model:** ollama/qwen3-coder\n', 'p');
    expect(plan.tasks[0]!.model).toBe('ollama/qwen3-coder');
  });

  it('a task with no model has none — never an empty string', () => {
    // `model: ''` would reach a CLI as `--model ''` and start something nobody
    // chose. Absent has to stay absent.
    const { plan, issues } = parsePlan('## Phase 1\n\n### t\n**model:**\n', 'p');
    expect(issues).toEqual([]);
    expect(plan.tasks[0]!.model).toBeUndefined();
  });

  it('refuses a model that could not be an argument', () => {
    // A plan can arrive by `git pull` from a branch nobody reviewed (P3-E2) and
    // this value becomes argv. Refuse it rather than sanitize it: a silently
    // rewritten model runs something other than what the plan says.
    for (const bad of ['--dangerously-skip', 'a b', '$(id)', '../../etc/passwd', 'x;rm -rf /']) {
      const { plan, issues } = parsePlan(`## Phase 1\n\n### t\n**model:** ${bad}\n`, 'p');
      expect(issues.length, bad).toBe(1);
      expect(issues[0]!.message, bad).toMatch(/not a usable model/);
      expect(plan.tasks[0]!.model, bad).toBeUndefined();
    }
  });
});

/**
 * Scope overlap is about work happening AT THE SAME TIME.
 *
 * The check grouped by phase and never read `dependsOn`, so two tasks where one
 * waits for the other were reported as running in parallel over the same files.
 * They cannot: `eligibleFor` will not start the second until the first is done.
 *
 * The advice it gave made it worse — "move one to another phase" pushes a plan
 * toward coarse barriers that stop every unrelated task too, when the precise
 * dependency was already written down.
 */
describe('validatePlan — overlap and dependencies', () => {
  const twoTasks = (after: string) => `## Phase 1

### extractor
**scope:** \`src/kb/**\`

Build it.

### grammars
${after}**scope:** \`src/kb/**\`

Package them.
`;

  const check = (text: string) => validatePlan(parsePlan(text, 'p').plan).map((i) => i.message).join();

  it('still refuses two independent tasks that would collide', () => {
    expect(check(twoTasks(''))).toMatch(/same files/);
  });

  it('allows the overlap when one task waits for the other', () => {
    expect(check(twoTasks('**after:** extractor\n'))).toBe('');
  });

  it('allows it through a chain, not just a direct edge', () => {
    const plan = `## Phase 1

### a
**scope:** \`src/x/**\`

A.

### b
**after:** a

B.

### c
**after:** b
**scope:** \`src/x/**\`

C.
`;
    expect(check(plan)).toBe('');
  });

  it('still refuses a collision between two branches of the same chain', () => {
    // Both wait for `a`, so they start together — the dependency does not
    // order them relative to each other.
    const plan = `## Phase 1

### a

A.

### b
**after:** a
**scope:** \`src/x/**\`

B.

### c
**after:** a
**scope:** \`src/x/**\`

C.
`;
    expect(check(plan)).toMatch(/same files/);
  });
});
