/**
 * `baton signals` — live edit signals table.
 * `baton blame <file>` — merged attribution + live editors for one file.
 */
import { gitRoot } from '../git.js';
import { queryFile } from '../history.js';
import { checkFiles, getSignals } from '../signals.js';

export async function signalsCmd(): Promise<void> {
  const root = await gitRoot();
  const signals = await getSignals(root);
  if (!signals.length) {
    console.log('no live edit signals (nothing edited in the last 30 min, or daemon not running)');
    console.log('note: signals are recorded by `baton serve` — keep it running for live tracking');
    return;
  }
  for (const s of signals) {
    const mark = s.level === 'warning' ? '⚠' : '·';
    const holders = s.holders.map((h) => `${h.slug}${h.agent ? ` (${h.agent})` : ''}`).join(', ');
    console.log(`${mark} ${s.path}  ←  ${holders}`);
  }
  const warnings = signals.filter((s) => s.level === 'warning').length;
  if (warnings) console.log(`\n${warnings} file(s) edited by 2+ sessions — coordinate before merging.`);
}

export async function blameCmd(file: string): Promise<void> {
  const root = await gitRoot();
  const [merged, live] = [queryFile(root, file), await checkFiles(root, [file])];
  const editors = live[file]?.by ?? [];
  if (editors.length) {
    console.log('live (uncommitted/unmerged):');
    for (const e of editors) console.log(`  ${e.slug}${e.agent ? ` (${e.agent})` : ''}${e.lastEditAt ? ` — last edit ${e.lastEditAt}` : ''}`);
  }
  if (merged.length) {
    console.log('merged history:');
    for (const h of merged) console.log(`  ${h.at}  ${h.sha.slice(0, 7)}  ${h.slug}${h.agent ? ` (${h.agent})` : ''}  ${h.message}`);
  }
  if (!editors.length && !merged.length) console.log(`no record of '${file}' — not edited by any baton task yet`);
}
