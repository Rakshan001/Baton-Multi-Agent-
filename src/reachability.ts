/**
 * "Can anyone else actually reach this daemon, and if not, what do I run?"
 *
 * The Share panel's data. It answers a question that is genuinely easy to get
 * wrong: a hub can look perfectly healthy on the owner's screen while being
 * unreachable by every single person they just sent an invite to, because the
 * dashboard they are looking at is served over loopback either way.
 *
 * What this module does NOT do is start a tunnel. Baton reports what it can
 * observe and hands over the exact command for what it cannot — see the note on
 * `TunnelTool` for why that split is deliberate rather than unfinished.
 */
import { networkInterfaces } from 'node:os';
import { probeBinary } from './util/exec.js';
import { hasActiveMembers, activeMembers, loadMembers } from './members.js';
import { isLoopbackAddr } from './util/origin.js';

/**
 * A way to expose the daemon. Baton detects whether the tool is installed and
 * prints the command; it does not run it.
 *
 * That is a deliberate line, not a missing feature. Starting a tunnel means
 * owning a long-lived child process, its crash and restart behaviour, its
 * credentials, and its orphan cleanup across daemon restarts — and every one of
 * those paths is unverifiable on a machine where the binary is absent. A
 * start/stop button that has never once been observed working is worse than a
 * command the owner pastes and can see the output of.
 */
export interface TunnelTool {
  id: 'ssh' | 'tailscale' | 'cloudflared';
  label: string;
  /** False for `ssh`, which needs nothing installed here. */
  needsBinary: boolean;
  installed: boolean;
  /** How to get it, when it is missing. */
  install?: string;
  /** Why you would pick this one. */
  why: string;
  /** Commands, in order, ready to copy. Commands ONLY — prose rendered with a
   *  `$` prompt and a copy button invites someone to paste a sentence. */
  steps: string[];
  /** What happens after the commands. Prose, never rendered as a command. */
  then?: string;
}

export interface Reachability {
  /** The address `serve` bound. */
  bind: string;
  loopbackOnly: boolean;
  port: number;
  /** Names declared with `--allowed-host`. */
  allowedHosts: string[];
  /** URLs that should work from another machine, best guess first. */
  urls: string[];
  /** LAN addresses found on this host's interfaces. */
  lanAddresses: string[];
  members: { active: number; owners: number };
  tools: TunnelTool[];
  /** Things that would make an invite fail, phrased for a human. */
  blockers: string[];
  /** Worth knowing, not fatal. */
  notes: string[];
}

/** Non-loopback IPv4 addresses on this machine's own interfaces. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (isLoopbackAddr(a.address)) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)].sort();
}

function tools(installed: Record<string, boolean>, port: number, lan: string): TunnelTool[] {
  return [
    {
      id: 'ssh',
      label: 'SSH port-forward',
      needsBinary: false,
      installed: true,
      why: 'Nothing to install, nothing exposed, no Baton credential needed — the SSH key is the auth. Best for your own devices, or anyone who already has shell access here.',
      steps: [`ssh -N -L ${port}:localhost:${port} <you>@${lan}`],
      then: `Then open http://localhost:${port} on the other machine — it reaches this daemon through the tunnel.`,
    },
    {
      id: 'tailscale',
      label: 'Tailscale',
      needsBinary: true,
      installed: !!installed.tailscale,
      ...(installed.tailscale ? {} : { install: 'https://tailscale.com/download' }),
      why: 'A private network between your devices and your team. The daemon is reachable by its tailnet name and never touches the public internet.',
      steps: [
        'tailscale up',
        'baton serve --write --host 0.0.0.0 --allowed-host <your-tailnet-name>',
      ],
      then: 'Share the tailnet hostname with members. They need Tailscale on their machines too.',
    },
    {
      id: 'cloudflared',
      label: 'Cloudflare named tunnel',
      needsBinary: true,
      installed: !!installed.cloudflared,
      ...(installed.cloudflared ? {} : { install: 'brew install cloudflared' }),
      /*
       * Named, never a quick tunnel. A quick tunnel mints a random public
       * hostname with no access control in front of it — the whole knowledge
       * base would then be one guessed URL plus a stolen token away, and the
       * URL rotates so nobody can even audit what was exposed.
       */
      why: 'A stable public hostname for members outside your network. Use a NAMED tunnel with Cloudflare Access in front — never a quick tunnel, which publishes a random public URL with nothing guarding it.',
      steps: [
        'cloudflared tunnel login',
        'cloudflared tunnel create baton',
        'cloudflared tunnel route dns baton baton.<your-domain>',
        `cloudflared tunnel run --url http://localhost:${port} baton`,
        'baton serve --write --behind-proxy --allowed-host baton.<your-domain>',
      ],
      /*
       * --behind-proxy is not optional here, and it is the whole reason this
       * recipe was unsafe: cloudflared dials the daemon over loopback, so
       * without it every request off the public internet arrives wearing
       * 127.0.0.1 and `decideAccess` reads it as the owner at the keyboard —
       * no member token, and terminals and agent launches reachable, both of
       * which are meant to be loopback-only forever. It costs you your own
       * credential-free access on this machine; that is the trade for putting
       * the daemon on the internet.
       */
      then: 'You will need a member token yourself now — --behind-proxy stops trusting loopback, because your proxy arrives on it too. Put Cloudflare Access in front of the hostname as well, so a stolen member token is not the only thing between the internet and your knowledge base.',
    },
  ];
}

