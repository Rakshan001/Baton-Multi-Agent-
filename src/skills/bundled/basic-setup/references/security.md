# Security — four layers against a leaked secret

Every command here was verified against gitleaks' own repository and GitHub's documentation.
Do not substitute commands from blog posts; most of them are stale (see § Deprecated below).

| Layer | Stops | Defeated by |
|---|---|---|
| 1. `.gitignore` + `.env.example` | `git add .` catching your `.env` | `git add -f` |
| 2. gitleaks pre-commit hook | the secret entering git history at all | `--no-verify`, hook uninstalled |
| 3. GitHub push protection | the push reaching GitHub's servers | paid on private repos; audited bypass |
| 4. CI scan on PR | it reaching the main branch | branch protection disabled |

Layer 2 matters most: a secret first caught at *push* is already in local history, so the fix is
a history rewrite. Caught at *commit*, it is a one-line edit.

---

## Order of operations

```
MID-PHASE only → 0. scan history for secrets ALREADY committed   ← do this FIRST
                 1. .gitignore + .env.example
                 2. detect hook mechanism → install gitleaks hook
                 3. GitHub push protection (if a remote exists)
                 4. CI workflow
                 5. prove it works (references/verification.md)
```

## 0. Already leaked (MID-PHASE first action)

```bash
gitleaks git --redact --verbose        # full history
git ls-files | grep -E '(^|/)\.env'    # is a .env tracked right now?
```

If either finds something, **stop and report before doing anything else**:

> ⚠ `.env` has been committed since <date>, in <n> commits.
>
> **Installing a hook does not fix this.** The file is in git history — anyone who cloned or
> forked the repo has it, and if it was ever pushed to a public remote assume it is indexed.
>
> **The only real fix is to rotate the keys.** Do that first, at the provider. Rewriting history
> (`git filter-repo`, BFG) is optional cleanup afterwards — it does not un-leak anything.

Never quietly "fix" this by deleting the file and committing.

## 1. .gitignore and .env.example

Ensure `.gitignore` contains (append missing lines; **never rewrite the file**):

```gitignore
.env
.env.*
!.env.example
```

Then create `.env.example` with every variable name the project uses and **no real values**:

```
DATABASE_URL=postgresql://user:password@localhost:5432/dbname
API_KEY=
```

Find the variable names by grepping the source for `process.env.X`, `os.environ[...]`,
`os.getenv(...)`, `settings.X`, `import.meta.env.X`. `.env.example` is committed; `.env` never is.

## 2. The hook

### Mechanism detection — run this BEFORE writing anything

Setting `core.hooksPath` on a repo that already manages hooks **silently disables all of them**.
Git ignores `.git/hooks` entirely once `core.hooksPath` is set, and the pre-commit framework
installs into `.git/hooks`.

| Detected | Action |
|---|---|
| nothing (`git config core.hooksPath` empty, no `.husky/`, no `.pre-commit-config.yaml`, no `.git/hooks/pre-commit`) | create `.githooks/`, set `core.hooksPath` |
| an existing custom `.git/hooks/pre-commit` | **Do not set `core.hooksPath`** — it would disable their hook with no error at all. Append the gitleaks call to that hook, or ask |
| `core.hooksPath` already set to something else | never overwrite — show the current value and ask |
| `.husky/` present (hooksPath = `.husky/_`) | append the gitleaks line to `.husky/pre-commit`. **Do not touch `core.hooksPath`** |
| `.pre-commit-config.yaml` present | add the gitleaks hook to that file at a pinned `rev`. **Do not set `core.hooksPath`** |
| lefthook / other manager | add to that tool's config; report what you did |

For the pre-commit framework, add:

```yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.24.2          # pin; check for a newer tag
    hooks:
      - id: gitleaks
```

### The hook script

Full file in `references/templates.md`. The command is:

```bash
gitleaks git --pre-commit --redact --staged --verbose
```

This is taken from gitleaks' own `.pre-commit-hooks.yaml` — the authoritative source.

**Fail closed.** If gitleaks is not installed the hook must exit non-zero and block the commit.
`command -v gitleaks || exit 0` is the single most common bug in hand-written hooks: it passes
forever and protects nothing.

Then:

```bash
git config core.hooksPath .githooks       # only per the table above
chmod +x .githooks/pre-commit
```

### Teammate bootstrap — and its honest limit

