# Edge cases

Check these before acting. Each row is a real situation that silently breaks the setup or
damages the user's repo if handled naively. **When in doubt, report and ask — never guess.**

## Repository state

| Situation | Detect | Do |
|---|---|---|
| Not a git repo at all | `git rev-parse --git-dir` fails | Offer `git init` and explain why (hooks and history scanning both need it). Never init silently. |
| Repo with **no commits yet** | `git rev-parse HEAD` fails | `gitleaks git` errors on an empty history. Skip the history scan, say so, and run it after the first commit. The pre-commit hook still works. |
| Detached HEAD | `git symbolic-ref -q HEAD` fails | Stop. Ask the user to check out a branch first — committing here loses work. |
| Uncommitted changes present | `git status --porcelain` non-empty | In MID-PHASE, stop and ask them to commit or stash. In INITIAL on an empty dir this is normal. |
| Shared checkout, another agent active | recent commits by others, files changing under you | **Do not `git stash`, do not switch branches.** Both wipe another session's working tree. Work only on your own files. |
| Submodules present | `.gitmodules` exists | Scan and set up the parent repo only. Submodules have their own hooks and their own history — report them as out of scope. |
| Monorepo (workspaces / turbo / nx / lerna) | `workspaces` in package.json, `turbo.json`, `nx.json`, `pnpm-workspace.yaml` | Security layers apply repo-wide and are safe. **Per-package structure is out of scope** — report and stop there. |
| Repo cloned from someone else | remote is not the user's, or no write access | Structure advice only. Do not restructure code you cannot push. |
| Very large history | `git rev-list --count HEAD` in the 6-figure range | The history scan may take minutes. Warn before starting; don't let it look like a hang. |

## Hook mechanism — the dangerous ones

Setting `core.hooksPath` makes git ignore `.git/hooks` **entirely**.

| Situation | Detect | Do |
|---|---|---|
| A custom hook already in `.git/hooks/pre-commit` | file exists and is executable | **Do not set `core.hooksPath`** — it would disable their hook with no error. Append the gitleaks call to the existing hook, or ask. |
| husky | `.husky/` exists, `core.hooksPath` = `.husky/_` | Add to `.husky/pre-commit`. Never touch `core.hooksPath`. |
| pre-commit framework | `.pre-commit-config.yaml` exists | Add the gitleaks repo/rev/hook. Never set `core.hooksPath` — its hook lives in `.git/hooks`. |
| lefthook / overcommit / other | their config file exists | Add to that tool. Report what you did. |
| A **global** `core.hooksPath` is set | `git config --global core.hooksPath` non-empty | A repo-local value overrides it, which may disable hooks the user relies on everywhere. Tell them before setting it. |
| `core.hooksPath` already set to something else | `git config --local core.hooksPath` non-empty | Never overwrite. Show the current value and ask. |

## Secret scanning

| Situation | Do |
|---|---|
| gitleaks not installed | Scaffolding continues; the hook is installed and **fails closed**. The report must say the project is not yet protected and give the install command. |
| `.gitleaks.toml` already exists | Never overwrite. Show the missing rules (especially `database-connection-uri`) as a diff and ask to merge. |
| `.env` is tracked right now | Urgent. Rotate keys → `git rm --cached .env` → add to `.gitignore` → commit. Say clearly that untracking does **not** remove it from history. |
| The canary in the drill isn't flagged | The drill proves nothing. Swap to a different detector shape and re-run. Never accept a silent pass. |
| Repo legitimately contains test fixtures with fake keys | Add them to the `[[allowlists]]` `paths` rather than disabling rules. |
| Pre-existing `.env.example` | Merge missing variable names in; never overwrite (it may carry comments that matter). |

## Remotes and hosting — not everyone is on GitHub

Layer 3 (push protection) is **GitHub-specific**. Do not claim it elsewhere.

| Remote | Do |
|---|---|
| GitHub, public | Free push protection. Offer to enable. Recommend yes. |
| GitHub, private | Needs paid GitHub Secret Protection. State plainly that layer 3 is unavailable on their plan. |
| **GitLab** | No GitHub push protection. GitLab has its own Secret Push Protection / Secret Detection (tier-dependent) — point them at it, and put the gitleaks job in `.gitlab-ci.yml` instead of a GitHub workflow. |
| **Bitbucket / Azure DevOps / Gitea / self-hosted** | Layer 3 does not exist as designed. Say so. Layers 1, 2 and 4 still apply — write the CI job for their platform. |
| No remote yet | Defer layer 3, note it in `STRUCTURE.md` for when a remote is added. |
| `gh` not installed or not authenticated | Skip the automated check; give the manual click-path in the report instead of failing. |

**Never write a `.github/workflows/` file into a repo whose remote is not GitHub.** It will never run, and it creates the false impression of a backstop.

## Scaffolding

| Situation | Do |
|---|---|
| Scaffolder runs `git init` inside an existing repo | `create-next-app` initialises git by default. Pass `--disable-git` (Next.js) or `--skip-git` (Nest) when a repo already exists, or you create a nested repo that silently swallows the new files. |
| Directory not empty | Never run a scaffolder. Only `.git`, `README*`, `LICENSE*`, `.gitignore` and dotfiles count as "empty enough" — anything else means MID-PHASE. |
| Package manager ambiguity | Detect by lockfile: `package-lock.json`→npm, `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, `bun.lockb`→bun. Empty dir → ask, recommend npm. Pass the matching `--use-*` flag so the scaffolder doesn't pick differently. |
| Offline, or a corporate proxy blocks the registry | `npx create-*` will fail confusingly. Detect early, report it as a network problem, and do not leave a half-scaffolded directory behind. |
| Scaffolder fails halfway | Report exactly what exists on disk. Never describe a partial scaffold as complete. |
| Project name is invalid | npm rejects capitals, spaces and leading dots. Suggest a valid kebab-case name rather than failing at the CLI. |
| Path contains spaces or non-ASCII | Quote every path in generated scripts. Unquoted `$PWD` in a hook is a real breakage on "My Documents". |

## Platform

| Situation | Do |
|---|---|
| **Windows** | Hooks are shell scripts. Git for Windows ships bash, so `#!/usr/bin/env bash` works from Git Bash and from most GUI clients — but it is not guaranteed in every environment. Verify with the drill; if it fails, say so rather than assuming it works. |
| Windows line endings | Write hook files with LF. A `pre-commit` with CRLF fails with a confusing `bad interpreter` error. |
| Hook file not executable | `chmod +x .githooks/pre-commit`. On Windows, git tracks the executable bit — set it with `git update-index --chmod=+x`. |
| macOS case-insensitive filesystem | `.env` and `.ENV` are the same file to the OS but different to `.gitignore` patterns. Use the case-insensitive ignore lines from `templates.md`. |
| Python not on PATH as `python` | Use `python3` on macOS/Linux, `py -3` on Windows. Never assume `python` exists. |

## User interaction

| Situation | Do |
|---|---|
| User answers something unexpected | Re-ask once, plainly. Never silently substitute your own choice. |
| User asks for microservices on a greenfield project | Have the conversation in `patterns.md` § rung 7 first. If they still choose it, proceed and record why in `STRUCTURE.md`. |
| User wants to skip security | Install layer 1 and 2 anyway and tell them what is off. Do not ship a project with no secret protection because it was inconvenient. |
| User aborts mid-setup | Report exactly what exists on disk and what is half-done. Leave nothing implied. |
| User says "just do it, don't ask" | Use every recommended default, show the summary as a **record** rather than a gate, and still ask before committing. |
| Approval to commit given | That is **not** approval to push. Ask separately. |