export interface ReachabilityInput {
  root: string;
  bind: string;
  port: number;
  allowedHosts: string[];
  writeEnabled: boolean;
}

export async function assessReachability(input: ReachabilityInput): Promise<Reachability> {
  const { root, bind, port, allowedHosts, writeEnabled } = input;
  const loopbackOnly = isLoopbackAddr(bind);
  const lan = lanAddresses();
  const reg = await loadMembers(root);
  const active = activeMembers(reg);

  const [tailscale, cloudflared] = await Promise.all([
    probeBinary('tailscale', ['version']),
    probeBinary('cloudflared', ['--version']),
  ]);

  const blockers: string[] = [];
  const notes: string[] = [];

  /*
   * The blocker that matters most, and the one an owner is least likely to
   * notice: their own dashboard works, so nothing looks wrong. Everyone they
   * invite gets a connection refused.
   */
  if (loopbackOnly) {
    blockers.push(
      'This daemon is bound to loopback, so nobody on another machine can reach it — including anyone you invite. Pick a route below.',
    );
  }
  if (!hasActiveMembers(reg)) {
    blockers.push('No members exist yet, so no one can authenticate. Create an invite first.');
  }
  if (!writeEnabled) {
    notes.push('Read-only daemon: members can read, but nothing can be changed — including minting invites. Restart with `baton serve --write`.');
  }
  // Declared names are the ONLY non-loopback Host values that get past the
  // anti-rebinding guard, so a bound-but-undeclared daemon 403s every request
  // and looks, from outside, exactly like a firewall problem.
  if (!loopbackOnly && allowedHosts.length === 0) {
    notes.push(
      `Bound to ${bind} but no --allowed-host declared: requests arriving under a hostname (rather than a bare IP) will be refused. Add --allowed-host <name> for each name members use.`,
    );
  }
  if (active.length > 0 && !active.some((m) => m.role === 'owner')) {
    notes.push('No active owner — nobody can manage members from the dashboard. Fix with `baton member add`.');
  }

  const urls = loopbackOnly
    ? []
    : [
        ...allowedHosts.map((h) => `http://${h}${/:\d+$/.test(h) ? '' : `:${port}`}`),
        ...(bind === '0.0.0.0' ? lan.map((a) => `http://${a}:${port}`) : [`http://${bind}:${port}`]),
      ];

  return {
    bind,
    loopbackOnly,
    port,
    allowedHosts,
    urls: [...new Set(urls)],
    lanAddresses: lan,
    members: { active: active.length, owners: active.filter((m) => m.role === 'owner').length },
    tools: tools({ tailscale, cloudflared }, port, lan[0] ?? '<this-machine>'),
    blockers,
    notes,
  };
}
