/**
 * `baton resume [slug]` — the pickup side of the manual relay (H4).
 * No slug: list every open handoff brief (task + session) in one place.
 * With a slug: print the resume prompt for the receiving agent and flip the
 * brief to in-progress. `baton take` remains the task-worktree-specific path;
 * resume covers everything, including root sessions with no worktree.
 */
import { gitRoot } from '../git.js';
import { briefStalenessWarning } from '../handoff/brief.js';
import { listBriefs, setBriefStatusAt } from '../handoff/resume.js';

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export async function resumeCmd(slug: string | undefined, opts: { json?: boolean } = {}): Promise<void> {
  const root = await gitRoot();
  const briefs = await listBriefs(root);

  if (!slug) {
    const open = briefs.filter((b) => b.status !== 'done');
    if (opts.json) {
      console.log(JSON.stringify(open.map(({ markdown: _m, body: _b, ...rest }) => rest), null, 2));
      return;
    }
    if (!open.length) {
      console.log('No open handoff briefs.');
      console.log('An agent creates one with its create_handoff tool (near its usage limit, or on request),');
      console.log('or from a task worktree: baton pass <slug>');
      return;
    }
    console.log('Open handoff briefs:\n');
    for (const b of open) {
      console.log(`  ${b.slug.padEnd(20)} [${b.status}]  ${b.from} → ${b.to}  ${age(b.created)}`.trimEnd());
      console.log(`  ${''.padEnd(20)} ${b.title}`);
    }
    console.log('\nPick one up with: baton resume <slug>');
    return;
  }

  const brief = briefs.find((b) => b.slug === slug);
  if (!brief) {
    console.error(`No handoff brief '${slug}'. See what's open: baton resume`);
    process.exitCode = 1;
    return;
  }
  if (brief.status === 'done') {
    console.error(`Brief '${slug}' is already done. If there is new work, create a fresh handoff.`);
    process.exitCode = 1;
    return;
  }

  await setBriefStatusAt(brief.path, 'in-progress');
  const staleWarning = await briefStalenessWarning(brief.cwd, brief.created);

  // The resume prompt — paste (or pipe) this into the receiving agent.
  // The staleness warning goes INSIDE the delimiters so a piped agent sees it.
  console.log('────────────────────────────────────────────────────────');
  if (staleWarning) console.log(staleWarning + '\n');
  console.log(brief.body);
  console.log('────────────────────────────────────────────────────────');
  console.log(`(brief: ${brief.path} · status → in-progress)`);
  console.log(`Work in: ${brief.cwd}`);
}
