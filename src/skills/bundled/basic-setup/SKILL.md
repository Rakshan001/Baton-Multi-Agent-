---
name: basic-setup
description: >-
  Set up a NEW project correctly from the first commit, or audit and repair one that already
  drifted — folder structure, secret-leak protection, and the rules that keep both from rotting.
  Interviews the user in PLAIN LANGUAGE (never "App Router or Pages Router?") with a RECOMMENDED
  option marked on every question, so someone who has never coded can answer "1" every time and
  still land an industry-standard project an experienced developer can read. Chooses a real
  published structure — flat, layered MVC, feature-modular, Feature-Sliced Design, clean/hexagonal,
  modular monolith, microservices — from a ladder, always recommending the LOWEST rung that fits,
  and actively talks beginners OUT of microservices. Installs defence-in-depth against leaked
  secrets: .gitignore + .env.example, a committed gitleaks pre-commit hook (with a custom rule for
  database connection URLs, which gitleaks does NOT catch by default), GitHub push protection where
  it is free, and a CI backstop — then PROVES the hook works by planting a fake key and confirming
  the commit is blocked. Writes STRUCTURE.md for humans and AGENTS.md for every AI agent (Claude
  Code, Cursor, Codex, Copilot, Windsurf, Zed, Gemini CLI…) so agents stop scattering files.
  Supports Next.js, React+Vite, Nuxt, NestJS, Express, Django and FastAPI, and extends to any
  framework via a thin vocabulary map. NEVER overwrites existing files, NEVER commits or pushes
  without explicit permission. Use when the user says "basic setup", "/basic-setup", "start a new
  project", "scaffold", "set up a project", "project structure", "folder structure", "best practice
  setup", "add gitleaks", "stop me pushing secrets", "protect my API keys", "my repo is messy", or
  asks how a project SHOULD be organised.
---

# Basic Setup — a project an experienced developer can read

Two problems, one skill:

1. A beginner's project has no structure, so nobody else can work in it.
2. A beginner's project leaks secrets, because nothing stops them.

Both are fixed once, at the start — or diagnosed and repaired later.

```
DETECT MODE   empty dir → INITIAL     existing code → MID-PHASE (audit, never rewrite)
PREFLIGHT     git / runtime / package manager / gitleaks — block early with real fix commands
INTERVIEW     ~5 PLAIN-LANGUAGE questions, RECOMMENDED option always #1
DERIVE        answers → stack + structure pattern + security level → one summary
⛔ APPROVE ⛔  nothing is written before the user confirms the summary
SCAFFOLD      official CLI where one exists; documented layout where none does
SECURITY      .gitignore → .env.example → gitleaks hook → push protection → CI
STRUCTURE     folders + STRUCTURE.md (humans) + AGENTS.md (agents)
VERIFY        it builds, AND a planted fake secret is provably blocked
REPORT        what exists, what was skipped, what the user must do next
⛔ ASK BEFORE COMMIT ⛔   ⛔ ASK BEFORE PUSH ⛔  (separate questions, separate answers)
```

## Golden rules

0. **Never overwrite.** If a file exists and differs, show the diff and ask. Default is skip.
   In MID-PHASE mode nothing moves without approval — the deliverable may be *only a plan*.
1. **Every question carries a recommendation, and the recommendation is option 1.**
   A user who answers "1" to everything must end up with a correct, professional project.
   That is the design goal in one sentence.
