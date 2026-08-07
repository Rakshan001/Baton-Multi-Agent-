# Copyable templates

Adapt the placeholders in `<angle brackets>`. Never overwrite an existing file — show a diff and
ask, or append a clearly-marked section.

---

## `.githooks/pre-commit`

`chmod +x` it after writing. Install with `git config core.hooksPath .githooks` — but **only**
after the mechanism check in `references/security.md` § Mechanism.

```bash
#!/usr/bin/env bash
# Blocks commits containing secrets. Installed by the basic-setup skill.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo ""
  echo "  ✗ COMMIT BLOCKED — gitleaks is not installed."
  echo ""
  echo "  This hook cannot check your commit for passwords or API keys,"
  echo "  so it refuses to let it through. Install gitleaks:"
  echo ""
  echo "    macOS         brew install gitleaks"
  echo "    other         https://github.com/gitleaks/gitleaks/releases"
  echo ""
  exit 1
fi

if ! gitleaks git --staged --verbose --redact=100 --no-banner; then
  echo ""
  echo "  ✗ COMMIT BLOCKED — a secret was found in your staged changes."
  echo ""
  echo "  Move the value into .env (which is never committed), and use the"
  echo "  variable in your code instead. Add its NAME to .env.example."
  echo ""
  echo "  If this is genuinely not a secret, add an allowlist entry to"
  echo "  .gitleaks.toml — do not use --no-verify."
  echo ""
  exit 1
fi
```

The `command -v … || exit 0` idiom found in many tutorials is a bug: it makes the hook pass
forever when the scanner is missing. Fail closed.

---

## `.gitleaks.toml`

```toml
# Secret scanning config. Installed by the basic-setup skill.

[extend]
useDefault = true          # keep all built-in gitleaks rules

# The default ruleset has NO rule for database connection URLs.
# `generic-api-key` keys on `password = "..."`-style assignments and will not
# match postgres://user:pass@host/db. This adds that coverage.
[[rules]]
id = "database-connection-uri"
description = "Database connection URI with inline credentials"
regex = '''(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql|mariadb|clickhouse|jdbc:[a-z0-9]+)://[^:\s/@]+:([^@\s'"]+)@'''
secretGroup = 1
keywords = ["postgres","postgresql","mysql","mongodb","redis","amqp","mssql","mariadb","clickhouse","jdbc"]

[[rules]]
id = "private-key-block"
description = "Private key block"
regex = '''-----BEGIN[ A-Z]{0,20}PRIVATE KEY[ A-Z]{0,20}-----'''
keywords = ["-----BEGIN"]

# Without this allowlist the rules above match their own examples in this file
# and in test fixtures. False positives on day one teach people to use
# --no-verify, which disables every protection at once.
[[allowlists]]
description = "config, docs and fixtures may contain example values"
paths = [
  '''\.gitleaks\.toml$''',
  '''(^|/)\.env\.example$''',
  '''(^|/)tests?/fixtures?/''',
  '''(^|/)docs?/''',
]
regexes = [
  '''://[^:@\s]+:(pass|password|passwd|changeme|example|secret|yourpassword|x{3,})@''',
  '''localhost|127\.0\.0\.1''',
]
```

For **strict** security level (payments / health / personal records), also disable nothing and
consider adding organisation-specific token patterns as extra `[[rules]]`.

---

## `.github/workflows/security.yml`

```yaml
name: Security

on:
  pull_request:
  push:
    branches: [main, master]

jobs:
  gitleaks:
    name: Secret scan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # REQUIRED — without full history the scan sees almost nothing
      - uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

This is **detection, not prevention** — by the time it runs the secret is already on GitHub's
servers. A hit means *rotate the key*, not *delete the branch*. Recommend making this check
required in branch protection.

---

## `package.json` — teammate bootstrap (Node stacks only)

```json
{
  "scripts": {
    "prepare": "git config core.hooksPath .githooks"
  }
}
```

Runs automatically on `npm install`, so a teammate who clones and installs is protected without
reading anything. If a `prepare` script already exists, append with `&&` rather than replacing it.

There is no equivalent for Python stacks — see `references/security.md` § Teammate bootstrap.

---

## `STRUCTURE.md` — for humans

```markdown
# Project structure

<one sentence: what this project is>

Pattern: **<feature-modular>**. <one sentence why it was chosen>

## Where things go

| I want to add… | Put it here |
|---|---|
| a new page | `<src/app/<route>/page.tsx>` |
| a new API endpoint | `<src/app/api/<name>/route.ts>` |
| something only one feature uses | `<src/features/<feature>/>` |
| something two features share | `<src/shared/>` |
| a test | `<next to the file, as *.test.ts>` |

## Rules

- **Features never import from each other.** Combine them at the app layer instead.
- **No barrel files** (`index.ts` that only re-exports) — they break tree-shaking.
- **No secrets in code, ever.** Put the value in `.env`, add its name to `.env.example`.
- **Don't create new top-level folders.** If something seems not to fit, it belongs in a
  feature or in shared — ask before inventing a new home for it.

## Security

- A pre-commit hook scans for secrets. If it blocks you, it is right — move the value to `.env`.
- Never use `git commit --no-verify`. It turns the protection off.
- <Push protection: enabled | not available on this plan>

## Growing up

When <this project has 3+ areas and a team>, the next step is `<modular-monolith>`.
See the pattern ladder before restructuring.
```

---

## `AGENTS.md` — for every AI agent

Read by Claude Code, Cursor, Codex, Copilot, Windsurf, Zed, Gemini CLI, Aider, goose, opencode,
JetBrains Junie and others. **If the file already exists (Next.js creates one), append this
section — never overwrite.**

```markdown
## Project structure rules

Pattern: **<feature-modular>**. Follow it exactly — do not reorganise.

- New feature → `<src/features/<name>/>`. **Never create a new top-level folder.**
- Shared code → `<src/shared/>`. Only if two or more features use it.
- **Never import between features.** Compose at the app layer.
- **Never create barrel files** (`index.ts` re-exporting a folder) — breaks tree-shaking.
- Tests live next to the code they test.

## Security rules

- **Never put a secret in source code** — not an API key, password, token, or database URL.
  Read from the environment; add the variable NAME to `.env.example` with an empty value.
- **Never commit `.env`.** Never suggest `git commit --no-verify` or `git add -f .env`.
- A gitleaks pre-commit hook enforces this. If it blocks a commit, fix the code — do not bypass it.

## Commands

- install: `<npm install>`   dev: `<npm run dev>`   test: `<npm test>`   lint: `<npm run lint>`
```

---

## `CLAUDE.md` and `.cursor/rules/structure.mdc` — pointers only

One source of truth. These just point at it.

`CLAUDE.md` (append if it exists):

```markdown
## Structure and security rules

See [AGENTS.md](AGENTS.md) — it is the source of truth for where files go and how secrets are
handled in this project.
```

`.cursor/rules/structure.mdc`:

```markdown
---
description: Project structure and security rules
alwaysApply: true
---

See AGENTS.md for where files go and how secrets are handled. Follow it exactly.
```

---

## `.gitignore` additions

Append only the lines that are missing. **Never rewrite the file.**

```gitignore
# Secrets — never commit these
.env
.env.*
# case variants — macOS and Windows filesystems are case-insensitive,
# but .gitignore matching is not, so .ENV would otherwise slip through
.[Ee][Nn][Vv]
.[Ee][Nn][Vv].*
!.env.example
```
