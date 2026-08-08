// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The member side of the live plane: where a member's daemon is pointed, and the
 * credential it uses.
 *
 * Stored at `.baton/host.json`, 0600 — it holds a live token. This is the
 * counterpart to `src/members.ts` (which is what the HOST keeps); a machine can
 * be both, and the two files never overlap.
 *
 * Deliberately its own module rather than part of `serve`: Phase 7's invite flow
 * (`baton join --token`) writes exactly this file, so the storage contract is
 * settled before the UI that produces it exists.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { batonDir } from './store.js';

export interface HostLink {
  /** Base URL of the host daemon, no trailing slash. */
  url: string;
  /** Member token minted by `baton member add` on the host. */
  token: string;
  /** Free-text label for this machine, shown in the host's roster. */
  device?: string;
}

export class HostLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostLinkError';
  }
}

export function hostLinkPath(root: string): string {
  return join(batonDir(root), 'host.json');
}

/**
 * Only http and https, and no credentials in the URL.
 *
 * A userinfo segment (`https://user:tok@host`) would put a live secret into
 * every log line and error message that echoes the URL — the token belongs in
 * the Authorization header, which is the one place it is not casually copied.
 */
export function isValidHostUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return !!u.hostname;
}

export function normalizeHostUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export async function loadHostLink(root: string): Promise<HostLink | null> {
  try {
    const raw = JSON.parse(await readFile(hostLinkPath(root), 'utf-8')) as Partial<HostLink>;
    const url = normalizeHostUrl(typeof raw.url === 'string' ? raw.url : '');
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (!isValidHostUrl(url) || !token) return null;
    return { url, token, ...(typeof raw.device === 'string' ? { device: raw.device.slice(0, 80) } : {}) };
  } catch {
    return null;
  }
}

export async function saveHostLink(root: string, link: HostLink): Promise<string> {
  const url = normalizeHostUrl(link.url);
  if (!isValidHostUrl(url)) throw new HostLinkError(`not a usable host URL: ${link.url}`);
  if (!link.token.trim()) throw new HostLinkError('a member token is required');
  const path = hostLinkPath(root);
  await mkdir(batonDir(root), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ url, token: link.token.trim(), ...(link.device ? { device: link.device.slice(0, 80) } : {}) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}

export async function clearHostLink(root: string): Promise<boolean> {
  try {
    await rm(hostLinkPath(root));
    return true;
  } catch {
    return false;
  }
}

/** What a member reports. Paths must be repo-relative (see federation.ts). */
export interface HeartbeatPayload {
  device?: string;
  sessions?: number;
  claims: Array<{ projectId: string | null; relPath: string; agent: string | null; branch: string | null }>;
}

export interface HeartbeatOutcome {
  ok: boolean;
  /** Present on success — the shared picture, echoed by the host. */
  members?: Array<{ memberId: string; memberName: string; sessions: number }>;
  claims?: Array<{ relPath: string; memberId: string; branch: string | null }>;
  overlaps?: Array<{ relPath: string; sameBranch: boolean }>;
  /** Notices the host's owner has queued for this member. Re-sent on every
   *  heartbeat rather than delivered once, so a daemon that dies between
   *  receiving and printing one does not swallow it — the caller de-dupes by
   *  `id`. See MemberWarning in federation.ts. */
  warnings?: Array<{ id: string; message: string; from: string; at: string }>;
  /** Present on failure — already phrased for a human. */
  error?: string;
}

/**
 * Send one heartbeat. Never throws: the host being unreachable is an expected,
 * routine condition (laptop asleep, tunnel down), and it must degrade to
 * local-only operation rather than disturbing anything the member is doing.
 */
export async function sendHeartbeat(
  link: HostLink,
  payload: HeartbeatPayload,
  timeoutMs = 5000,
): Promise<HeartbeatOutcome> {
  try {
    const res = await fetch(`${link.url}/api/presence/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { ok: false, error: 'host rejected the token (revoked?)' };
    if (!res.ok) return { ok: false, error: `host replied ${res.status}` };
    return { ok: true, ...(await res.json() as object) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