2. **Never ask a question the user cannot answer.** Ask about the *project* ("will other people
   work on this?"), never about the *tech* ("App Router or Pages Router?"). Derive the tech.
3. **The security hook fails closed.** If gitleaks is missing, the hook **blocks the commit**.
   A hook that exits 0 when the scanner is absent protects nothing and lies about it.
4. **Recommend the lowest rung of the structure ladder that fits.** Complexity is a cost the
   user pays forever. Microservices requires an explicit, informed override.
5. **State what is NOT protected.** Local hooks are bypassable with `--no-verify`; push
   protection is free only on public repos. Say so plainly instead of implying total safety.
6. **Portable.** This skill runs under Claude Code, Cursor, Codex, and any other agent. Ask
   questions as plain numbered markdown. Never depend on a host-specific picker or tool.

---

## Phase 0 — Detect the mode

```
no files, or only .git/README/LICENSE   → INITIAL   (scaffold)
any source files present                → MID-PHASE (audit → ranked plan → approved fixes)
```

Announce which mode you are in and why. If MID-PHASE, read `references/audit.md` and follow it —
the phases below still apply, but every change is proposed, ranked, and separately approved.

**In MID-PHASE, run the history leak scan FIRST** (`references/security.md` § Already leaked).
A secret already in git history is urgent in a way that folder layout never is, and installing a
hook does nothing about it.

## Phase 1 — Preflight

Check before promising anything; a beginner cannot debug "command not found".
Full table with minimum versions and install commands: `references/stacks.md` § Preflight.

Report every missing tool at once with the exact command to fix it. Do not proceed on a missing
runtime. **gitleaks missing is not a blocker for scaffolding** — but it *is* a blocker for
claiming the project is protected, and the hook will refuse commits until it is installed.

## Phase 2 — Interview

Run the script in `references/interview.md`. Ask **one question per message**, in plain language,
formatted like this — recommendation first, marked, with the reason:

```
Will other people work on this project?

  1. Just me for now          ← RECOMMENDED: simplest layout, easy to grow later
  2. A small team (2-5)          adds feature folders so you don't collide
  3. A larger team               stricter boundaries between areas

Reply with a number.
```

Never present more than 4 options. Never use jargon in an option label without a plain-language
gloss next to it.

## Phase 3 — Derive and confirm

Map the answers to concrete choices using the tables in `references/interview.md` (stack),
`references/patterns.md` (structure), and `references/security.md` (security level). Then show
**one** summary, every line explained, and stop:

```
Here's what I'll set up — change any line, or say "go".

  Framework      Next.js 16 (App Router)   you picked a web app with pages
  Language       TypeScript                catches typos before they run
  Structure      feature-modular           auth + billing are separate areas
  Styling        Tailwind v4               current default
  Secrets        gitleaks hook + CI        you're storing customer data
  Docs           STRUCTURE.md + AGENTS.md  so this stays clean

⛔ Nothing is written until you reply.
```

## Phase 4 — Scaffold

Use the exact verified command for the stack from `references/stacks.md`.

**Two rules that matter more than they look:**

- **Pass every flag explicitly.** Do not use `create-next-app --yes` — it means "use previous
  preferences", which are stored per-machine, so the same command produces different projects on
  different laptops. Determinism is the entire point of a setup skill.
- **Two of the seven stacks have no usable scaffolder** (FastAPI has none; `express-generator`
  emits dated server-rendered patterns). For those, create the documented layout by hand from
  `references/stacks.md`, which cites the source it came from.

## Phase 5 — Security

Follow `references/security.md` in order. It is four layers, and each one has a hole the next
one covers:

| Layer | Stops | Defeated by |
|---|---|---|
| `.gitignore` + `.env.example` | `git add .` catching your `.env` | `git add -f` |
| gitleaks pre-commit hook | the secret entering git history at all | `--no-verify` |
| GitHub push protection | the push reaching GitHub | paid on private repos |
| CI scan on PR | it reaching the main branch | branch protection off |

The hook is the layer that matters most: a secret caught at *push* is already in local history,
so the fix is a history rewrite. Caught at *commit*, it is just an edit.

**Never set `core.hooksPath` blindly.** If the repo already uses husky or the pre-commit
framework, doing so silently disables every hook it already had — a security skill causing a
security regression. Detection table: `references/security.md` § Mechanism.

## Phase 6 — Structure and the rules that keep it

Create the folders for the chosen pattern (`references/patterns.md`), then write both files from
`references/templates.md`:

- **`STRUCTURE.md`** — for humans. "A new page goes here. A new API route goes here. Never put X in Y."
- **`AGENTS.md`** — for agents. Same rules, in the file 60k+ projects and every major coding agent
  already read (Claude Code, Cursor, Codex, Copilot, Windsurf, Zed, Gemini CLI, Aider, Junie…).
  `CLAUDE.md` and `.cursor/rules/` become two-line pointers to it, so there is one source of truth.

If the scaffolder already created `AGENTS.md` (Next.js does, by default), **append a section** —
never replace the file.

This phase is what stops the drift. The beginner gets a map; every agent that opens the repo
afterwards gets the rules, so it stops scattering files.

## Phase 7 — Verify

Run `references/verification.md` and **show the output**. Claims without evidence are failures.

The non-negotiable one is the **planted-secret drill**: write a throwaway fake key, attempt a
commit, confirm it is **rejected**, delete the file. "gitleaks is installed" can be true while the
hook never fires — that is the exact failure that leaks a key, and only the drill catches it.

## Phase 8 — Report

State plainly: what was created, what was skipped and why, what is **not** protected, and the
next three things the user should do. Then ask about committing — and only after an answer, ask
separately about pushing.

---

## References

| File | Read it for |
|---|---|
| `references/interview.md` | the question script + answer→choice derivation tables |
| `references/patterns.md` | the structure ladder: 7 patterns, when to use, when not to, trees |
| `references/security.md` | the 4 layers, verified gitleaks commands, mechanism detection |
| `references/stacks.md` | preflight versions + verified scaffold commands + vocabulary map |
| `references/audit.md` | MID-PHASE mode: scan → diagnose → score → ranked plan |
| `references/verification.md` | the proof checklist and the planted-secret drill |
| `references/templates.md` | copyable files: hook, .gitleaks.toml, CI, STRUCTURE.md, AGENTS.md |
| `references/edge-cases.md` | **read before acting** — empty repos, existing hooks, non-GitHub remotes, monorepos, Windows |

Load only what the current phase needs — except `edge-cases.md`, which is checked in Phase 0 and
again before anything is written.

## Things that will bite you

The five that most often turn a "successful" setup into a broken or unprotected one:

1. **`core.hooksPath` disables `.git/hooks` entirely.** If husky, the pre-commit framework, or a
   custom hook is already there, setting it silently kills their hooks. Detect first.
2. **Push protection is GitHub-only, and paid on private repos.** Never write a
   `.github/workflows/` file into a GitLab or Bitbucket repo.
3. **Scaffolders run `git init`.** Inside an existing repo that creates a nested repository.
   Pass `--disable-git` / `--skip-git`.
4. **A repo with no commits breaks the history scan.** `gitleaks git` needs a HEAD. Skip it, say
   so, and run it after the first commit.
5. **Never `git stash` or switch branches in a shared checkout.** It wipes another session's
   uncommitted work.
