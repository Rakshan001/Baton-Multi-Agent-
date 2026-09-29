# Spec C: skill offers (from the hub to members)

- **Status:** draft for review
- **Date:** 2026-09-29
- **Parent:** [team v2 overview](2026-09-29-team-v2-overview-design.md), decision D3
- **Depends on:** [Spec A](2026-09-29-team-hub-core-design.md): the pinned hub key and device tokens
- **Builds on:** `src/skills/install.ts` (`importSkillFromSource`, `renderSkill`, `EXECUTABLE_EXT` :828, `skillTargetFor`), `src/skills/quarantine.ts`, `src/skills/scan.ts`, `src/skills/digests.ts`, `src/skills/usage.ts`

> **Revision 2 (2026-09-29): follows [Team Sync v2](../../system-design/team-sync/README.md).
> These points override the text below.**
>
> - **Signer:** a bundle is valid only when its `skill.offer` event is signed by a
>   **Lead of the target project or a Custodian, as of the event's `deps`**, and sits
>   within any revoke cutoff. It is not checked against "the pinned hub key".
> - **Bundle reference:** the bundle is a content-addressed blob (`blobRef = sha256`),
>   and any peer may relay it.
> - **Accept binding:** an accept binds to `(skillId, version, blobRef)`. When two Leads
>   publish the same version concurrently, both show, labelled by signer, and the member
>   picks one.
> - **Validation:** `skillId` must match `^[a-z0-9-]{1,64}$`. `lstat` target directories
>   for existing symlinks, and reject case-folding collisions.
> - **Signing strings are domain-separated:** `"baton/v1/skill\0" + JCS(bundle)`.
> - **Default install target** is the project's worktree (`.claude/skills` under the
>   member's resolved repo, excluded via `.git/info/exclude`), not `~/.claude/skills`.
> - **Designer members:** accepting a skill needs a Lead co-approval
>   (`skill.decide` + `skill.cosign`).
> - **Accept runs through the IPC capability:** a native confirm dialog in Electron main
>   (Team Sync §12.2). An agent can't accept an offer over loopback.

## 1. Goal

The admin's skills (`/bug-fix`, a project-specific `/admin-ui` guide, and so on) reach
each member's own agent: Claude Code, Cursor, Antigravity or OpenCode. The admin can't
run code on a member's machine through them, and a non-coder member can make a safe
decision without reading the skill.

## 2. Threat recap

- A skill is instructions that an agent with the member's credentials will follow. A
  skill can also carry scripts.
- In Claude Code, three frontmatter features act on load, with no further prompt:
  - `allowed-tools`, which pre-approves tools
  - `` !`cmd` `` dynamic context, which runs shell when the skill loads
  - hooks
- A compromised hub, or a stolen owner token (owner is loopback-only per spec A), could
  push a poisoned update to every member at once.

## 3. Bundle format

```jsonc
{
  "v": 1,
  "hubId": "hub_…",
  "skillId": "bug-fix",
  "version": 7,                       // monotonically increasing per (hubId, skillId)
  "files": { "SKILL.md": "…", "references/checklist.md": "…" },
  "digest": "sha256:…",               // over canonical JSON of `files` (sorted keys, LF)
  "signedAt": "2026-09-29T10:00:00Z",
  "sig": "base64(ed25519(hubKey, digest ‖ hubId ‖ skillId ‖ version))"
}
```

### 3.1 Content rules

These are enforced when the admin creates an offer **and again on the member's machine**.
The member never trusts the hub's own check.

1. **Allowed files:** only `.md` files, at most 20, each at most 64 KB, and at most 256 KB
   in total. Anything matching `EXECUTABLE_EXT` or without the `.md` extension is
   rejected.
2. **Paths:** relative only. No `..`, no absolute paths, and nothing beyond 3 directories
   deep.
3. **Frontmatter allowlist:** `name`, `description`, `when_to_use`,
   `disable-model-invocation`, `context`, `agent`, `effort`.
   - **Rejected:** `allowed-tools`, `hooks`, `model` (a model switch breaks the member's
     cache and costs money), and any key not on the list.
4. **Dynamic context:** a body containing `` !` `` or a line starting with `!` inside a
   code fence of type `bash`/`sh` is rejected.
5. `scanSkill` findings are computed on the member's side and shown in the accept UI.

## 4. Flow

```
Admin: Skills screen → [Offer to team] bug-fix → pick members (or "all in project web")
  hub: validate §3.1, build bundle, sign, store under ~/.baton/team/<hubId>/offers/
  event skill.offer.created {skillId, version, members[]}
Member daemon: GET /api/team/offers?member=me → verify sig with the PINNED hub key
  (public key from the cert pinned at pairing), recheck §3.1, recompute digest
  → place into quarantine (quarantine.ts) with origin "hub:<hubId>"
Member UI (Inbox + Skills): "Rakshan offers bug-fix v7"
  shows: description · size · scan findings · DIFF vs installed version (if any)
  choose agents: [x] Claude Code  [x] Antigravity  [ ] Cursor
  [Accept] → release from quarantine (hash-bound, install.ts:557) → renderSkill per agent
  [Decline] → recorded; admin sees declined
  event skill.offer.accepted|declined {skillId, version, member}
```

## 5. Rules

- **Nothing auto-installs.** Updates from the same hub need Accept again. The UI makes
  this one click and shows the diff. An "auto-accept" option is **explicitly not built**.
- **Rollback:** the member keeps the last 3 accepted versions per skill. "Revert to v6" is
  local.
- **Where skills are installed:**
  - Claude Code: `.claude/skills/<id>/` inside **the member's worktree for the project**,
    or `~/.claude/skills` if the member picks "all my projects".
  - Cursor: a `.mdc` rule with `alwaysApply:false`.
  - Antigravity: `.agents/skills/`.
  - Anything Baton installs this way goes into `.git/info/exclude`, so a member doesn't
    commit the admin's skills into a client repo by accident.
- **Usage ledger:** accepted, declined and invoked counts go back to the hub
  (`skills/usage.ts` events). This tells the admin which skills the team actually uses.
- **Token hygiene** (links to spec E):
  - At offer time, the admin's UI warns when a skill is over 500 lines.
  - It suggests `disable-model-invocation: true` for slash-only skills and
    `context: fork` for heavy ones.
  - It never changes the skill silently.

## 6. The alternative to keep documented

Teams can still commit skills to the client repo under `.claude/skills/`. Git then
distributes them and PR review guards them. Offers exist for skills that shouldn't live
in the client repo (the admin's personal toolkit, cross-project skills), and for members
who shouldn't have to find out where skills go.

## 7. Tests

- Signatures: a bad signature is rejected. A good signature from an **unpinned** key is
  rejected. A replayed old version (version ≤ installed) is rejected.
- Content: each rule in §3.1 has a rejecting fixture: `allowed-tools`, `hooks`, `` !` ``,
  `.sh`, `../x.md`, an oversized file, too many files.
- Member-side recheck: rules still apply when the hub validation is bypassed, tested by
  building a bundle directly.
- Quarantine: nothing reaches an agent directory before Accept. Accepting releases exactly
  the hash that was shown.
- Diff: computed between the installed version and the offered one.
- `.git/info/exclude` gets updated.
- Rollback restores exact bytes.
