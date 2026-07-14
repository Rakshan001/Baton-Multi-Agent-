# Security Policy

## Supported versions

Baton is under active development. Security fixes are applied to the latest
release on the `main` branch. Older `0.0.x` releases are not separately patched.

| Version | Supported          |
| ------- | ------------------ |
| latest (`main`) | ✅         |
| older `0.0.x`   | ❌         |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately so they can be fixed before public disclosure:

- **Preferred:** open a [GitHub private security advisory](https://github.com/Rakshan001/Baton-Multi-Agent-/security/advisories/new).
- **Or email:** **rakshanshetty2003@gmail.com** with the subject line
  `SECURITY: <short summary>`.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected component, and version/commit).
- Any suggested remediation, if you have one.

## What to expect

- **Acknowledgement** of your report within a few days.
- An assessment and, if confirmed, a fix on a coordinated timeline.
- Credit for the discovery once a fix is released, unless you prefer to remain
  anonymous.

## Scope notes

Baton runs a **local daemon** intended for `localhost` use. Relevant hardening
already in place includes a loopback-Origin anti-CSRF gate on mutating API
endpoints, shell-free hardened git invocation via `src/util/exec.ts`, and
YAML-only frontmatter parsing via `src/util/frontmatter.ts` (executable
frontmatter engines are refused). Reports about exposing the daemon to untrusted
networks, git-argument injection, or path-traversal in file/worktree handling are
especially welcome.
