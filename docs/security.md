# Security model

Baton runs entirely on your machine. This page describes its security posture
honestly: what is enforced, how, and where the residual risks are. Every claim
here maps to a specific source file — [`src/server.ts`](../src/server.ts),
[`src/util/origin.ts`](../src/util/origin.ts), and
[`src/util/exec.ts`](../src/util/exec.ts).

## Threat model in one line

The daemon exposes your repo's task data, git history, memory, and the ability to
launch coding agents over a local HTTP API. The realistic threats are (1) another
process or website on your machine reaching that API, and (2) untrusted input
(KB packs, skill URLs, task text, memory facts) abusing a code path. Baton is
**not** built to be exposed on a network or shared between untrusted users.

## Network surface: loopback only

The daemon binds to `127.0.0.1` only — it is never reachable from another host on
your network. Its CORS policy echoes back only loopback origins, so a third-party
website can never *read* a response:

```ts
// src/server.ts — corsOrigin()
function corsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (origin && isLoopbackOrigin(origin)) return origin;
  return 'null';
}
```

This lets the Vite dev server (any `localhost` port) and the daemon-served
dashboard work, while denying everyone else.

## Anti-CSRF: loopback Origin on every mutating request

Loopback binding + CORS stop a remote site from *reading* responses, but a
browser will still *send* a cross-origin "simple" request (a `text/plain` POST
that skips the CORS preflight). The server's side effect would run before CORS
blocks the unreadable reply. So a page you happen to visit could fire, e.g.,
`POST /api/tasks/:slug/agent/start` at `localhost` and launch an agent with an
attacker-chosen prompt.

The defense is a single central gate in
[`handle()`](../src/server.ts) that rejects any mutating method on `/api/`
unless the request's `Origin` is loopback (or absent — curl / same-origin):

```ts
// src/server.ts
if (isMutatingMethod(method) && path.startsWith('/api/') && !isLoopbackOrigin(req.headers.origin)) {
  return send(res, 403, { error: 'cross-origin request refused' }, origin);
}
```

The matching logic lives in [`src/util/origin.ts`](../src/util/origin.ts) and is
the single source of truth for both checks:

| Helper | Behavior |
| --- | --- |
| `isLoopbackOrigin(origin)` | `true` when `Origin` is absent **or** matches `https?://(localhost\|127.0.0.1\|[::1])(:port)?`. A present, non-loopback `Origin` is the only case refused. |
| `isMutatingMethod(method)` | `true` for `POST`, `PUT`, `PATCH`, `DELETE`. |

Because the check is central, you do not add per-endpoint Origin checks — that is
an explicit convention. New mutating endpoints are covered automatically.

## Write gate: `--write`

The daemon is **read-only by default**. Mutating endpoints (creating tasks,
merging, importing a KB, installing skills, starting agents, purging storage,
editing memory) all require the daemon to have been started with `--write`:

```bash
node dist/cli.js serve --write     # enable mutating actions
```

Without it, those endpoints return `403`:

```json
{ "error": "read-only", "hint": "start: baton serve --write" }
```

## Permanent purge: triple-guarded

`POST /api/storage/purge` permanently deletes selected data and reclaims git
objects — it is irreversible. It is guarded three ways:

1. **`--write`** must be enabled, or it returns the read-only error.
2. **Loopback `Origin`** is re-checked inline (defense in depth, in addition to
   the central anti-CSRF gate).
3. **A typed confirm phrase** must exactly match the phrase from the purge
   preview, or it returns `confirmation mismatch`.

```ts
// src/server.ts — POST /api/storage/purge
if (!opts.writeEnabled) return denyReadOnly(res, origin);
if (!isLoopbackOrigin(req.headers.origin)) return send(res, 403, { error: 'cross-origin request refused' }, origin);
// ...
if ((body.confirm ?? '').trim() !== preview.confirmPhrase) {
  return send(res, 400, { error: `confirmation mismatch — type "${preview.confirmPhrase}" exactly to proceed` }, origin);
}
```

