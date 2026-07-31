/**
 * `baton host set|status|clear` — point this machine's daemon at a hub host, so
 * its agents' file claims join the shared picture.
 *
 * Purely opt-in. With no host link the daemon behaves exactly as it always has:
 * local signals, local checks, no network calls at all.
 */
import { gitRoot } from '../git.js';
import {
  clearHostLink, hostLinkPath, isValidHostUrl, loadHostLink, normalizeHostUrl, saveHostLink,
  sendHeartbeat, HostLinkError,
} from '../host-link.js';

export async function hostSetCmd(url: string, opts: { token?: string; device?: string } = {}): Promise<void> {
  const root = await gitRoot();
  const clean = normalizeHostUrl(url);
  if (!isValidHostUrl(clean)) {
    console.error(`Not a usable host URL: ${url}`);
    console.error('  Expected something like  http://mac-mini.local:7077  (http/https, no credentials in the URL).');
    process.exitCode = 1;
    return;
  }
  if (!opts.token) {
    console.error('A member token is required:  baton host set <url> --token baton_…');
    console.error('  The hub owner mints one with:  baton member add "<your name>"');
    process.exitCode = 1;
    return;
  }

  try {
    const path = await saveHostLink(root, { url: clean, token: opts.token, ...(opts.device ? { device: opts.device } : {}) });
    console.log(`✓ linked to ${clean}`);
    console.log(`  stored 0600 at ${path}`);
  } catch (e) {
    if (e instanceof HostLinkError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  // Prove it works now rather than failing silently on the first heartbeat.
  const link = await loadHostLink(root);
  const probe = link ? await sendHeartbeat(link, { claims: [] }) : { ok: false, error: 'link unreadable' };
  if (probe.ok) {
    console.log(`  ✓ host reachable — ${probe.members?.length ?? 0} member(s) online`);
    console.log('  Claims publish while `baton serve` runs here.');
  } else {
    console.log(`  ! could not reach the host yet (${probe.error})`);
    console.log('  The link is saved; the daemon retries on its own and works local-only meanwhile.');
  }
}

export async function hostStatusCmd(): Promise<void> {
  const root = await gitRoot();
  const link = await loadHostLink(root);
  if (!link) {
    console.log('Not linked to a host — this daemon coordinates locally only.');
    console.log(`  Link one:  baton host set <url> --token baton_…   (would write ${hostLinkPath(root)})`);
    return;
  }
  console.log(`host:   ${link.url}`);
  console.log(`device: ${link.device ?? '(unset)'}`);
  console.log('token:  stored (never printed)');

  const probe = await sendHeartbeat(link, { claims: [] });
  if (!probe.ok) {
    console.log(`\n✗ unreachable: ${probe.error}`);
    console.log('  Local coordination is unaffected.');
    return;
  }
  console.log(`\n✓ reachable — ${probe.members?.length ?? 0} member(s) online, ${probe.claims?.length ?? 0} file(s) claimed`);
  for (const m of probe.members ?? []) console.log(`    ${m.memberName} (${m.sessions} session(s))`);
}

export async function hostClearCmd(): Promise<void> {
  const root = await gitRoot();
  const had = await clearHostLink(root);
  console.log(had ? '✓ host link removed — this daemon is local-only again.' : 'No host link to remove.');
}
