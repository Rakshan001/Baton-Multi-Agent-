# Installing the portable `bug-fix` skill

This is a self-contained, stack-agnostic Claude Code skill. Drop the `bug-fix/` folder into any
project (or your home config) and it's ready to use.

## Folder layout

```
bug-fix/
├── SKILL.md                              # the workflow Claude follows (has the YAML frontmatter)
├── HOW-IT-WORKS.md                       # human-readable explainer (not loaded by Claude)
├── INSTALL.md                            # this file
└── references/
    ├── blast-radius-checklist.md         # how to map dependents before editing
    ├── report-template.md                # optional bugfix report format
    └── status-template.json              # optional multi-session registry schema
```

Only `SKILL.md` is required. The `references/` files are loaded on demand by the workflow; the
others are documentation.

## Option A — Per-project (recommended)

Copy into the target project so it's versioned with that repo and shared with the team:

```bash
cp -R bug-fix /path/to/your-project/.claude/skills/bug-fix
```

## Option B — Global (available in every project on your machine)

```bash
cp -R bug-fix ~/.claude/skills/bug-fix
```

> If you install globally AND a project also has its own `bug-fix`, the project-level one wins
> for that project. Don't keep two with different behavior unless you mean to.

## Using it

In Claude Code, trigger with any of: `/bug-fix`, "use the bug fix skill", "fix this bug",
a reported bug, a failing test, or unexpected behavior.

## Tuning for a specific project (optional)

The skill is generic by design. If you want it tighter for one repo, edit that copy's `SKILL.md`:

- **Wire in your tooling** — replace the generic "the test command / build command / the graph /
  the app" with your project's actual commands (e.g. `npm test`, `pytest`, `ng build`, your
  graph-refresh script).
- **Drop unused phases** — no shared registry? Delete Phase 0. No dependency graph? Delete the
  graph parts of Phase 2 (the grep sweep in Agent D already covers blast radius).
- **Commit conventions** — set the author/trailer rules your repo expects in Phase 12.
- **Risky areas** — list your project's real danger zones in Phase 4 (auth, payments, etc.).

The safety core (reproduce-first, ≥95% skeptic-corroborated confidence, plan approval, regression
re-verify, commit-but-never-push) should stay intact — that's what makes it safe.
