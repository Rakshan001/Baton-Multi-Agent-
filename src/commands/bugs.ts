/**
 * `baton bugs <symptom>` — has this bug been fixed before, and did something
 * since re-break it? Reads the bug-fix facts the memory holds and traces their
 * files through commit history for suspect commits. Zero new storage (S6).
 */
import { gitRoot } from '../git.js';
import { findRecurrence, type PriorFix } from '../recurrence.js';

const FRESH_MARK: Record<string, string> = { fresh: '●', aging: '◐', stale: '○' };

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}
function shortSha(sha: string): string {
  return sha.slice(0, 9);
}
function day(iso: string): string {
  return (iso.split('T')[0] ?? iso);
}

function printFix(p: PriorFix): void {
  const f = p.fact;
  const stale = f.freshness === 'stale';
  console.log(`${FRESH_MARK[f.freshness] ?? '·'} ${firstLine(f.fact)}`);
  console.log(`    fixed ${day(f.createdAt)}${f.agent ? ` by ${f.agent}` : ''}${f.task ? ` · task ${f.task}` : ''} · touched ${p.files.join(', ')}`);
  if (stale) {
    console.log(`    ⚠ STALE: ${f.staleReason ?? 'an anchored file changed'} — this fix may have regressed`);
  }
  if (p.suspects.length) {
    console.log(`    suspect commits since the fix (may have reintroduced it):`);
    for (const s of p.suspects.slice(0, 8)) {
      console.log(`      ${shortSha(s.sha)}  ${day(s.at)}  ${firstLine(s.message)}  [${s.files.join(', ')}]${s.task ? ` · ${s.task}` : ''}`);
    }
  } else if (stale) {
    console.log(`    no MERGED commit touched these files yet — the change that broke it may be uncommitted or on an open branch.`);
  } else {
    console.log(`    no later commits have touched these files — the fix still stands.`);
  }
  console.log('');
}

export async function bugsCmd(symptom: string): Promise<void> {
  const q = symptom.trim();
  if (!q) {
    console.error('✗ describe the symptom, e.g. `baton bugs "checkout redirect loops"`');
    process.exitCode = 1;
    return;
  }
  const root = await gitRoot();
  const fixes = await findRecurrence(root, q);
  if (!fixes.length) {
    console.log(`No prior fix recorded for "${q}".`);
    console.log('Agents that run the bug-fix skill record each fix (root cause + files) to memory —');
    console.log('once they do, this command traces whether a later change re-broke it.');
    return;
  }
  const stale = fixes.filter((p) => p.fact.freshness === 'stale').length;
  console.log(`${fixes.length} prior fix${fixes.length === 1 ? '' : 'es'} related to "${q}"${stale ? ` · ${stale} possibly regressed` : ''}:\n`);
  for (const p of fixes) printFix(p);
}