`core.hooksPath` is local config. It does not clone. Teammates get protection only if something
arms it on their machine.

| Stack | Automatic? | Mechanism |
|---|---|---|
| Node-based (Next.js, Vite, Nuxt, Nest, Express) | **yes** | `"prepare": "git config core.hooksPath .githooks"` in `package.json` — runs on `npm install` |
| Python (Django, FastAPI) | **no** | Best available: `pre-commit init-templatedir ~/.git-template` + `git config --global init.templateDir ~/.git-template`, a once-per-machine developer setup |

There is no repo-side mechanism that arms a local hook on clone for non-Node stacks. Say this
plainly in the final report. **The enforcement guarantee lives in layers 3 and 4; the local hook
is fast feedback.**

### Deprecated — do not use

`gitleaks protect` and `gitleaks detect` were deprecated and hidden from help in **v8.19.0**.
Most tutorials still show `gitleaks protect --staged`, and so does gitleaks' own
`scripts/pre-commit.py`, which is stale. Use `gitleaks git` as above.

Exit codes: `0` clean · `1` leaks found or error · `126` unknown flag.

## 3. Push protection

**This layer is GitHub-specific.** Check the remote host before promising anything:

| Remote | Layer 3 |
|---|---|
| GitHub public | free — offer to enable |
| GitHub private | paid (GitHub Secret Protection) — say plainly it is unavailable on a free plan |
| GitLab | different product: GitLab Secret Push Protection / Secret Detection, tier-dependent. Point them at it; put the scan in `.gitlab-ci.yml`, not a GitHub workflow |
| Bitbucket / Azure DevOps / Gitea / self-hosted | **does not exist as designed** — say so. Layers 1, 2, 4 still apply |
| no remote yet | defer; note it in `STRUCTURE.md` |

Never write `.github/workflows/` into a repo whose remote is not GitHub — it will never run, and
it creates the false impression of a backstop.

### GitHub specifics

The only layer the developer cannot bypass locally. Check the remote first:

```bash
gh repo view --json visibility,nameWithOwner
```

- **Public repo → free.** Secret scanning and push protection are free on public repositories,
  no licence and no configuration. Offer to confirm it is on. Recommend yes.
- **Private/internal repo → paid.** Requires GitHub Secret Protection (repackaged out of
  Advanced Security in 2025), on Team or Enterprise Cloud, billed per active committer.
  **Do not imply the user is covered.** Say:

  > Server-side push protection needs a paid plan on private repos. You have the local hook and
  > the CI check. Be aware `git commit --no-verify` defeats the local hook, and nothing on
  > GitHub's side will stop that push.

- **No remote yet → defer.** Note it in `STRUCTURE.md` for when a remote is added.

Push protection covers pushes from the CLI, commits in the GitHub UI, file uploads, and REST API
requests. Users with write access can bypass with a stated reason, which is audited.

## 4. CI backstop

Workflow in `references/templates.md`. Two things it must get right:

- `fetch-depth: 0` — without full history the scan sees almost nothing.
- It is **detection, not prevention**: by the time CI runs, the secret is already on GitHub's
  servers. Treat a CI hit as "rotate the key", not "delete the branch".

Recommend enabling branch protection so the check is required to merge.

## Config: `.gitleaks.toml`

Full file in `references/templates.md`. Two points that are not optional:

**Database URLs are not covered by default.** The default ruleset has **no** rule for
`postgres://`, `mysql://`, `mongodb://`, `redis://` or `jdbc:`. The nearest default rule,
`generic-api-key`, keys on assignments like `password = "..."` with entropy ≥ 3.5, and will
**not** match `postgres://user:pass@host/db`. A custom rule is required.

**The allowlist is required too.** Without it the DB-URL rule matches its own example inside
`.gitleaks.toml` and in test fixtures, and a tool that cries wolf on day one teaches people to
type `--no-verify` — which disables everything.

## What is deliberately NOT solved

State these in the final report rather than implying total coverage:

1. **Secrets already in history** — the hook is blind to them. Rotate the key; nothing else works.
2. **`--no-verify`** — unfixable locally by design. Only layers 3 and 4 answer it.
3. **Unpatterned secrets** — `token = "acme-prod-7"` has no recognisable shape and low entropy.
   It will pass. No scanner solves this; the mitigation is the `AGENTS.md` rule that secrets
   never live in code at all.
4. **Someone deleting `.githooks/` or unsetting the config** — local config is local.