The `GET /api/storage/purge` preview is read-only and shows exactly what a purge
would delete plus the required `confirmPhrase`.

## Git execution: shell-free and hardened

All git calls go through [`src/util/exec.ts`](../src/util/exec.ts), never a shell.
Commands run via `execa` with an argv array, so user-controlled task text cannot
be parsed, expanded, or injected. The wrapper also:

- **Prepends hardened `-c` config** before every subcommand — neutralizing
  pagers, credential helpers, askpass prompts, custom ssh commands, repo hooks,
  and the `ext::` transport (an RCE vector): `protocol.ext.allow=never`.
- **Sanitizes the environment** — strips `EDITOR`, `GIT_ASKPASS`, `GIT_SSH*`,
  `GIT_PROXY_COMMAND`, `GIT_CONFIG*`, `GIT_EXTERNAL_DIFF`, and related keys that
  could redirect git to an editor, pager, prompt, or alternate config; then sets
  `GIT_TERMINAL_PROMPT=0` and friends so git is fully non-interactive.
- **Times out** every command at `GIT_TIMEOUT_MS` (30s) so a hung git never
  blocks the daemon.

## Untrusted input hardening

| Surface | Guard | Source |
| --- | --- | --- |
| **KB import (`POST /api/kb/import`)** | Tar-slip guard: the pack is listed with `tar -tzf` first and **refused if any member path is absolute or contains `..`**, before extraction. | [`src/kb/transfer.ts`](../src/kb/transfer.ts) |
| **Skill import from URL** | SSRF guard: only `http(s)`; private / loopback / link-local / reserved hosts (e.g. `169.254.169.254`, `127.x`, `10.x`, `192.168.x`, `172.16–31.x`) are refused; redirects are followed manually and **re-validated on each hop**; fetch has a timeout. | [`src/skills/install.ts`](../src/skills/install.ts) |
| **Memory facts** | Secret rejection: facts matching key/token/JWT/inline-credential patterns (`sk-…`, `eyJ…`-JWTs, `password=`/`token=` assignments) are refused with guidance to describe *where* the credential lives instead of pasting it. | [`src/memory.ts`](../src/memory.ts) |

Memory also enforces size caps: **1200 chars per fact** and **500 facts** total
(`FACT_MAX_CHARS` / `FACT_CAP`).

### Request body size caps

| Endpoint(s) | Cap |
| --- | --- |
| JSON bodies (default `readBody` limit) | 1 MB (`1_000_000` bytes) |
| KB import (`POST /api/kb/import`) | 200 MB |
| Skill import (URL or file) | 256 KB |

Oversized payloads are aborted mid-stream rather than buffered.

## Agent authentication and permissions

Baton does **not** manage credentials for the agents it launches. When you run
an agent (Claude Code, Codex, Cursor, Gemini, Aider, OpenCode), it uses **your
own CLI's existing authentication** on this machine. Baton invokes each agent
with its **default permissions** — it does not pass any permission-bypass /
auto-approve / `--dangerously-*` flags on your behalf. Agents are sandboxed by
the same isolated git worktree they run in, not by Baton.

This is a deliberate honesty point: Baton coordinates agents but does not weaken
their own safety prompts.

## What Baton does *not* protect against

- **A malicious local process.** Anything that can already make loopback HTTP
  requests with a loopback `Origin` (or no `Origin`, like curl) can use the
  write API when `--write` is on. The model assumes you trust the processes on
  your own machine.
- **DNS rebinding** is a known residual: the SSRF guard checks hostnames as-is
  rather than resolving them, so it blocks literal private IPs reliably but not a
  hostname that resolves to one. Treat skill URLs as you would any download.
- **Network exposure.** Do not put the daemon behind a reverse proxy or bind it
  to a public interface — it is built for `127.0.0.1` only.

## Related

- [Configuration](./configuration.md) — daemon flags and `baton.config.json`.
- [Dashboard](./dashboard.md) — the screens served by the daemon.
- [README](../README.md) — overview and setup.
