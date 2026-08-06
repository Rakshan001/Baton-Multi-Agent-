/**
 * Which side of the hub this machine is on — spec §7.6.
 *
 * `src/access.ts` answers this for the daemon, where a caller arrives over a
 * socket carrying a token. The CLI has no socket and no token: the person
 * running `baton plan apply` is whoever is sitting at the machine. So the
 * question a command can actually ask is not "who are you" but "whose plan is
 * this" — and that is settled by `.baton/host.json`. Its presence means this
 * repo's plan comes from someone else's hub.
 *
 * What goes wrong without the check is not privilege escalation, it is a silent
 * fork. A member who runs `plan apply` rewrites their own tasks.json while the
 * hub's is unchanged; from then on the two machines coordinate against
 * different plans, agree on nothing, and nothing reports an error — every
 * claim, every phase barrier and every dependency is being decided against a
 * plan the rest of the team does not have. `integrate` is worse in kind: it
 * merges other people's branches into the shared base, so a member doing it
 * locally and pushing lands work the operator never approved.
 *
 * Deliberately NOT gated: `push`. Spec §7.6 does not list it, and it must not
 * be — a member finishing a task and publishing it is the entire mechanism team
 * mode exists for. Gating it would wedge every plan that crosses a machine.
 *
 * There is no `--force`. An escape hatch on an authorization gate is the gate,
 * and the CLI is a surface agents call. `baton host clear` is the deliberate,
 * explicit way to stop being a member — it says what it does.
 */
import { loadHostLink } from './host-link.js';

export interface OperatorVerdict {
  allowed: boolean;
  /** The hub this machine answers to, when that is why it was refused. */
  hostUrl?: string;
}

/**
 * The decision, pure, so §7.6's rule is one testable line rather than a branch
 * inside three commands.
 */
export function decideOperator(link: { url: string } | null | undefined): OperatorVerdict {
  return link ? { allowed: false, hostUrl: link.url } : { allowed: true };
}

/**
 * Gate an operator-only command. Returns true when the caller may proceed;
 * prints the refusal and sets a failing exit code when not.
 *
 * `action` is the command as the user typed it, because "not allowed" without
 * the subject reads as a bug in Baton rather than a rule about this machine.
 */
export async function requireOperator(root: string, action: string): Promise<boolean> {
  const verdict = decideOperator(await loadHostLink(root));
  if (verdict.allowed) return true;

  console.error(`✗ \`${action}\` is the operator's to run.`);
  console.error(`  This machine is a member of ${verdict.hostUrl} — the plan is set there, not here.`);
  console.error('  Running it locally would fork the plan: your tasks would stop matching');
  console.error('  everyone else\'s, and nothing would report an error.');
  console.error('\n  Ask the operator to run it. If this machine should not be a member:  baton host clear');
  process.exitCode = 1;
  return false;
}
