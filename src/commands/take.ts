/**
 * `baton take [slug]` — pick up a handoff brief: validate it, flip status to
 * in-progress, and print the execution prompt for the receiving agent.
 * `baton done [slug]` — mark the brief done.
 */
import { gitRoot } from '../git.js';
import { readBrief, setBriefStatus } from '../handoff/brief.js';
import { resolveTask } from './pass.js';

export async function takeCmd(slug: string | undefined): Promise<void> {
  const root = await gitRoot();
  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'. See: baton ls` : 'Not inside a baton worktree — pass a slug: baton take <slug>');
    process.exitCode = 1;
    return;
  }
  const brief = await readBrief(task.worktreePath);
  if (!brief) {
    console.error(`No HANDOFF.md in ${task.worktreePath} — nothing to take. Create one with: baton pass ${task.slug}`);
    process.exitCode = 1;
    return;
  }
  if (brief.meta.baton !== 1) {
    console.error('HANDOFF.md is not a baton brief (missing `baton: 1` frontmatter).');
    process.exitCode = 1;
    return;
  }
  if (brief.meta.status === 'done') {
    console.error('This brief is already marked done. Re-pass if there is new work: baton pass');
    process.exitCode = 1;
    return;
  }
  await setBriefStatus(task.worktreePath, 'in-progress');

  // The execution prompt — paste (or pipe) this into the receiving agent.
  console.log('────────────────────────────────────────────────────────');
  console.log(brief.body.trim());
  console.log('────────────────────────────────────────────────────────');
  console.log(`(brief: ${task.worktreePath}/HANDOFF.md · status → in-progress)`);
}

export async function doneCmd(slug: string | undefined): Promise<void> {
  const root = await gitRoot();
  const task = await resolveTask(root, slug);
  if (!task) {
    console.error(slug ? `No task '${slug}'` : 'Not inside a baton worktree — pass a slug: baton done <slug>');
    process.exitCode = 1;
    return;
  }
  const ok = await setBriefStatus(task.worktreePath, 'done');
  console.log(ok ? `✓ ${task.slug} marked done — merge with: baton merge ${task.slug}` : 'No HANDOFF.md to update.');
}
