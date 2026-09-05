---
plan: skill-guard
goal: Stop a downloaded skill from becoming the agent's instructions before a human has read it
requireReview: true
---

## Context for every task in this plan

**The hole, stated exactly.** `src/handoff/untrusted.ts` fences text Baton did
not write, and it is applied to plan task text (`src/spawn.ts:152`,
`src/handoff/brief.ts:274`) and to handoff bodies (`src/handoff/next.ts:102`,
`src/handoff/resolve.ts:88`). **Imported skills receive none of it.**

That is not an oversight to fix by adding a fence. A handoff brief is *data
about* work; a skill **is instructions**, deliberately — `installSkill` writes it
to `.claude/skills/<id>/SKILL.md`, where the agent's own harness loads it as
directive text. Quoting it as untrusted would break the feature. The defence has
to be a **review gate**, not a quoting rule.

**What guards exist today, and what they cover.** `src/skills/github.ts` enforces
`MAX_IMPORT_BYTES`, a binary-extension skip, `MAX_SKILL_FILES` and a total byte
budget (lines 219-224). Every one of those is about **size and type**. Nothing
anywhere inspects **content**. `src/skills/origins.ts` records where a skill came
from and a hash of what landed, and `updateSkill` refuses to overwrite local
edits — so provenance exists, and review does not.

**The path an attacker takes today:** paste a GitHub URL → `importSkillFromSource`
(`src/skills/install.ts:808`) → written to the library → `installSkill` → the
agent reads it as its own instructions on the next session. No prompt, no diff,
no scan.

**Prior art:** `hermes-agent` (MIT, Nous Research) `tools/skills_guard.py` —
quarantine directory, trusted-repo list, scan result, audit log. Take the shape,
not the code; attribute in `NOTICE` per this repo's convention.

**What this plan does NOT claim.** A regex scanner cannot decide whether text is
malicious, and this plan must not pretend otherwise. Its job is to put the
dangerous-looking lines **in front of a human** with the content they appear in.
A skill that passes the scan is *unreviewed*, never *safe*, and every string the
UI and docs use must say so.

**Non-goals:** no LLM in the scan path (cost, latency, and a scanner that can
itself be prompt-injected); no network calls during scanning; no automatic
deletion of anything a user imported.

## Phase 1 — See it, hold it, then wire it

### skill-scan
**scope:** `src/skills/scan.ts`, `test/skill-scan.test.ts`
**expects:** a pure function takes a skill's files and returns findings with category, severity, file, line number and the matching excerpt; it detects at minimum permission-bypass flags, instructions to ignore prior scope or instructions, credential and environment-variable exfiltration, network POSTs of local file contents, and invisible/formatting Unicode; findings are ordered deterministically so two runs on the same input are byte-identical; a file of 1 MB of adversarial input completes in under 200 ms with no catastrophic backtracking; a pattern inside a fenced code block is still reported but marked as fenced; matching survives case changes, inserted whitespace and zero-width characters between words; a skill that merely DOCUMENTS these patterns produces findings a caller can tell apart from ones that instruct; empty input returns no findings and does not throw; no filesystem, network, clock or randomness; `npx vitest run` passes
**principles:** every regex must be linear-time on its input — a scanner that hangs on hostile input is a denial of service placed exactly where hostile input arrives; report, never judge: the return value is evidence for a human, so a finding carries the line and the text and never a verdict like "malicious"; reuse the Unicode category matching already in `src/handoff/untrusted.ts` rather than writing a second list of tricks somebody thought of
**skills:** test-driven-development, security-review
**model:** sonnet

Write the adversarial tests first and make them the specification: this file's
whole value is what it catches, and a scanner whose tests were written after its
regexes only proves the regexes match themselves.

The evasion cases matter more than the happy path. `ignore  your  scope`,
`IGNORE YOUR SCOPE`, and `ignore<zero-width>your scope` are the same instruction
to the model that reads it.

### skill-quarantine
**scope:** `src/skills/quarantine.ts`, `test/skill-quarantine.test.ts`
**expects:** an imported skill is held in a quarantine state until explicitly released, keyed by the content hash `src/skills/origins.ts` already computes; a quarantined skill is never returned to any install path, including `installSkillEverywhere`; releasing records who released it, when, and the hash released; if the content changes after release, the skill returns to quarantine rather than inheriting the old approval; bundled skills are never quarantined, because they ship inside the package the user already installed; the state survives a daemon restart; a corrupt or missing state file reads as "everything is quarantined", never as "everything is approved"; a skill id is never joined into a filesystem path and a hostile id cannot escape the state directory; `npx vitest run` passes
**principles:** FAIL CLOSED — an unreadable state file must hold skills back, not let them through, which is the opposite of how `bookmarks.ts` and `origins.ts` degrade and the difference is that this one is a security boundary; approval is bound to a HASH, not a name, or an approved name becomes a slot an attacker can refill; do not delete or move the user's files
**skills:** test-driven-development, security-review
**model:** sonnet

