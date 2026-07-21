# Security baseline — the Security axis fallback

The vulnerability classes to check any diff against. This applies **even in a repo with no
`SECURITY.md`**, which is why the Security axis always carries it.

Three rules bind it:

- **Only what this diff introduces or worsens.** A pre-existing hole the diff merely moved past is
  not a finding. Say so if it's serious, but keep it out of the findings list.
- **Source → sink, or it isn't a finding.** Name the untrusted input, name where it lands, and say
  what an attacker gains. "This could be unsafe" is not a finding.
- **A repo's hardened helper is a documented standard.** If the codebase says to route through an
  exec wrapper, a sanitizer, an auth guard, or a query builder, a diff that bypasses it is a
  **violation**, not a heuristic.

Defence-in-depth wishes ("could also validate here") are not vulnerabilities. Don't file them.

## Classes to check

| Class | What to look for | What the attacker gains |
| --- | --- | --- |
| **Injection** | User input concatenated into SQL, a shell command, a template, or an eval. Look for string building where a parameterized/escaped API exists. | Arbitrary query or command execution. |
| **Command execution** | `exec`/`spawn` with a shell, or user input reaching argv. Note whether the repo has a shell-free wrapper the diff bypasses. | Code execution as the process user. |
| **Path traversal** | User input reaching a filesystem path without normalization; missing `..` and absolute-path rejection; archive extraction. | Read or write outside the intended directory. |
| **Authz / access control** | A new route, handler, or IPC entry point with no ownership or permission check; a check on the client side only; an ID taken from the request and trusted. | Acting as another user; reading others' data. |
| **Authn** | Token/session handling changes: comparison not constant-time, missing expiry, tokens in URLs or logs, weak randomness for anything security-bearing. | Session forgery or takeover. |
| **SSRF** | User-supplied URL fetched server-side without host allow-listing; redirect following; access to cloud metadata endpoints. | Reach internal services from a trusted position. |
| **CSRF / origin** | New state-changing endpoint outside the repo's origin/CSRF guard; a GET that mutates state. | A page the user visits performs actions as them. |
| **Secret handling** | Credentials, keys, or tokens added to source, logs, error messages, or committed fixtures; secrets in a URL; secrets echoed to stdout. | Direct credential theft. |
| **Deserialization / parsing** | Untrusted input into a deserializer, YAML loader, or dynamic import; prototype pollution via merged objects. | Code execution or object-graph tampering. |
| **Resource exhaustion** | Unbounded read, allocation, or loop driven by request size; no timeout on an outbound call; unbounded concurrency. | Cheap denial of service. |
| **Output encoding** | User data rendered without escaping; `innerHTML`/`dangerouslySetInnerHTML`; unescaped content in generated markup. | Script execution in another user's context. |
| **Permissions on disk** | New files holding secrets or tokens created without restrictive modes; broadened directory permissions. | Local privilege escalation to the data. |

## Reporting format

```
<Class> — <file>:<line>
  source: <the untrusted input, and how it gets there>
  sink:   <where it lands>
  impact: <what an attacker gains>
  <the hunk, quoted>
```

And when the diff bypasses a hardened helper the repo documents:

```
VIOLATION: <security doc / helper> — "<the rule, quoted>"
  <file>:<line> bypasses <helper>
  <the hunk, quoted>
```

## What is NOT a finding

- A pre-existing issue the diff didn't introduce or worsen.
- "Could also validate here" with no reachable untrusted input.
- Missing hardening that the threat model explicitly puts out of scope.
- Anything a dependency scanner or SAST step in CI already reports.
- Theoretical risk with no source-to-sink path you can actually trace in this diff.
