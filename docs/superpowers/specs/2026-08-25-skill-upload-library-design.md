# Skill upload + personal library — design

**Date:** 2026-08-25
**Status:** implemented — 2492 tests green, both builds clean
**Repos:** land in `baton`; `baton-release` (npm `batonhq`) pulls and publishes.

## Problem

The Skills screen can only import from a **path or an http(s) URL**. A path is
resolved on the *daemon's* machine, so from a browser there is effectively only
one working route: a URL. Three consequences:

1. A user with a `SKILL.md` on their desktop cannot add it.
2. Imported skills are stored per-repo at `<repo>/.baton/skills/<id>.md`, so a
   skill added in project A is invisible in project B, and `baton setup` on a
   new project offers only `source === 'bundled'` — the user's own skills are
   silently skipped.
3. Import is lossy: `install.ts` rebuilds frontmatter down to `name` +
   `description`, discarding `tags`, `produces`, and every `references/` file.

There is also no way to get a skill back out (no export), and no way to delete
one from the catalog — `baton skills remove` only unwires it from agents while
the file lives forever.

## Decisions

| Question | Decision |
|---|---|
| Where do uploads live? | **Global**: `~/.baton/skills/<id>.md`, shared by every project on the machine. |
| Shortcut (`/my-skill`) | Prefilled from frontmatter `name` / filename, **editable**, validated live. |
| Export scope | **Only the user's own skills.** Bundled are refused — they ship in the package. |
| Export shape | Per-skill `.md` download **and** an all-in-one `.json` bundle. |
| Legacy per-repo skills | Keep **reading** them; nothing new writes there. No migration. |

## Storage

```
dist/skills/bundled/<id>/SKILL.md   bundled   ships in the npm package, read-only
~/.baton/skills/<id>.md             global    the user's library — every project   ← new
<repo>/.baton/skills/<id>.md        imported  legacy per-repo, still read
```

Flat `<id>.md` in both writable dirs, so **one reader serves both**. Precedence
is bundled → global → project; a bundled id can never be shadowed.

Two internal sources map to one UI group:

- **Baton skills** — `bundled`
- **Your skills** — `global` + `imported` (the latter chipped *this project only*)

## Lossless storage

The uploaded bytes are stored **verbatim**, with only the frontmatter `name:`
line normalised to the chosen shortcut. That single rule buys three things:

- `SkillDef.raw` is always safe to set, so Claude/Antigravity installs are
  byte-for-byte (`installSkill` already honours `raw`).
- Export is a file read — no lossy re-render round-trip.
- `tags` / `produces` / any other frontmatter survives.

`withSkillName(text, id)` handles all three input shapes: no frontmatter,
frontmatter without `name`, frontmatter with `name`.

## API

| Route | Notes |
|---|---|
| `POST /api/skills/upload` | `{ filename, content, id?, replace? }` as JSON. Write-gated. |
| `POST /api/skills/import` | unchanged; gains optional `id` / `replace`. |
| `DELETE /api/skills/:id` | refuses `bundled` (403). Write-gated. |
| `GET /api/skills/:id/file` | raw `.md` download. **Refuses `bundled` (403).** |
| `GET /api/skills/export` | `.json` bundle of the user's skills only. |
| `POST /api/skills/import-bundle` | restores a bundle. Write-gated. |

No multipart parser: the browser does `FileReader.readAsText()` and posts JSON.
`readBody` caps at 1 MB and `MAX_IMPORT_BYTES` is 256 KB, so this fits without a
new dependency — the daemon stays zero-dependency per CLAUDE.md.

## Edge cases

| Case | Behaviour |
|---|---|
| Shortcut collides with a bundled id | Refused. *"'bug-fix' is a Baton built-in — pick another name."* |
| Shortcut collides with an existing user skill | 409 unless `replace: true`; UI shows an explicit **Replace** button. |
| Empty / whitespace-only file | Refused: *"that file is empty."* |
| Over 256 KB | Refused with the size named. |
| Not markdown (`.txt`, `.mdc` ok; `.pdf`, binary) | Refused by extension **and** by a NUL-byte scan. |
| No frontmatter at all | Accepted — `name` is synthesised from the shortcut, description from the first heading. |
| Frontmatter `name` disagrees with chosen shortcut | Shortcut wins; the `name:` line is rewritten, nothing else touched. |
| Shortcut that slugifies to empty (`"!!!"`) | Refused before any write. |
| Path traversal in `id` (`../../etc/passwd`) | `slugifySkillId` strips it; server re-validates and refuses a mismatch. |
| `~/.baton/skills` unwritable | Import fails with the real reason; nothing half-written. |
| Bundle import: id already taken | Skipped and reported, never silently overwritten. |
| Bundle import: malformed JSON / wrong version | Refused whole; no partial application. |
| Delete a skill still installed in agents | Removed from the catalog **and** unwired from every agent. |
| Two daemons uploading the same id at once | Last write wins (single-user machine). Named as a known ceiling. |

## Setup integration

`offerSkills` drops its `source === 'bundled'` filter and offers both groups,
labelled. This is what makes `npx batonhq setup` on a new project restore the
user's library rather than only Baton's 11 built-ins.

## UI

Two bands — **Your skills** first (upload, download, delete), then **Baton
skills** (install only). Search spans both. An "Add skills" area carries the
upload button, the URL box, and a link to <https://www.skills.sh/> as a source
of community skills, swappable for a first-party site later.

`demoSkills.ts` gains user-owned entries — it currently has zero non-bundled
skills, so demo mode cannot render the split, and CLAUDE.md makes demo mode
non-negotiable.

## Out of scope

- Multi-file uploads with `references/` — v1 is single `.md`, but it **warns**
  rather than silently dropping.
- "Move this project skill into my library" button.
- Syncing to a remote skills site (the skills.sh-alike) — link only for now.

## Testing

Unit: `withSkillName` across all three frontmatter shapes; shortcut validation
and collision rules; export/import bundle round-trip; the bundled-export
refusal. Integration: upload → catalog → install → export → delete.