Follow `src/skills/origins.ts` for the atomic write and the cap; diverge on
failure behaviour, and say so in the file's header comment. Every other sidecar
in this repo degrades to "no opinion" on a read failure. This one cannot.

### skill-guard-wire
**after:** skill-scan, skill-quarantine
**scope:** `src/skills/install.ts`, `test/skill-guard-install.test.ts`
**expects:** importing a skill scans it and places it in quarantine with its findings attached, and reports both to the caller; installing a quarantined skill is refused with a message naming the release step; already-imported skills keep working and are treated as released, so an upgrade does not silently disable a user's existing library; `baton skills` output states clearly that a scanned skill is unreviewed rather than safe; a scan failure quarantines rather than passing the skill through; importing the same content twice does not produce two quarantine entries; installed bytes are unchanged for any released skill; `npx vitest run` passes with no test deleted
**principles:** a scanner error must fail toward quarantine — the whole point is that the uninspected case is the dangerous one; existing users' skills must not break on upgrade, so absence of a quarantine record for an already-present skill means released, not blocked
**skills:** bug-fix, code-review
**model:** sonnet

Join the two new pieces to the path an import actually takes. This is the task
that changes behaviour a user notices, so it is deliberately the smallest one:
scan on import, hold the result, refuse to install what is held.

The upgrade case is the one to get right. Someone with twenty imported skills
must not open Baton to find all twenty blocked.

### skill-guard-api
**after:** skill-guard-wire
**scope:** `src/server.ts`, `test/skill-guard-api.test.ts`
**expects:** an endpoint lists quarantined skills with their findings and full content; a write-gated endpoint releases one by id AND expected hash, refusing when the hash does not match what is on disk; release is refused in read-only mode and without a loopback Origin, like every other mutating endpoint; the listing never executes or renders skill content, only transports it; a request for an unknown id returns 404 rather than an empty approval; `npx vitest run` passes
**principles:** raw `node:http` only — the daemon stays zero-dependency; the release call carries the hash the caller believes it is approving, so a skill that changes between review and click cannot be approved by a stale click; no GET may release anything
**skills:** security-review, lean-code
**model:** sonnet

Two endpoints: what is held, and release this exact content.

Carrying the hash on the release call is what makes the review meaningful. A
button that says "approve skill X" approves a name; a button that says "approve
this content" approves what the reviewer actually read.

### skill-guard-ui
**after:** skill-guard-api
**scope:** `web/src/features/Skills.tsx`, `web/src/lib/api.ts`, `web/src/types.ts`
**expects:** a quarantined skill is visibly held and cannot be installed from the UI; its findings are listed with line numbers and the full skill content is readable in the same view without leaving the page; skill content renders as plain text, never as markdown or HTML; the release control states that the user is taking responsibility, and is disabled in read-only mode; a skill with no findings still requires release and the UI says it was scanned, not that it is safe; demo mode shows the flow with a fixture and calls no daemon; `npx tsc --noEmit` and `npm run build --prefix web` pass
**principles:** a person cannot approve what they have not been shown, so the full content must be on the same screen as the button; never render untrusted skill content as markup — the review screen is the one place hostile content is displayed on purpose; wording must never say "safe" or "clean"
**skills:** security-review, lean-code
**model:** sonnet

The review screen. Its job is to make reading the skill the easy path and
installing it unread the deliberate one.

Findings are a reading aid, not a verdict — put them beside the content, not in
place of it.

### skill-guard-docs
**after:** skill-guard-api
**scope:** `docs/security.md`
**expects:** documents the threat (a downloaded skill becomes the agent's instructions), why fencing does not apply to skills, what the scanner does and explicitly does not catch, the quarantine and release flow, and the fail-closed behaviour; states that a scanned skill is unreviewed rather than safe; records the hermes-agent attribution
**principles:** state the limits at least as prominently as the protections — a security page that oversells is worse than none, because it buys trust the code cannot honour
**skills:** lean-code
**model:** sonnet

Write the page someone reads after importing a skill they are unsure about, and
the page a security reviewer reads to find out what Baton does not do.
