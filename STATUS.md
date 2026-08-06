# Baton — Project Status

> Snapshot of what is BUILT, what is PENDING, and where things live.
> Update this file at the end of every working session.
> Last updated: **2026-07-31 (session 17: the collaboration plane — Phases 1–8 of `docs/plans-local/2026-07-30-team-online-mode-plan.md`)**. Baton can now be reached by more than one person: author identity on every write, a workspace manifest + `baton join`, a portable work bundle, a member registry with hashed tokens behind `baton serve --host` (`src/access.ts` is the whole authorization boundary, as one pure function), cross-machine presence + advisory file claims (`src/federation.ts`), the Team screen with owner controls, `check_files` federated to the host, an invite + Share panel, **the dashboard itself over `--host`** (SSE over `fetch()` because EventSource cannot send an Authorization header — no credential ever goes in a URL), and **Phase 8 teams**: `src/teams.ts` + `.baton/teams.json`, `baton team add|list|rm|assign|scope`, owner-only CRUD over HTTP, roster grouping and a who's-editing filter. A team's project scope is a VIEW FILTER and every surface says so — it reaches no authorization decision, and the filter shows a same-branch conflict under every team because a filter that could hide a collision would cost data rather than noise. Edge-case matrix E1–E40; suite **1051 pass** across 107 files; both workspaces build. Then closed the plan's own debt: the **SSE reconnect loop is now tested** (`test/sse-reconnect.test.ts`, 17 — resume by `Last-Event-ID`, the backoff ladder and its reset, jitter bounds, 401/403 terminal with no retry, `close()` permanent; mutation-checked by breaking `sse.ts` three ways and confirming exactly the right 5 tests failed), and **bottleneck #3 is measured** on this machine — 190 MB per graphify project backend (not the 120–180 MB estimated, and **43 % of it is the `uv run` supervisor**, an easy ~82 MB/project win), 107 MB for the daemon, 502–565 MB per live Claude Code session. The 16 GB capacity headline is deliberately not recomputed: every figure is a process at rest. Then **rehearsed phase 0** — no sshd on this box and enabling Remote Login is not mine to do, so `ssh -L` was stood in for by a local TCP forwarder (the daemon still reports `viewer.local: true` through it, which is the property the phase rests on). All four verify steps passed, including a real `claude` tmux session streaming; dropping the forward left the daemon, the tmux session and the agent alive, and the dashboard recovered with no reload. It also surfaced **three real bugs, all fixed**: (1) a link dying AFTER first load left the board rendering stale counters as if live, with only a 12 px dot dissenting — now a full-width staleness banner that names the data's age; (2) pollers had no backoff, firing 21 requests at a dead `/api/status` per 40 s outage and actually speeding UP on disconnect because the live-SSE interval stretch had lapsed — now capped exponential backoff, 21→4; (3) that fix then delayed recovery by up to 30 s, so the SSE `onOpen` now wakes every poller — recovery after a 35 s outage measured under 6 s. Then an adversarial pass over the team plane's WRITE paths found four more, all fixed with regression tests (`test/registry-races.test.ts`, 9): (E44) every members.json/teams.json mutation was an unserialized load→mutate→save, and the interleaving that matters is `markTokenUsed` — fired by the member's own next request, exactly when an owner acts on them — saving a stale copy over a revoke, **putting a revoked token back to work**; all mutators now run inside a per-file in-process lock (`src/util/lock.ts`, zero-dep promise chain; mutation-tested — removing the serialization fails 5 tests); (E45) the auth cache was keyed on mtime alone, so two saves in one millisecond served the first forever — now keyed on mtime+inode, which always moves because every save is a tmp-file rename; (E46) `projects: "web,api"` (string, not array) was coerced to `[]` = whole-hub scope, a typo silently WIDENING what a team sees under a 200 — now a 400 at both endpoints; (E47) the registry caps counted rows scanned rather than entries kept, so junk rows consumed slots real credentials needed. Edge-case matrix E1–E47; suite **1069 pass** across 109 files. Then the **daemon-fleet plan** (`docs/plans-local/2026-07-31-daemon-fleet-plan.md`), all four phases: (1) `src/daemons.ts` — every `baton serve` writes one record file to `~/.baton/daemons/<pid>-<port>.json` (one file per daemon: nothing shared to race on), removed on clean shutdown; **a record is a CLAIM** — nothing is shown live or ever signalled until the pid is alive AND the port answers `/api/meta` with the same root, so pid/port reuse both read as stale, and stale is only ever cleaned, never stopped; `baton ps` + `baton daemon stop <port|path>` (graceful → SIGTERM fallback, says which ran; `baton stop` remains the agent-stop); EADDRINUSE now names the holder and the command to free it. (2) HTTP: `GET /api/daemons` (self-marked), `POST /api/shutdown` (answers 200 *then* exits), `POST /api/daemons/:port/stop` — all three loopback-only, stricter than owner: a `--host` member can neither see nor stop anything on the machine. (3) A **Daemons card in Settings** — self first ("this dashboard"), live by port, stale last; confirm dialogs carry the full path + port; a stale row gets *Clean up*, never Stop; demo fixtures include the stale path; verified in the browser including the demo stop round-trip. (4) **OpenClaw** built-in (detection-only, the antigravity precedent) + **`~/.baton/agents.json`** — custom agents merged before `KNOWN_AGENT_IDS` derives so spawn/terminals/detection/routing see them as first-class; argv templates only (`{prompt}` with the leading-dash guard, `--model={model}` vanishes whole), built-ins unredefinable, malformed entries skip with reasons into `baton doctor`; per-project agents.json deferred with the reason recorded in the plan. Suite **1104 across 113 files**; both workspaces build; demo untouched. Then (2026-08-01) a **second bug-hunt over the fleet** — three independent reviews, ten verified defects fixed: `/api/meta` now names its pid and `verifyDaemon` requires the answering process to BE the record's pid (closes the recycled-pid SIGTERM hole; a forged record naming another daemon's pid now unmasks as stale and is swept as a file); `baton daemon stop <target> [pid]` narrows to one record so cleaning a corpse can't stop the live daemon sharing its port (realpath'd targets, per-row `ps` hints); stop requests carry `expect:'stale'|'live'` and a Clean-up that turns out live gets a 409, never a surprise stop; refused-stale buries dead-pid records but keeps live-pid ones; per-project `.baton/agents.json` reaches roster/routing/MCP identity and hub summaries union sub-project registries; managed gitignore writes `.baton/*` + `!.baton/agents.json`; web: honest refused-stale toast + un-jammed stopping rows, open `AgentId` union with openclaw glyph so non-registry agents render everywhere. Then **fleet self-healing**: `sweepDeadDaemonRecords` (pid-death only, no probes — safe unattended) runs at every daemon startup, as `baton daemon clean`, and as `POST /api/daemons/clean` behind a *Clean up all* control in the Daemons card; `baton ps` gained a MODE column (rw/ro, +host) and the CLI reference gained the fleet section. Suite **1123 across 113 files**. Then a **security + correctness pass over that same surface**, which found the round's worst bug — one I had shipped myself: the per-project `.baton/agents.json` reused the `~/.baton` validator, which allows a `binary` to be a PATH. That file is committed and arrives with a clone or a PR branch, while the roster probes every known binary with `<bin> --version` on the daemon's poll path — so a repo shipping `.baton/agents.json` naming `./scripts/x` plus that executable got **zero-click code execution** on anyone who ran `baton serve` in it. Project entries now validate against `PROJECT_BIN_RE` (an installed command name, never a path; launcher `cmd` too, and a bad one is reported rather than silently swapped for the binary), while `~/.baton` keeps its paths — the split IS the trust boundary. Project-defined agents also carry `fromProject` through the roster to a "from this repo" tag on the Agents card, so repo-supplied config can never pass for a built-in in a list you launch from. Three correctness fixes alongside it: the Handoff dialog validated routing suggestions against an `options` captured at mount (before `meta.agents` arrived), so a custom-agent suggestion was never preselected — the exact case the list was added for; EADDRINUSE named only the FIRST record on the port, so a corpse sorting ahead of the live daemon printed "unknown holder"; and the sweep over-counted under concurrent sweeps because **two concurrent `unlink`s of one path both resolve successfully here** — it now claims each corpse with an atomic `rename` (exactly one winner, verified empirically) and reclaims claim files abandoned by a dead sweeper. Demo gained a second stale daemon so the bulk-clean path is reachable in the showcase. Then closed the two gaps that pass had recorded but not fixed: `/api/meta` now reports **`agents.known`** — every id the root knows, launchable or not — because a handoff is a BRIEF, not a spawn, and the Handoff picker built from `headless ∪ interactive` silently dropped detection-only custom agents while the built-in ones (antigravity, openclaw) stayed visible only by virtue of the web registry hardcoding them; and `detectionRoots()` now widens agent detection to **each task's own `repoRoot`**, so in a hub a sub-project's custom agent is recognised in its own worktree instead of drawing the row idle while an agent plainly works in it (served root first, so a hub definition still wins; a single repo's key is byte-identical to the old scalar form — no cache split). Fixing those surfaced a hole in the round's own security mitigation: the Agents card tagged repo-defined agents, but the **Launch dialog** — the surface that actually starts one — offered them indistinguishable from built-ins, so `meta.agents.fromProject` now carries provenance with the list and the dialog spells it out for the agent you picked. Suite **1132 across 113 files**. That widening then pointed at **two older bugs of the same shape, both silent, both hub-only**: `collectStatus` asked the SERVED root for each task's ahead/behind, and `changedFiles` asked it for the committed half of a task's diff — but in a hub the branch lives in the sub-project and the served root may not be a git repo at all. `aheadBehind` swallows every error as `{0,0}` and a failed diff is skipped, so the board drew every hub task as having nothing to merge, and **overlap detection went blind to committed work** — two agents editing one file stopped conflicting the moment either committed, which is the coordination guarantee Baton exists to provide. Both now ask `task.repoRoot ?? root`, proven by two hub tests that failed first (`expected +0 to be 1`, `expected [] to include 'shared.txt'`). Suite **1134 across 113 files**. Then the **review staleness signal**, which turned out to be broken for everyone, not just hubs: `headCommit()` is `rev-parse --short` while the code-review skill instructs the agent to record `rev-parse HEAD` in full, so a strict `!==` between two spellings of ONE commit marked **every review stale the instant it was saved** — a warning permanently on is a warning nobody reads, and the existing test missed it only because its toy shas ('aaa'/'bbb') were the same length. `isReviewStale` now compares on the shorter length (git abbreviations are prefixes, so a prefix match IS commit identity). Underneath that sat a second defect: the comparison asked the SERVED root, a different checkout on a different branch — and in a hub often another repo or none — so a diverged task branch read stale forever while a commitless root read never-stale, silently disabling the guard. `reviewHeads()` now answers per review from the task's own worktree, falling back to the root only when the review outlived its task. Suite **1137 across 113 files**. Chasing that same "wrong root" shape one level up then found the **worst of the three**: every CLI command that touches `.baton` resolved its root with `gitRoot()`, which answers "the git checkout I am standing in" — the wrong question in both places agents actually stand. Inside a task worktree it returns the WORKTREE, whose `.baton` is an empty shadow store, so `baton take <slug>` reported *no task* in the very worktree that task owns and `baton pass --auto` silently no-op'd (it concluded it was not in a baton worktree, the hook's designed quiet path); at the root of a multi-repo hub — often not a git repo at all — it **threw outright**. Verified in five positions before touching anything: `gitRoot()` fails in three of them, `activeBatonRoot()` (the former `resolveMcpRoot`, renamed and re-documented as the general answer) is right in all five. 23 commands switched — take/done, pass, resume, ls, path, status, signals, review, memory, kb, member, host, team, usage, bugs, bundle, history, route, skills, doctor — leaving `gitRoot()` only where the git checkout genuinely IS the question (progress deriving a slug from a worktree path, orient reading that worktree's HANDOFF.md, hooks writing agent config). New `test/command-root.test.ts` (7) pins the resolver in every position rather than per-command, so a new command cannot quietly reintroduce it; confirmed end-to-end with the real CLI (`baton ls` from a hub root, `baton take` from inside a worktree). Suite **1144 across 114 files**. The one caller that round deliberately left behind then turned out to be the same bug wearing different clothes: `baton hooks install claude|cursor --project` — the command that wires Stop/PreCompact → `baton pass --auto`, PreToolUse → `baton guard` and SessionStart → `baton orient --auto` — placed those files with `gitRoot()`. Run at the root of a hub it **died outright** (`error: Not inside a git repository`, verified with the real CLI); run from inside a task worktree, which is exactly where an agent doing setup stands, it wrote `.baton/wt/<slug>/.claude/settings.json` — a throwaway checkout `baton merge` deletes — and printed `✓ installed` at a path that would not survive the task. It also disagreed with `baton skills install`, which writes `.claude/skills/` at the baton root: two commands filling the same `.claude/` directory with different ideas of where the project is. Both now go through one exported `hooksFile()` resolving `activeBatonRoot()`, so `--project` means *this workspace* everywhere, and the option help and docs say so. `test/hooks.test.ts` gained 4 tests pinning the destination (hub root, worktree, `BATON_ROOT`, and user-wide unaffected); re-verified end-to-end on a real hub — the install that used to die now writes `<hub>/.claude/settings.json`, and the one run from the worktree writes `<hub>/.cursor/hooks.json`. Suite **1148 across 114 files**. Then the **inverse** of the hub bug fixed two rounds earlier: that one hid a real collision, this one invents fake ones. Every path Baton compares is worktree-relative, and nothing qualified it by project — so in a hub `src/index.ts` in proj-a and `src/index.ts` in proj-b, two unrelated files that merely spell the same string, cross-warned as a conflict. Proven first (`expected [ 'src/index.ts' ] to deeply equal []`), then fixed at all four comparison sites through one shared rule (`canCollide` + `taskRepos` in `conflicts.ts`: only same-repo holders can collide, and an unknown repo — a root session, a watched checkout, neither of which belongs to a task — still pairs with anything, because suppressing on a guess is the mistake that loses data): `computeConflictsFromSets` (the board's conflictFiles and `baton merge`), `checkFiles` (the edit guard and the `check_files` MCP tool, both halves — live signals AND committed divergence), the `warning` level in `getSignals` that pushes `signal.overlap` to both agents, and the scope-clash warning at `baton new`. Every conventional filename — index.ts, README.md, package.json — was a standing cross-project false alarm, and a signal that cries wolf is one agents learn to scroll past. The same defect ran through the cross-machine half: the host keys claims by `(projectId, relPath)`, but `remote-claims.ts` threw the projectId away when it read them back, so a teammate's file in another sub-project was reported to an agent as a hold on theirs — `RemoteHolder` now carries `projectId` and `remoteHoldersFor` takes the asker's (from the new `projectOf`), threaded at both call sites (`/api/signals/check` and the MCP tool). Seven tests across `test/hub.test.ts` and `test/remote-claims.test.ts`, each mutation-checked by reverting the fix and confirming exactly the right ones fail. Suite **1155 across 114 files**; both workspaces build. Then the **edit guard from a hub root**, the last hiding place of the same shape: `runGuard` opened with `gitRoot(cwd)`, and a session at a hub root is not inside a git repo at all — so it threw, the guard's deliberate fail-open swallowed it, and **every edit made from a hub root recorded nothing**, leaving those sessions invisible to each other and to every task. That is precisely the blindness G2 (the guard writes signals, not just reads them) exists to remove, and the failure was indistinguishable from a healthy quiet guard. Proven with the real hook payload on stdin: a plain repo recorded `src/x.ts ← sess-abc12345 (claude)`, the hub root recorded nothing. `checkoutForEdit()` now falls back to the repo the FILE lives in — which is also the only answer that files the path relative to the same repo that repo's own tasks record against, so the two compare — and refuses anything outside the baton root, so an edit in an unrelated checkout elsewhere on disk can never file a foreign path in this store. Verified end-to-end both ways after the fix, and the roaming-session caveat is written down rather than papered over. Suite **1159 across 114 files**. **Anti-capture gate (`src/memory-durability.ts`)** — lifted from the audit of NousResearch/hermes-agent's background reviewer, which carries the same list as a prompt instruction. Baton already answers "is this fact still TRUE?" (anchors, re-checked on read); this answers the question before it — *should this ever have been saved?* Four classes never become facts: environment-dependent failures, standalone "X is broken" claims, errors that resolved on retry, and session narratives. Evidence and remedy each waive the first two — a claim tied to files that RESOLVE is one the staleness sweep can police, and a stated fix is the durable half — while nothing waives a narrative or a self-resolved flake. Two holes found in self-review and closed: a remedy word inside the symptom span used to waive it ("the key is not `set`" waived itself, silently disabling the whole environment class), and an anchor to a *nonexistent* path granted a waiver while hashing to `''` forever, i.e. exempting the fact from the verification the waiver rests on. Rejections are a distinct `UndurableFactError` so `create_handoff` — Baton's only autonomous memory writer — can quote the text back for a rewrite (`notMemorized`) without ever echoing a fact rejected for containing a credential. Deliberately NOT in `TOOL_HELP`: T1 leaves 4 chars of budget (2096/2100), and the rejection message teaches the rule at the one moment an agent can act on it. A three-axis review of the gate then found three more, each mutation-checked: (1) the remedy waiver tested bare `run`/`set`/`install`/`export` against the whole fact, so a standalone grudge waived itself on a NOUN that proposed nothing — "affects every user of the export path", "we set aside a day for it", "not installed on a fresh install of this repo" all saved as if they carried a fix; the hints are now split into unambiguous phrases (`instead`, `workaround`, `the fix`…) and ambiguous verbs that must take a plausible object, and URLs are stripped in the normalizer because linking TO a workaround is not stating one. (2) `cannot be used` was **removed** from the disparagement class: it reads like a grudge but is overwhelmingly a real constraint, and it false-rejected three conventions this repo actually holds (`.refs/` cannot be used from src; EventSource cannot be used with an Authorization header; a read-only daemon cannot be used to resolve findings) — all three are now in the MUST-BE-ACCEPTED corpus, which had sidestepped the rule by phrasing the EventSource fact differently. (3) Each class was keyed to one idiom rather than to the class, so `is unconfigured`, `is uninstalled`, `missing from PATH`, `is unreliable`, `fails every time`, `the second attempt succeeded`, `cleared on its own`, `during this task`, `today I reviewed` all passed the gate; the tables now cover the class. Standards axis also collapsed 44 per-rule waiver booleans into one per-KIND table (the two flags never varied within a kind, and the design is class-level) and corrected a comment that mis-stated the T1 slack as ~25 chars. Suite **1211 across 115 files**. Then the finding that explains why that store was EMPTY (2 facts, both from 12 June, while seven weeks of gotchas went into this file instead): **`baton pass --auto` wrote nothing for any session without a task** — which is how most sessions run. `passTask` returned null the moment `resolveTask` found no task, so Stop and PreCompact fired on every turn, exited 0, and produced nothing; the only autonomous handoff writer never ran once, and memory's only automatic feeder is a handoff. This is the fourth instance of the "root sessions are invisible" shape, after `gitRoot`→worktree, the guard at a hub root, and hub ahead/behind. Root sessions now get a **derived** brief (`src/handoff/auto-session.ts`) at `.baton/handoffs/<session>.md` — where `resume.ts` and `GET /api/handoffs` already read, so no consumer changed: done ← commits since the previous brief, pending ← the dirty tree, next ← the obvious continuation. Deliberately NOT derived: `decisions`, the one field no heuristic can produce (it is the "why") and the field that feeds memory — an auto brief carries none and writes no facts, says so in its note, and points at `create_handoff` for the real thing. Identity comes from the hook payload's session id (two agents in one root would otherwise clobber one brief), read from stdin only when stdin is NOT a TTY and behind a 300 ms race, because an unguarded `for await (…stdin)` would hang `baton pass --auto` typed by hand. The bug that testing caught: writing the brief dirties `.baton/`, so the brief reported ITSELF as pending work AND the state hash changed every run, so the dedupe never converged and the hook would rewrite forever — invisible in a repo whose .gitignore Baton manages, a self-feeding loop in a fresh one. Silent whenever there is nothing honest to say (clean tree + no commits, non-git hub root, state identical to the last brief); commit subjects are redacted through the shared `detectSecret`; `.baton/handoffs/` is pruned to 20. Four mutations, each failing exactly its own tests. Verified end-to-end with a real hook payload on stdin from this repo's root. Suite **1226 across 116 files**. A review of that round then found four more defects in it, each reproduced first and mutation-checked. The worst two are the ones a hook does silently: (1) **every session's first brief claimed commits it never saw** — with no marker there is no baseline, so the fallback `log -n10` handed each new session credit for the last ten commits in the repo, and that path runs once per SESSION, not once per repo; caught live, since the PreCompact hook had just written this session a brief whose Done list carried ten commits and whose title quoted yesterday's, from a session that committed nothing. The fallback is now a time floor — the marker's own timestamp (minus a second, because `--since` compares at second granularity and a lost commit is worse than a repeated one) or, on a first brief, a 12-hour window; still a guess, but a bounded one that errs toward saying nothing. (2) **automatic pruning could delete an agent-authored brief**: `.baton/handoffs/` holds both kinds and the cap deleted the oldest 20+ by mtime, so a hook could destroy a `create_handoff` brief carrying decisions that exist nowhere else — derived briefs now carry `derived: true` and only those are pruned, fail-closed (a brief that cannot be read or parsed counts as authored). (3) Markers in `.auto/` were never pruned at all — one file per session forever, while the briefs beside them stayed capped — and a marker outliving its brief made the state look unchanged, so the brief was never written again; one sweep fixes both, since a marker with no brief is meaningless. (4) `readSessionState` filtered `.baton/` but the brief's own "Uncommitted changes in the tree" section re-read the tree unfiltered, so it contradicted the Pending list above it and anchored memory facts to coordination state; the filter is now shared by both writers (`isBatonArtifact`, alongside the `porcelainPath` the two files had duplicated). Staging it then caught a fifth: `stateHash` joined its fields on a **raw NUL byte** typed into the source rather than a `'\0'` escape, so git classified `auto-session.ts` as binary (`Bin 0 -> 15182 bytes`) — a source file with no diffs and no merges, for a separator whose bytes are identical either way. Suite **1230 across 116 files**. Then a **four-pass audit of the whole branch** (180 files vs main) returned 15 findings; six were verified against the code before any were acted on, and the five that are unambiguous are fixed, each mutation-checked: (1) **a work bundle's slug was never sanitized** — `str()` only slices, and `restoreContext` joins it into `.baton/progress/<slug>.json`, so a bundle carrying `slug: "../../../.claude/settings"` wrote attacker-chosen JSON into the importer's own hook config on nothing more than `baton handoff import`; sanitized at the boundary where untrusted JSON becomes a `WorkBundle`, not at each use. (2) `isSafeBundlePath` blocked traversal but allowed **dot-directories**, so `.git/config` (`core.fsmonitor` runs a command on the next git call), `.git/hooks/*` and `.claude/settings.json` all passed — `git apply` refuses `.git/**` for this reason and the untracked-file writer beside it had no equivalent guard; dot-FILES stay allowed, since it is the directory that carries the machinery. (3) **`POST /api/tasks/:slug/agent/start` was write-gated but neither owner- nor loopback-gated**, so any authenticated member of a `--host --write` daemon could execa an agent CLI on the host, in the host's worktree, with the host's credentials and their own prompt — the capability `access.ts` rule 2 explicitly reserves for loopback ("an interactive shell on the host deserves its own decision, not an accidental consequence of `--host`"), reached through a different door; now refused in `decideAccess` itself (`isHostProcessPath`) rather than inline in the route, ahead of token verification, because no credential should make it reachable. `stop` stays open: ending a run is not starting one. (4) The cross-machine claim maps were plain `{}`, so a teammate holding a file named **`__proto__`** made `(byPath[p] ??= [])` find a truthy inherited object, skip the assignment and throw on `.push` — and the catch reported the whole HOST unreachable, every 10 s for the claim's TTL, silently blinding every teammate's `check_files`; `constructor` needed no host at all, reaching a function's `.filter` on the read side. Both are legal file names, so the maps are now null-prototype rather than the paths rejected. (5) The project-`agents.json` hardening constrained `binary` but left **`detect` free**, and it is compiled with `new RegExp` and matched against every line of `ps -axo command=` on the poll path with no timeout — `((\w|\s)+)+X` is twelve characters and never returns, so a cloned repo froze the single-threaded daemon on the first poll with nothing opted in; project patterns now reject a repeated group whose body contains a repeat or another group (`~/.baton/agents.json` keeps the unrestricted form — same trust split as `binary`). Suite **1238 across 116 files**. Then the **agent-launch surface itself**: spawn.ts's stdout redaction could be defeated by a chunk boundary — `data` events land on arbitrary byte boundaries, so a single printed line routinely arrives in two chunks and `detectSecret` only ever saw half a credential, while the halves were published as two whole lines; now per-stream partial-line buffering (8 KB cap so a newline-less progress bar can't grow it unbounded, exit flush so the last line — the one saying how the run ended — is not swallowed). `startAgent` was also the 24th caller of the `gitRoot()`→worktree shape, switched to `activeBatonRoot()`. `test/spawn-safety.test.ts` (4, real child processes) pins redaction, split-chunk redaction, the trailing line, and prompt-as-argv. Suite **1243 across 117 files**. Then the **nine deferred audit findings, all verified** by three independent reviews — five real, four refuted with file:line evidence (probeMeta's loopback dial is local-by-contract and never aimed at remotes; daemon stop is socket-address-gated, strictly stronger than owner; purge sits behind the central origin gate, whose accept-set strictly contains the per-route one; review findings TEXT was redacted all along, on write and read). The five real ones fixed, each with tests, each mutation-checked: (1) `POST /api/tasks` was the ONE state-changing route missing the read-only gate — and `createTask` makes a git branch and a worktree, so a read-only `--host` daemon let any member (or any local process) mutate the repo; (2) reviews.ts was load→mutate→save with no lock while members.json/teams.json had one — two racing dashboard resolves both got a 200 and the later rename silently reverted the earlier (aggravated by both writers sharing one pid-keyed tmp path); now in the same per-file `withLock`; (3) the reviews record's NON-finding fields (`skipped[].why` — "could not run SAST, needs KEY=…" — `partial`, `fixedPoint`) skipped the redaction the finding fields had from day one; now symmetric on write and read; (4) `redactRemote` required a COLON in userinfo, so git's own PAT idiom (`https://ghp_x@github.com/o/r` — what `git clone` with a token writes into remote.origin.url) was served verbatim to every member via `GET /api/workspace` and written into joiners' git configs unflagged; now any userinfo is stripped and flagged, scp-like `git@host:` untouched; (5) member warnings — private owner↔member reprimands — were readable by the entire hub through BOTH the roster and the `member.warned` SSE payload; now owner-or-self only (`canSeeWarnings` in access.ts, with the boundary's other rules) and the event carries no text (the target's heartbeat delivers it, as designed). Plus `allOverlaps` recomputed presence+claims+sort once PER MEMBER per call on endpoints the Team screen polls every 10 s — now one grouped scan, same output. Suite **1250 across 117 files**; both workspaces build. Then the last seven known-open defects, all fixed. The headline is the **tunnel trust collapse**, which was Baton's own recipe: `src/reachability.ts` told operators to run `cloudflared tunnel run --url http://localhost:7077` with no `--host`, and cloudflared dials the daemon over LOOPBACK — so every request off the public internet arrived wearing 127.0.0.1, `decideAccess` rule 1 read it as the owner at the keyboard, and the member boundary was not merely weak but *never consulted* (revoking a token changed nothing). It carried terminals — an interactive shell on the host — and agent launches, the two capabilities rule 2 reserves for loopback forever. Fixed with **`baton serve --behind-proxy`**, which withdraws the loopback trust in ONE `&&` inside `decideAccess` (every rule downstream keys off `local`, so terminals, agent-start, the token requirement and `requiresOwner` all tighten together with no second code path); the server's registry shortcut had to follow, since handing an empty registry to a now-token-checking loopback path would have locked the daemon out of itself. Fails closed like `--host` (no members = refuse to start, because a mode whose point is "check tokens" must not start with none to check), warns at startup on the risky shape (public `--allowed-host` + loopback bind + no flag — a warning not a refusal, since the same shape is legitimate when the name resolves to 127.0.0.1), and the recipe now carries the flag. Deliberately NOT fixed by trusting the `Host` header, which is client-supplied and would have contradicted the module's own first principle. Verified end-to-end against a real daemon: no token → 401, member token → 200, terminal with a valid token → still 403, static assets → 200 so the login page loads. The other six: **`/api/storage/purge` now requires owner** — it deletes memory, history and reports then reclaims git objects, and any member could run it (`GET` hands out the confirm phrase, so "type the phrase" was never a credential) — and its private loopback-only Origin check became the shared `isAllowedOrigin`, which had been 403ing the operator's OWN dashboard under `--allowed-host`; **`stopAgent` kills the process GROUP** (`detached` + negative pid), because an agent CLI is a supervisor and killing only the direct child left npm/tsc/pytest running while the UI said "stopped" — the daemon's shutdown path now calls `stopAllAgents()`, since detaching opted those children out of execa's kill-on-exit; **the dashboard has a stop button at last** (`stopAgentRun` had existed with zero callers, so a run could be started from a screen that could not stop it) — Detail asks the daemon what is running rather than guessing, so a sheet opened long after a run began still offers Stop; **`nestsQuantifier` reads character classes** as the literals they are, so `(\s[-+]agy)+` is no longer rejected for a plus sign that quantifies nothing (the honest claim is the false positive: every mis-pairing arrangement tried still reached the same verdict, so the paren tracking is correctness, not a demonstrated escape); and `baton daemon stop`'s SIGTERM message stopped **asserting a cause it never observed** — a read-only daemon *answers* `/api/shutdown` with a deliberate 403 and is signalled anyway, which is right (whoever runs it has the shell, and `kill` works regardless), but "was not answering" sent people hunting a hang that never happened. `docs/security.md`'s "Network surface: loopback only" section was rewritten — it predated `--host` and stated the opposite of what the code does, which is exactly the page someone reads before exposing a daemon. Suite **1258 across 117 files**; both workspaces build. Then the coverage gap those fixes exposed was closed: every rule in `access.ts` had unit tests with no daemon behind them, because no suite could make a request that was not loopback — so the gates were pinned as pure functions while the WIRING (does this route consult them, in what order) was pinned nowhere, which is exactly how `POST /api/tasks` came to skip the read-only gate and purge the owner gate. `--behind-proxy` turns out to be the lever that closes it without a network bind: under it a loopback request is treated precisely as a remote member's is. New `test/proxied-member.test.ts` (10, real daemon, three real tokens) pins what a member may and may not do — roster yes, owner controls no, purge no, terminal no, agent-start no, daemon fleet no, creating a task YES (the counterweight: the gates must not have turned a collaboration hub into a read-only one). Two things it caught in itself: the warnings assertion passed against the UNFIXED code, because Priya had no warnings either way and "Sam cannot see Priya's warnings" proves nothing when there are none — it needed a third member who is actually warned; and it claimed port 7398, already team-api's and member-controls', which with parallel test files is a race rather than a detail. Both key assertions are now mutation-verified against the real daemon. Suite **1268 across 118 files**. Then three parallel audits over the code nobody had reviewed — `src/kb/`, `history/watch/poller`, and **the uncommitted diff itself**. The last one was the important one: it found five REGRESSIONS in that session's own fixes, all now fixed. (1) Widening `redactRemote` to every scheme ate the `git@` out of `ssh://git@host/path`, where the userinfo is the SSH login name, not a secret — the manifest cloned as the joiner's local username and failed with "Permission denied (publickey)", while telling them their remote embedded a credential. Now http(s) only, which is where the token idiom lives. (2) `detached: true` silently opts a child out of execa's kill-on-parent-exit (`if (!cleanup || detached) return`) AND setsid()s it out of our session, so `baton start` killed by anything but Ctrl-C — a closed terminal, a `kill` — orphaned the agent forever; cleanup is now armed explicitly on first spawn, claiming only signals nobody else owns. `killTree` also gained a liveness guard, because `process.kill(-pid)` on a reaped pid can hit a stranger's process group. (3) The new `POST /api/tasks` write gate had no client half: `createTask` was the one mutator without `assertWrite`, so a plain `baton serve` turned the dashboard's primary create flow into a 403 toast. (4) Rejecting a whole bundle for one dot-directory path destroyed handoffs built before the rule existed over a harmless `.github/workflows/ci.yml`; import now drops the file, names it, and keeps the patch — not writing the file was always the entire protection. (5) `--behind-proxy` made `access.local` false for everyone, which locked the OPERATOR out of shutdown and the daemon fleet; `isOperator()` lets the owner token stand in for loopback exactly where the flag removed it. Plus one the review found and one it caused me to find: the ReDoS guard admitted `(a|aa)+$` — overlapping alternation, ~180 ms on 28 chars and doubling per character, no nesting required — so a repeated group may no longer alternate at all; tightening that exposed a latent bug where `'+*{'.includes(src[i+1] ?? '')` read a group at the END of a pattern as repeated, because `includes('')` is true for every string, and `(\s|$)` is how nearly every real detect pattern finishes. From the other two audits: **`loadKb` required `.git` on every project**, while `detectProjects` splits on "marker OR .git" — so the ordinary polyglot layout registered two projects that every read silently dropped, `baton doctor` called it healthy (health.ts never checked `.git`), and the first rebuild wrote the emptied list back, turning a hidden KB into a deleted one; the validator now uses the same test as the detector. **`writeShareDir` did an unconditional `rm -rf <root>/kb`** — an ordinary directory name — behind a y/N prompt that never mentions deletion, and again on every rebuild; it now refuses a `kb/` it did not generate. `detectProjects`' two single-project returns **bypassed the id sanitizer** whose own docblock names the two failures, so a directory called `My App` minted an id that can never match its own proxy route (graph server silently dead) — fixed at the one place ids are minted. `poller.ts` asked the SERVED root for a task's commits — the **sixth** instance of the wrong-root shape — so `commit.created` never fired for any hub task, which also meant signals never settled and committed files kept reading as busy. `busy_timeout` was set AFTER the DDL and the `journal_mode` switch in history.ts and reports.ts (signals.ts had it right), leaving exactly the two statements most likely to contend unprotected; `closeHistoryDb` left `ftsReady` cached, so a purge silently disabled full-text search for the life of the process; `baton doctor` resolved its KB root with `resolveBatonRoot`, defeated by the very shadow `.baton` the next line exists to report; and `listRepoFiles` returned `[]` on a non-git hub root, so `--docs` printed "✓ no doc sprawl found" at the setup with the worst sprawl. Suite **1273 across 118 files**; both workspaces build and typecheck. Still open, reported but NOT fixed (each needs a schema or lifecycle change rather than a patch): `kb.json` has no `withLock` and `/api/kb/rebuild` writes back a snapshot captured minutes earlier; `history.ts`'s `commit_files` has no repo column, so `who_touched` and bug-recurrence mix same-named files across a hub's sub-projects; `watch.ts` never re-syncs, so a watcher lost to an fs error or a KB change added after startup is gone until a task is created, while `isWatcherActive()` keeps reporting true; and `co-*` checkout slugs carry a known repo that never reaches `repoOf`, producing cross-project false conflicts. Windows has no process groups, so `killTree` falls back to the direct child there. Still open: phase 0's two-machine leg (needs hardware), E16's 4 MB drop, the tunnel happy path, and the reconnect loop against a genuinely slow link. Prior: **2026-07-21 (session 16b: review-store hardening)**. Four fixes on the store shipped earlier the same session, each reproduced by a failing test first: (1) **findings had no identity** — `resolveFinding` addressed by array position while `saveReview` replaced the array, so a re-review erased triage decisions AND an index could resolve the wrong finding; findings now carry a stable id (axis+file+title) and `--dismiss` survives a re-review while a `fixed` finding the reviewer reports again resets to open (if it's still found, it isn't fixed). (2) **No secret redaction** — findings quote raw hunks, and unlike memory nothing scrubbed them; `detectSecret()` is now shared, and title/source/detail are redacted while the finding itself survives (a hardcoded-key finding is the Security axis's whole job). (3) **Open findings now ride into `buildBrief`** — `baton take`/`resume` surface inherited findings instead of the previous docs merely claiming they did. (4) `baton review save` no longer hangs forever on an interactive TTY. 87 files / 697 tests. Prior in session 16: Added the 9th bundled skill — three-axis (Standards / Spec / Security) diff review with a refute-before-report gate and a routing table, adapted from mattpocock/skills (MIT) and wired to Baton's handoff brief, memory, and edit signals. Backed by a **new durable store**: `src/reviews.ts` → `.baton/reviews/<slug>.json` (atomic writes, capped, citation-mandatory — a finding with no axis/title/source is dropped; only the Standards axis may claim a hard violation; per-axis counts are never summed), `baton review save|list|show|resolve`, `review.completed` on the event bus, `GET /api/reviews` + write-gated resolve route, HEAD-mismatch staleness flagging. Not an MCP tool by design — a 14th would breach `TOOL_HELP_BUDGET`, a context tax every session pays. New files: `src/reviews.ts`, `src/commands/review.ts`, `src/skills/bundled/code-review/{SKILL.md,references/smell-baseline.md,references/security-baseline.md}`, `test/reviews.test.ts` (15), `test/code-review-skill.test.ts` (6). Backend build + web build green. Prior session (2026-07-20, research: 1MCP): Cloned [1mcp-app/agent](https://github.com/1mcp-app/agent) (`@1mcp/agent` 0.34.3) to `.refs/1mcp-agent` and mapped the aggregated runtime — note in `docs/notes/1mcp-agent.md`. Prior session 15 (2026-07-18): hardening round after a 4-track audit — security/resources/memory-staleness/concurrency — on `chore/typescript-7-attempt`. P0 stability: SQLite `busy_timeout` on all three history.db connections (a locked write THREW and killed the daemon from timer callbacks), event-bus subscriber isolation, atomic `saveKb` (a torn kb.json silently re-enabled shadow-`.baton` adoption), kb-export unhandled-rejection catch. P1 resources: `repoState` marker probes collapsed 5 spawns→cached stats, `/api/status` rides the poller snapshot, ps/lsof TTL 2s→5s, indexed `checkOverlap` (was a full-table scan per changed file). P2 memory: facts saved without `files:` now auto-derive anchors from their own text and age to stale past 50 commits (they previously could NEVER go stale), `baton take`/`resume` prepend a STALE BRIEF warning when commits landed after the brief, progress ledgers predating the last commit are dropped from briefs, `commitsBehind` scoped to anchored paths. P3: flag-lookalike prompts neutralized in positional argv slots, coalesced dirty-path scans, terminal-SSE slow-consumer cap (4MB → drop), clean EADDRINUSE message. Audit verdicts: no exploitable security findings; P1 gitRoot→worktree bug confirmed fixed. (PR #5, #6 status unchanged.)

## What this project is

Baton is a **centralized knowledge base + coordination hub for multiple AI coding
agents** (Claude Code, Cursor, Codex, Gemini CLI, Aider, OpenCode) working on the
same repo. Each task runs in an isolated git worktree; a local daemon + dashboard
give you: a code knowledge graph agents can query, realtime visibility into who is
editing what, warnings when two sessions touch the same file, completion reports so
waiting agents know when a bug is already fixed, and session handoff briefs so work
continues on a cheaper agent when Claude Code hits its session limit.

Vision docs: [README.md](README.md) · [BUILD.md](BUILD.md) · [MVP.md](MVP.md). Setup: [SETUP.md](SETUP.md).

## Built & verified ✅

| Feature | What it does | See it work |
|---|---|---|
| **Graphify knowledge base** | `baton kb init` indexes the repo (sub-projects auto-detected → one graph each + merged view) via the external `graphify` CLI; git hook auto-rebuilds on commit; MCP config generated so agents can `query_graph` | `baton kb init && baton kb status`; dashboard → Knowledge Graph |
| **One-command setup (`baton setup`)** | Classifies the target folder and routes (`src/commands/setup.ts` `classifyTarget`): a single repo → `kb init`; a folder holding several *separate* git repos → asks **centralized hub** (auto `git init` at the container root + `.gitignore` + merged cross-project graph + one dashboard) vs **individual** per repo; a bare project → offers `git init` here. Reuses `kbInitCmd`. Robustness: `ensureBinPath` (`src/util/path-env.ts`) augments PATH at startup so a GUI/thin-PATH daemon still finds tmux/graphify; `detectTmux` re-probes after a negative instead of caching it; `currentBranch` tolerates an unborn HEAD (no `/api/meta` 500 on a fresh hub) | `baton setup <folder-of-repos>` → choose hub; `baton setup` inside a repo; `npx vitest run test/setup.test.ts` |
| **Knowledge Graph page** | Force-directed canvas of graph.json: search + neighbor highlight, community filters, node inspector with source locations, write-gated Rebuild | dashboard → Knowledge Graph (654 nodes on this repo) |
| **SSE realtime** | `GET /api/events` pushes status/task/commit/agent/file/kb/handoff events; per-worktree fs watcher; daemon-side status diffing; UI shows "Live (push)" and updates instantly | `curl -N localhost:7077/api/events` then touch a file in a worktree |
| **Edit signals** | Live "task X is editing file Y"; 2+ sessions on one path → `signal.overlap` warning in Conflicts + Activity | edit the same file in two worktrees, watch Conflicts page |
| **check-before-edit** | Agents ask "is this file busy?" via `baton mcp` tool `check_files` or `GET /api/signals/check?files=…` | `baton signals` / curl |
| **Completion reports** | On merge: summary + files + commits persisted (`.baton/reports/<slug>.md`), pushed to overlapping sessions, shown in History; `get_report` MCP tool answers "is my bug already fixed?" | merge a task, then `curl localhost:7077/api/reports` |
| **Agent blame** | `baton blame <file>` / `GET /api/blame` — which task/agent touched a file (merged history + live editors) | `baton blame src/cli.ts` |
| **Session handoff** | `baton pass` parses the Claude Code JSONL session → `HANDOFF.md` brief (plan, files touched, git state, graph excerpt); `baton take` prints the execution prompt; `baton done`; Claude Stop/PreCompact hooks via `baton hooks install claude`; Handoff dialog in dashboard drives the real endpoint | `baton pass <slug> --to cursor` then `baton take <slug>` |
| **Static dashboard serving** | `baton serve` serves the built UI at the same port as the API (SPA fallback, traversal-guarded) | `npm run build --prefix web && baton serve` → http://localhost:7077 |
| **Real project switcher** | Connections model: register multiple daemons (one per repo, `baton serve -p <port>`), switch between them in the top-left switcher; identity from each daemon's `/api/meta` | top-left switcher → "Add connection…" |
| **Real Live Session** | Demo's fake website mock + fake dev-servers are gone; real mode streams the SSE feed per session (edits, commits, attach/detach, overlap warnings) with API backfill | open a session → Live |
| **Honest Activity page** | Real mode: active/commits/files/progress cards, per-agent commits+files rollup, live edit-signals section; fake token numbers exist only in demo mode | Activity page with demo OFF |
| **CODEBASE.md layer** | `baton kb init/rebuild` generates a <2k-token deterministic map per project (stack, tree, top graph symbols, query pointers) + a root index for multi-server containers; staleness footer tied to the graph's commit; AGENTS.md tells agents to read it first. Prior art: Aider repo-map, Repomix, llms.txt | `baton kb rebuild` → open CODEBASE.md; `baton kb status` flags staleness |
| **Agent routing** | `baton.config.json` (committed): plan→claude/opus, UI→gemini, bugfix→codex, default cursor; `baton pass` without `--to` auto-routes (word-boundary keyword scoring, no LLM); `baton route "<task>"`; `/api/routing`; Handoff dialog preselects with a "suggested" chip, Launch shows a suggestion row, Settings shows the rules. Prior art: claude-code-router | `baton route "fix the crash"` → codex; `baton pass <slug>` → routed frontmatter |
| **Tiered model routing (v2)** | Single source of truth `src/agents/registry.ts` (id/binary/detect/headless+interactive launchers/model flag) — `spawn.ts`/`terminals.ts`/`agents.ts`/`routing.ts` all derive from it. `src/routing.ts` (+ parity-locked web mirror): three **modes** (`auto`/`manual`/`single`), 0–100 **severity** score (`scoreSeverity`, deterministic hints), **tiers** heavy/standard/light/local as ordered fallback **chains** (`resolveChain` skips uninstalled CLIs), `suggestRoute` returns the explainable suggestion (matched keywords + severity signals + confidence). `model` plumbed end-to-end: `--model` on `baton start`/`baton pass`, headless + interactive launch, `/api/*` bodies. | `baton route "refactor the storage engine for concurrency"` → heavy tier (claude:opus); `baton route "fix typo"` → local tier |
| **Junk cleanup (`doctor`/`clean`)** | `baton doctor` audits junk — orphaned worktrees (tasks.json↔disk both directions), orphaned `baton/*` branches, ghost tmux sessions, leaked `*.tmp` from crashed atomic writes, stale `.baton/tmp` uploads (`src/cleanup.ts`, pure detectors + I/O wrapper). `baton clean` is **dry-run by default**; `--fix` reclaims, `--force` for dirty worktrees; reuses `removeTaskWorktree`/`removeWorktree`/`killSessionFor`. `GET /api/doctor` + `POST /api/doctor/clean` (write-gated, `{apply,force}`). **Prevention**: daemon startup sweep deletes only provably-dead temp files (dead pid + age, never live writes/worktrees); `.baton/tmp` upload dir now removed after use. Never deletes a dirty worktree or a live-pid tmp. | `baton doctor`; `baton clean --fix` (cleaned 5 stale test tasks live, 7→2); `curl localhost:7077/api/doctor` |
| **Agent roster + MCP connect** | `GET /api/agents` (`src/agents/roster.ts`) = per-agent **installed?** (PATH probe, 30s cache) / headless / interactive / **MCP wired?** / **live sessions** (process scan + headless runs + terminals unified). Rebuilt Agents screen is the real roster (no more "idle"≡"not installed"); Connect-MCP per agent via `POST /api/agents/:id/connect` (`src/agents/connect.ts`): project files (`.mcp.json`, `.cursor/mcp.json`) auto-write, global files (`~/.gemini/settings.json`, `~/.codex/config.toml`) return a preview and require `confirmGlobal`; non-destructive JSON merge / idempotent TOML append; aider/opencode surfaced as MCP-n/a. Launch + Hand-off actions on each card. | dashboard → Agents; `curl -XPOST localhost:7077/api/agents/claude/connect` writes `.mcp.json` |
| **KB export/import/share** | `baton kb export` → .tar.gz pack (graphs + CODEBASE.md + manifest with git HEAD); `baton kb import <pack\|kb/>` re-anchors paths, validates graphs, reports "N commits behind" and auto-refreshes; dashboard Export/Import buttons on the Knowledge Graph page; `baton kb share on` keeps a committed `kb/` dir so teammates clone-and-go | export, clone repo elsewhere, `baton kb import <pack>` → graphs appear with zero re-indexing |
| **Real token usage** | `baton usage` + `GET /api/usage`: parses Claude Code session JSONLs (input/output/cache tokens + est cost per session, mtime-cached), mapped to task slugs; Activity shows a real "Tokens used (Claude)" card + per-session tokens; KB page shows the savings metric (this repo: map ≈ 824 tokens vs ≈ 248k reading it — ~300× cheaper). Prior art: Orca | `baton usage` |
| **Headless agent launch** | `baton start <slug> [--agent claude\|codex\|gemini]` runs the agent's print mode in the worktree (prompt = HANDOFF.md brief when present), output streamed as `agent.output` SSE events into the Live screen; `baton stop`; Detail "Start agent" button; Launch dialog "start headless after create" (its Preview badge disappears on that path); 409 on double-start; never adds permission-bypass flags. Prior art: Rover | `baton start <slug> --prompt "say hi"` |
| **Interactive agent terminals** | Real PTY sessions in the dashboard: tmux hosts each session (`baton-<repoHash>-<slug>`, zero new daemon deps, survives daemon restarts), driven via one control-mode client per session; output → per-session SSE stream (`/api/tasks/:slug/terminal/stream`, snapshot+live), input/resize → POST (hex-encoded send-keys, injection-proof); xterm.js panel in the Live screen (Terminal tab, auto-selected when live), Launch dialog 3-way start mode (worktree only / interactive / headless), Detail "Open terminal" button; mutual 409 with headless runs; kill-on-task-remove; tmux-missing → capability flag + install hint; demo mode plays a canned transcript. All six agents launchable (`cursor-agent` for cursor; aider/opencode bare). Prior art: handler.dev (tmux+capture-pane), claude-squad | Launch → "Open interactive terminal" → type into the live claude TUI; `tmux ls`; kill daemon, restart → session reattaches |
| **Write mode follows the daemon** | The dashboard's write capability auto-follows `/api/meta.writeEnabled` in real mode (fresh browsers get terminals/merge out of the box when the daemon runs `--write`); an explicit toggle choice still wins, a read-only daemon always forces read-only; read-only/demo states explain themselves (`baton serve --write` hints in Launch, Live terminal tab, TerminalPanel footer) instead of hiding options | clear localStorage → open :7077 → Launch shows all 3 start modes with no toggle |
| **Skills (catalog + install)** | Searchable catalog of reusable agent playbooks. **File-backed** multi-file skills live under `src/skills/bundled/<id>/` — a real `SKILL.md` (gray-matter frontmatter, incl. folded multi-line descriptions) + an optional `references/` folder; the flagship `bug-fix` skill (reproduce-first → audit → blast radius → root cause → ≥95% skeptic-corroborated confidence + approved plan → fix → re-verify → auto-commit, never push) ships 3 reference files. The **efficiency & traceability pack** adds four more file-backed skills (`token-efficient-coding`, `traceable-changes`, `memory-light`, `verify-before-done`) — each a portable SKILL.md + one `references/` cheat-sheet, with optional "Baton boost" sections (CODEBASE.md/query_graph/recall_memory/who_touched). The `code-review` skill reviews a diff since a fixed point along **three axes that are never merged** — Standards (repo conventions + a 12-smell Fowler baseline), Spec (does it match the issue/spec/handoff brief, no scope creep?), and Security (source-to-sink vulnerability baseline) — run as parallel sub-agents, with **every finding refuted before it is reported** (the bug-fix skill's ≥95% skeptic gate applied to findings), reported side by side with no cross-axis ranking, then **routed** (Spec-wrong → systematic-debugging, Security → bug-fix) and **persisted**. Two-axis structure + smell baseline adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT); the Security axis, refute gate, routing table, and durable record are Baton additions. Deliberately distinct from `verify-before-done` (author proves their own change works) — the boundary is stated in both SKILL.md files and pinned by a test. Tags/produces for file-backed skills live in `BUNDLED_META` (catalog.ts) so the source SKILL.md stays a clean name+description-only Claude skill. Plus short **inline** skills (`map-codebase`, `safe-refactor`) and **imported** skills read from `.baton/skills/*.md`. Bundled skills are cached + copied into `dist/` at build (`scripts/copy-assets.mjs`). `GET /api/skills` returns each skill with per-agent install state + reference paths (content/raw never serialized); `POST/DELETE /api/skills/:id/install` writes/removes in the agent's own format — Claude → `.claude/skills/<id>/SKILL.md` (+ `references/`, hand-authored SKILL.md written verbatim when faithful), Cursor → `.cursor/rules/<id>.mdc` (`alwaysApply:false`) with references copied to a sibling `<id>/` folder the rule points at; other CLIs unsupported. `POST /api/skills/import` adds from a path/http(s) URL (256KB cap, can't shadow a bundled id). All writes gated on `--write`. Dashboard **Skills** screen: search, source/produces/reference chips + multi-file badge, per-agent install toggles, playbook preview, import; an **"Efficiency & traceability pack"** showcase band highlights the four pack skills on the unsearched landing state (click a chip to filter to it); demo mirror (`web/src/lib/demoSkills.ts`). | dashboard → Skills; `curl -XPOST localhost:7077/api/skills/bug-fix/install -d '{"agent":"claude"}'` writes `.claude/skills/bug-fix/SKILL.md` + `references/` |
| **Project memory** | Evidence-anchored shared memory at `.baton/memory/facts/` (one md file per fact, atomic writes, always the MAIN repo even from worktrees): every fact stores the commit + content-hashes of the files it describes; on every read the anchors are re-checked — changed file ⇒ fact served as `stale` with the reason and **withheld from agents** (anti-hallucination). Agents write via `save_memory` / read via `recall_memory` MCP tools (keyword-ranked, stale-filtered); supersede-by-fingerprint dedup; secret-pattern rejection (keys/tokens/JWTs refused); 1.2k-char + 500-fact caps; handoff briefs embed a token-cheap "Project memory" section; daemon watches the store → `memory.updated` SSE; dashboard Memory page (search, fresh/aging/stale badges, quick-add, GC, delete; demo facts in demo mode); `baton memory list\|add\|rm\|gc` CLI; AGENTS.md guide tells agents to recall-before-exploring and save-after-learning | `baton memory add "…" --files src/x.ts` → edit src/x.ts → `baton memory list` shows STALE → `baton memory gc`; dashboard → Memory |

| **Shared graphify backend pool** | The daemon owns one graphify HTTP backend per **touched** project (lazy start on first query, reaped after 15 min idle); agents POST to `POST /mcp/g/<token>/<projectId>` and never spawn their own processes. Token-gated (`.baton/mcp-token`, mode 0600, embedded in the config URL); backends bind `127.0.0.1`. Claude/Cursor get `{type:'http', url}` MCP entries; Gemini gets `{httpUrl}` (Gemini CLI's streamable-HTTP schema); Codex uses `baton mcp-bridge <url>` (stdio TOML → same shared pool). Existing setups migrate by re-running `baton kb init` (or the Agents → Connect action). RAM: ~720 MB (3 agents × 6 stdio processes on a 5-project hub) → at most 1–2 backends per touched project regardless of agent count (~120–180 MB shared vs ~720 MB–1.8 GB before). Graph freshness: graphify `--stateless` re-reads on every request (empirically verified: node count drops immediately after file modification, no flush needed). | `node dist/cli.js serve --write --port 7079` against FAT_FOX (5 projects): `/api/kb/mcp` → http URLs; POST tools/list to `merged` + `fatfox-api-server` → 2 Python backends started (HTTP 200 both); wrong token → 403; SIGTERM daemon → 0 backends remain |

| **Context pack** | `baton kb context`, `GET /api/kb/context`, dashboard "Share context" modal — budgeted (≤ ~8k tokens), deterministic, secret-redacted markdown brief of the project/hub for pasting into external chatbots. Spec: docs/superpowers/specs/2026-07-04-context-pack-design.md. | `baton kb context \| pbcopy`; dashboard → Knowledge Graph → Share context |
| **Site hosting readiness + dashboard edge cases** | env-driven site URL (`NEXT_PUBLIC_SITE_URL`), PNG OG image + favicon, correct quick-start commands, mobile nav menu, noscript reveal fallback; SSE reconnect indicator, honest error/loading/empty states on Memory/Activity/Conflicts/Knowledge Graph pages, overflow fix | `cd site && npm run build` → `/opengraph-image` + `/apple-icon` routes listed; dashboard → Memory/Activity/Conflicts/Knowledge Graph with demo OFF |

**Final-review fixes (2026-07-03, session 7 polish).** (1) Gemini `httpUrl` fix: `McpServerDef` now has a third `{ httpUrl }` variant; `mcpServersGemini()` / `serversForStateGemini()` / `geminiSnippet()` emit it; `mergeTomlConfig` handles it. (2) `--port` flag on `baton kb init` and `baton kb mcp` so non-default-port setups generate correct MCP URLs without needing the daemon running. (3) FIX 3 verified FRESH — graphify `--stateless` re-reads per request; documented in code + docs. (4) `serversForState(state, undefined)` now throws instead of silently returning baton-only. Tests: 8 new tests (gemini httpUrl, port in URL, throw behavior, misleading title renamed). **274 tests green.**

Tests: 266 vitest tests at root green (routing v2 + MCP-connect + roster + skills + graphify-server + graphify-proxy + mcp-token covered;
`test/skills.test.ts` covers render/parse/target helpers, folded-YAML parsing, multi-file
references, file-backed bundled loading, and the efficiency & traceability pack's load +
faithful raw + BUNDLED_META tags/produces). Both workspaces strict TS, both builds clean.

**Hardening pass (2026-06-17, audit-driven).** Verified multi-agent code review →
fixed: (1) HTTP response pipes now attach `'error'` handlers (static asset, graph.json,
kb-export tar) so a cancelled download / mid-stream IO error can no longer crash the
zero-dep daemon; (2) the memory `fs.watch` gets an `'error'` handler (matches watch.ts);
(3) `BatonBus` lifts the EventEmitter cap (`setMaxListeners(0)`) — no more spurious
warning past 10 SSE connections; (4) `baton kb init` reuses `mergeJsonConfig` (refuses to
clobber an unparseable `.mcp.json` instead of silently wiping the user's other MCP
servers); (5) `escapeRegExp` deduped into `src/util/regex.ts` (was copied in routing/
memory/connect); (6) SQLite history/reports DBs open `WAL` + `synchronous=NORMAL` and
`recordMerge` batches inserts in one transaction; (7) `listHistory` collapsed its 1+N
query into one grouped read; (8) memory hash/behind caches evict FIFO instead of a
blanket `clear()` (no re-scan stampede); (9) `SignalTracker.clear` re-derives overlap
announcements from live rows instead of wiping all (no duplicate overlap alerts).

**Security review + permanent storage purge (2026-06-18).** Inline security pass (the
multi-agent run stalled, so reviewed directly): daemon binds **127.0.0.1 only**, CORS is
**loopback-only**, kb-import tar extraction already guards tar-slip, JSON bodies cap at
1 MB — all good. Added a **loopback-Origin CSRF guard** (`isLoopbackOrigin`) on the new
destructive endpoint. **New: permanent data purge** (`src/purge.ts`, `GET/POST
/api/storage/purge`). Root cause of "disk keeps filling after deletes": deleting a task
removes the worktree but its commits stay reachable via the hidden `refs/baton/archive/*`
refs, so a plain gc can't reclaim them. The purge drops those refs + orphan `baton/*`
branches and runs `git gc --prune=now` (new `git.ts` helpers: `listArchiveRefs`,
`deleteRef`, `gitGc`, `objectStoreBytes`; `closeHistoryDb`/`closeReportsDb` release the
sqlite handle before unlinking history.db). Categories: archives, history, reports,
graphs, tmp, memory. **Triple-guarded**: `--write` + loopback Origin + a typed
`purge <repo>` phrase; the **Memory → Storage → Danger Zone** UI adds a 3-step flow
(select → review with sizes → type-to-confirm) and an extra acknowledgement for the
knowledge base. Never touches source, main, non-`baton/*` branches, or live worktrees.
`test/purge.test.ts` (7 tests) covers it; 235 tests green.

**Security hardening pass (2026-06-18, multi-agent audit-driven).** A 35-agent
audit (find → adversarially-verify → completeness-critic) found the loopback-Origin
CSRF guard was only on `/api/storage/purge`, leaving every other mutating endpoint
exploitable by a malicious site you visit while `baton serve --write` runs (a
"simple" `text/plain` POST skips CORS preflight and the body parser ignores
Content-Type). Worst case: `POST /api/tasks/:slug/agent/start` launches an agent
with an **attacker-chosen prompt** under your creds, and `…/terminal/input` injects
keystrokes into a live agent. **Fixes:** (1) **centralized anti-CSRF guard** —
`src/util/origin.ts` (`isLoopbackOrigin`/`isMutatingMethod`), enforced in
`handle()` for *every* mutating `/api/*` request, so new endpoints are covered by
default (loopback dashboard + curl still pass; verified end-to-end with curl).
(2) **SSRF hardening** of `POST /api/skills/import` (`fetchSkillText`): block
private/loopback/link-local/metadata hosts, re-validate each redirect hop, 10s
timeout, streamed 256KB cap (was: arbitrary URL, follow-redirects, no timeout,
buffer-then-check). (3) **DOM XSS** fix — `web/.../GraphCanvas.tsx` HTML-escapes
node label/source fields (untrusted imported `graph.json` → force-graph `innerHTML`).
(4) **graphify perf** — `readStats` now memoizes by (path, mtime, size); the polled
`/api/kb` no longer re-parses every `graph.json` each tick. (5) tightened the
GitHub-token secret pattern. New tests: `test/origin.test.ts`,
`test/skill-import-url.test.ts`, `test/graphify-stats.test.ts`. **249 tests green**,
both workspaces build clean. (Refuted as non-issues: SQL is fully parameterized,
tar-slip already guarded, git is shell-free, slugs sanitized.)

**Docs, landing page & marketing site (2026-06-19).** Turned the repo front door into a
proper product surface. (1) **README** rewritten as an accurate landing page (was stale
"planned API / WIP" — the product is built). (2) **`docs/` documentation section** — a
hub (`docs/README.md`) + 14 user-facing pages: installation, quickstart, cli-reference,
dashboard, knowledge-graph, session-handoff, skills, memory, mcp-tools, agent-routing,
configuration, security, architecture, troubleshooting (research notes preserved). All
cross-links verified resolving; no invented commands/flags. (3) **Dashboard onboarding**
— the zero-sessions board now shows a `FirstRun` panel (Baton mark, 3 getting-started
steps, "New session" CTA, copyable command, docs link) instead of a bare empty state;
verified in-browser. (4) **Marketing site** — a runnable Next.js 15 + Tailwind v4 +
framer-motion app under `site/` (dark, amber-accent, relay-baton hero animation; sections
per `docs/landing-page-prompt.md`; SVG hero instead of R3F for build reliability — see the
in-code upgrade note). `npm run build` in `site/` passes (6 static routes incl.
sitemap/robots). 249 tests still green; web + site builds clean.

**Multi-repo hub launcher + blank-terminal fix (2026-07-01).** The launcher only
worked in a single git repo; on a **multi-repo hub** (`baton setup` on a folder of
separate repos — the hub root isn't a git repo, e.g. a real FAT_FOX setup) every
launch path was broken. Root causes, all verified against the real hub: (1)
`serve()` called `gitRoot()` and **crashed** at the non-git hub root → new
`resolveBatonRoot()` (`src/store.ts`, walks up to the nearest `.baton/`, falls back
to `gitRoot`); serve/merge/rm now use it. (2) `createTask` ran `git worktree add`
at the hub root → **failed**; now takes a `projectId`, resolves the sub-project from
`kb.json`, branches the worktree off **that** repo, and stores `projectId` +
`repoRoot` on the Task. Merge/remove do git ops on `task.repoRoot` while keeping
tasks/history/reports at the hub root. `/api/meta` now returns `hub` + `projects`;
`POST /api/tasks` accepts `project`; `baton new --project <id>` for the CLI. (3)
**Blank interactive terminal** — a freshly-launched TUI (claude's Ink UI) paints its
first frame during the control-client attach gap, which tmux control mode never
replays, so the pane looked dead. Fix: the terminal stream seeds a fresh
`capture-pane` on connect (+ a delayed seed at launch), mirroring `adoptSession`.
Dashboard **Launch** + **New session** dialogs gained a **Project picker** (shown
only for a hub, driven by `/api/meta`). Docs updated (README, quickstart,
cli-reference, dashboard) + the marketing site's worktree card. `test/hub.test.ts`
(6 tests) covers resolveBatonRoot + hub create/merge/remove; **255 tests green**,
all three workspaces build clean. Verified end-to-end on the real FAT_FOX hub
(daemon boots, `/api/meta` hub:true + 5 projects, create→worktree-in-sub-repo→
merge→remove, self-cleaned). Still to do: live browser click-through of the picker
+ blank-terminal fix with a real `claude` session.

**Shared graphify server + unified agent proxy (2026-07-03).** Replaced the
per-agent stdio `uv run graphify.serve` spawning with a daemon-owned shared
HTTP backend pool. `GraphifyPool` (`src/kb/graphify-server.ts`) lazily starts one
graphify process per touched project and proxies all agent queries through
`POST /mcp/g/<token>/<projectId>` — the 32-hex token is stored in
`.baton/mcp-token` (mode 0600) and embedded in the generated MCP config URLs.
Backends bind `127.0.0.1` only, run `--stateless --json-response` (no session
affinity), and are reaped via SIGTERM after 15 min idle (60s poll). Daemon
SIGTERM/SIGINT fires `graphPool.shutdown()` so backends never outlive the daemon.
MCP config for Claude, Cursor, Gemini rewritten to `{type:'http', url}` form;
Codex uses `baton mcp-bridge <url>` (stdio TOML → same shared pool; its TOML has
no url key). Existing setups migrate via `baton kb init` or Agents → Connect.
Deliberate trade-off: graph queries now require `baton serve` to be running
for every agent (including Codex) — documented in
`docs/knowledge-graph.md`, `docs/mcp-tools.md`, `docs/architecture.md`,
`docs/troubleshooting.md`. Verified live against FAT_FOX (5-project hub, port
7079): 0 HTTP graphify backends before first query; `merged` query → 2 processes
(1 uv + 1 Python); `fatfox-api-server` query → 4 total (2 projects × 2 each);
wrong token → 403; SIGTERM daemon → 0 HTTP backends remain (12 pre-existing
old-style stdio processes untouched). Tests: `test/graphify-server.test.ts` (3)
+ `test/graphify-proxy.test.ts` (1) + `test/mcp-token.test.ts` (1). **266 tests
green**, backend build clean.

**Multi-agent coordination audit, P1–P12 (2026-07-05/06, session 9 — PR #5).** A
12-proposal audit (docs/research/2026-07-06-multi-agent-coordination-audit.md) shipped
one TDD'd phase per commit on `feat/worktree-orchestration`: **P1** gitRoot→worktree
signal attribution fix (silently broke coordination), **P2** SQLite-backed signals,
**P3** report-aware `check_files` ("already fixed" answers), **P4** MCP output
contracts (compact payloads, bounded lists), **P5** `report_progress` (agents share
live intent notes), **P6** lazy read-time signal reconciliation (dropped signals whose
path is no longer dirty in the worktree; untracked files aren't false-dropped),
**P7** orient hook + MCP tool (budgeted session-start brief), **P8** kb-init footprint
gitignored, **P9** declared task scope + overlap warning at creation, **P10** memory
journal + archive (nothing hard-deleted; `baton memory log`), **P11** merged-only
graphify in a hub by default (`projects.length > 1` guard keeps single-project state
intact), **P12** `baton doctor --docs` propose-only .md-sprawl scan (`src/kb/sprawl.ts`).

**Skills v2, S1–S6 (2026-07-08, session 10 — branch `feat/skills-v2`, off PR #5's
branch).** Research round first: Ponytail (github.com/DietrichGebert/ponytail, MIT)
cloned to `.refs/ponytail` and studied — single canonical SKILL.md, mode filtering,
restraint ladder, honest agentic benchmark (~54% less code, ~20% cheaper, ~27% faster,
100% safe). Then: **S1** bundled `bug-fix` skill v2 (Golden Rule 0: check the shared
tracker FIRST / record the fix to memory LAST — `save_memory` with `fixed-in:<sha>`;
guarded by an invariant test), **S2** new `lean-code` bundled skill (original-wording
adaptation of Ponytail's 7-rung ladder + safety carve-outs, MIT-attributed; ideas, not
text), **S3** install-a-skill-into-every-agent (`installSkillEverywhere`, new
`baton skills list|install|uninstall|import` CLI, `agent:"all"` API, "⚡ Add to all"
button), **S4** live who's-editing panel (Conflicts.tsx groups each busy file's holders
with their P5 intent note + freshness; web-only), **S5** workload-aware handoff
(`src/handoff/workload.ts` least-loaded pick + `GET /api/tasks/:slug/suggest-handoff`;
dialog preselects with reason + idle/N-active badges), **S6** bug recurrence
(`src/recurrence.ts` + `baton bugs "<symptom>"` — prior fixes from memory, a STALE fix
fact is itself the regression signal, suspect commits from history; zero new storage).
Deliberate non-builds (lean-code applied to ourselves): no AGENTS.md always-on skill
injection for codex/gemini (token-hostile), no SSE for the panel (5s poll is enough),
no upstream-Ponytail UI import (redundant with the bundled adaptation). **396 tests
green**; docs (README, skills, cli-reference, memory, session-handoff, dashboard)
updated this session.

**G-round: graph freshness + terminal-first coordination (2026-07-08, session 11).**
Research first (two agents): graphify supports ~35 tree-sitter languages (JS/TS/JSX/TSX,
Python, Java, Go, Rust, C#, PHP, Swift, Kotlin, Vue/Svelte…); post-commit hook rebuilds
incrementally and worktrees share hooks; the staleness gaps were uncommitted edits,
CODEBASE.md lag, silent detached-rebuild failures, and hub re-merge. Root-checkout
sessions were fully dark (no detection/signals/handoff; memory/guard/orient worked).
**G1 (graph-freshness golden rule):** `src/kb/freshness.ts` classifies fresh/behind/
dirty (uncommitted edits to indexable files) and renders an honest warning; orient
opens with it (budget-protected); the graphify proxy appends it to every query answer
(byte-for-byte passthrough on anything unparseable); `refreshDocsIfStale` + a 60s
daemon sweep keep CODEBASE.md following hook rebuilds; the rule is in the bug-fix +
lean-code skills, invariant-locked. Root-caused a flaky hub test: merge fire-and-forgot
a detached graphify update even for never-indexed projects — `queueMergeGraphRefresh`
now skips a graph that doesn't exist (first builds belong to kb init).
**G2 (root-session coordination):** the PreToolUse guard hook now WRITES the edit
signal it used to only read — task slug inside a worktree, `sess-<id8>` pseudo-slug
(from Claude's hook `session_id`) at the repo root, registered in a new
`hook_sessions` table (agent + checkout root). Reads attribute agents from it and
reconcile pseudo-session signals against the session's own checkout; a 15s grace
period keeps just-recorded signals (the hook fires before the file hits disk).
Orient nudges main-checkout sessions toward `baton new`. Verified end-to-end: two
simulated root sessions warned each other + `baton signals` showed the overlap with
no daemon ever running. README gained "Do I need the daemon running?" + a real
contributor guide. **428 tests green.** Remaining G-phases: G3 daemon-less graph
query fallback; G4 language-support docs. Known gap: root sessions of hook-less
agents (cursor/codex/antigravity) are still dark outside worktrees.

**Every-agent coordination M1–M3 (2026-07-09, session 12).** Plan + capability matrix at
docs/plans/2026-07-09-multi-agent-coordination.md (the traceability record — phases,
confidence gates, edge cases, progress log). Research: Ponytail's 16 adapters + vendor
docs → Cursor has documented `afterFileEdit` hooks w/ `conversation_id`; Codex hooks are
trust- and version-gated (<95% → deferred); Antigravity CLI = `agy`, inherits Gemini
config; aider = git-native only. **M1**: MCP session identity for EVERY agent —
`baton mcp` is one process per session, so pid = session (`sess-p<pid>`) and the parent
process chain names the agent (`detectParentAgent` in src/agents.ts, `BATON_AGENT` env
override); auto-registers in hook_sessions; `report_progress` works without a worktree;
new `touch_files` MCP tool records signals; AGENTS.md coordination guide teaches both.
**M2**: `baton hooks install cursor [--project]` → `.cursor/hooks.json` `afterFileEdit →
baton guard --agent cursor`; guard normalizes Cursor's payload (`normalizeGuardPayload`)
and records signals, silent to non-Claude hosts. **M3**: antigravity in the agent
registry (detection-only: `agy` + Antigravity.app; launchers deliberately unguessed) +
web AgentId. 439 tests green, both workspaces build.

**FAT_FOX live-hub bug fixes B1+B2 (2026-07-09, session 13).** Debugging a real
5-project hub (6+ Claude terminal sessions running at the hub root, plus GitHub-PR
merges) surfaced two dashboard blind spots. **B1**: agents running at the hub/repo
root (not in a task worktree) showed as "No agents attached" — `collectStatus`/
`detectAgents` are worktree-scoped only. Fix: `detectRootAgents` (scans the full
process table; matches cwd against the hub root + every kb project; excludes task
worktrees; collapses launcher/worker process pairs so a GUI-hosted agent like Claude
Desktop's bundled Claude Code isn't double-counted) → `rootAgentSummary` →
`GET /api/agents/root` → CommandCenter "Active sessions" + agent chips + an "N at repo
root" note. Live-verified: 9 sessions (6 terminal + 3 desktop-hosted). **B2**: commits
merged via GitHub PRs on the sub-repos never reached `history.db` (its commits table is
written only by `baton merge`→`recordMerge`). Fix: `git.recentCommits` + `history.
ingestGitLog` import each project's real `git log` into a per-project bucket
(`git:<id>`, agent null), idempotent, never clobbering a real task's sha; daemon runs
`ingestAllProjects` at startup + every 60s. Live-verified: 100 real FAT_FOX commits
ingested. B3 (Cursor IDE not process-detectable → coordinate via hooks/MCP) documented
in the plan. 453 tests green. NOTE: the user's FAT_FOX daemon must be restarted to pick
up this code (it was running a pre-fix build).

**W-round: workspace hygiene + honest graph + parity (2026-07-10, session 14).** Driven by
an honest audit of the live FAT_FOX hub: 25GB total, of which ~13GB was 60+ agent-created
orphaned worktrees (~90% for branches already PR-merged) — Baton's own footprint was 29MB.
**W1**: `baton clean` gained merged-worktree GC across every kb project (porcelain survey,
origin/<default>-first merge target, never touches main/dirty/unmerged/locked, never
deletes branches, `git worktree remove` without --force as the second safety net, du only
on removable candidates; baton tasks whose tree is removed are dropped from the store).
Live dry-run on FAT_FOX: 42 removable, ~8.8G reclaimable. **W2**: hub worktree sessions
previously matched NO kb project → no graph freshness note; projectForCwd now resolves the
owner via git-common-dir, and orient appends a branch-divergence warning (files where the
session's branch differs from the graph's build commit). **W3**: the G2 nudge wrongly told
foreign-worktree sessions "main checkout" — linked-worktree detection (git-dir ≠
git-common-dir) now yields the honest unmanaged-worktree hint. **W4**: antigravity joined
SKILL_AGENTS (`.agents/skills/<id>/SKILL.md`, layout evidenced by a live Antigravity
workspace); web SkillAgent + registry glyph. **W5**: advisory `downshift` on RouteSuggestion
when a keyword rule catches a clearly-trivial task (severity <25) — rules still win,
cheaper light/local chain + reason attached; mirrored in web routing, parity suite extended.
**W6 deferred below the 95% gate** (Stop-hook decision:block contract unverified; documented
in the plan). All in docs/plans/2026-07-09-multi-agent-coordination.md W-round section.
479 tests green ×2.

**Antigravity MCP parity (2026-07-22, session 17).** Antigravity could already *receive*
skills (`.agents/skills/`, W4) but had no MCP wiring — it was being handed playbooks that
say "call `check_files`" with no way to call anything. `mcpTargetFor` now returns
`<repo>/.agents/mcp_config.json` (project-scoped, so it auto-writes like claude/cursor —
nothing in `$HOME` without a confirm). Evidence, since W4-era guesses were deliberately
deferred: official docs give the path + `mcpServers` key, and a live install on the dev
machine ships exactly that file (`~/.gemini/config/mcp_config.json`, 0 bytes) plus
`~/.agents/skills/` in the layout Baton already writes.

Antigravity's graphify entries go through `baton mcp-bridge` like Codex, NOT its documented
`serverUrl` key: that key has a single source, is unverified against a live install, and a
wrong url key yields a server that loads and answers nothing. `command`+`args` is the one
shape every MCP client agrees on, so parity costs zero confidence. `mcpServersCodex` and
`mcpServersAntigravity` now both delegate to a shared `mcpServersBridged`; the nested
agent ternary in `connectAgentMcp` became a `SERVERS_FOR_AGENT` lookup. Revisit `serverUrl`
only once verified live. **Launchers stay unguessed** — `agy -p` has an open non-TTY hang
bug (exactly how Baton would spawn it) and Antigravity's ToS reportedly forbids
third-party access. Two independent reasons; detection-only was the right call.

Verified end-to-end on temp repos: fresh write, idempotent re-connect preserving an
unrelated `chrome-devtools` server **and** a non-`mcpServers` top-level key, and the 0-byte
file a real install ships (merges — `mergeJsonConfig` guards with `if (existing.trim())`,
so it never trips the parse-error path). Also fixed `web/src/lib/api.ts`'s demo mirror of
`mcpTargetFor`, which would otherwise have shown Antigravity as MCP-n/a in the dashboard.

Docs drift fixed in the same pass: `docs/skills.md` listed only claude+cursor as skill
targets and named antigravity in neither the supported nor the excluded list — it had been
a third target since `0569178`. Also recorded that `.agents/skills/` is the emerging
neutral cross-tool path (Antigravity, Cursor, opencode, Zed all read it), so that install
target reaches more agents than its id suggests. 702 tests green, both workspaces build.

**Known gaps after this round:** Antigravity hooks (`.agents/hooks.json`, unique
hook-name→event→matcher nesting; its exit-code/stdout-injection contract is undocumented,
so only the *signal-recording* half is safely shippable — the advisory half is unproven).
opencode has MCP (`opencode.json`, key `mcp`) and reads `.agents/skills/` — a cheap next
add. GitHub Copilot/VS Code (`.vscode/mcp.json`, key `servers`) is absent from the registry
entirely, so it is invisible to detection, routing, and `/api/agents/:id`.

### Session 18 — KB health in doctor, drift guard, a "flaky" test that wasn't

**`baton disconnect` — built, then reverted. Decision worth keeping.** `connect` writes
two `$HOME` files with no undo, which looked like a real gap. It isn't worth automating.
Subtracting from a config is categorically riskier than appending to one: appending never
has to understand what is already there. The removal path produced 7 bugs in ~270 lines,
and two of them damaged files — a `0600` config silently widened to `0644` by tmp+rename
(`~/.codex/config.toml` can hold API keys), and a TOML file *corrupted past parsing* when
a multi-line string contained a line reading `[mcp_servers."baton"]`, because Node has no
TOML parser and text surgery cannot know it is inside a string. A third: global configs
are shared across repos, so disconnecting from one repo removed another's graphify
servers. For a command run once in a project's lifetime, whose manual alternative is
deleting three lines, that risk isn't worth carrying. **If this is ever revisited: JSON is
fine (real parser, fails closed) — it is TOML that must be propose-only.**

**KB health in `baton doctor`** (`src/kb/health.ts`) — doctor audited junk only, so it
printed `✓ no junk found` while this repo's `kb.json` had pointed at
`~/Freelancing/baton` for 41 days, a directory with no `graph.json` in it. `loadKb`
knew (it skips the project and warns once on a 2s poll path) but nothing diagnosed it.
Now reported as errors with fixes: root built for another repo, project outside the
repo / missing / graphless, empty project list, missing merged graph. Staleness is a
*warning* — an old graph is still usable. A missing kb.json is info, not failure.
Read-only, like `doctor --docs`.

**Drift guard** (`test/agent-map-drift.test.ts`) — `web/src/lib/api.ts` hand-mirrors
`mcpTargetFor` (two tsconfigs, no monorepo tool). Adding an agent to one side only is
silent: the daemon wires it while the UI calls it unsupported. The test parses both and
compares; verified it fails on induced drift, not just on paper.

**Platform support documented** (SETUP.md) — macOS/Linux/WSL2 yes, native Windows no,
with the reasons (`ps`/`lsof`, `/proc/<pid>/cwd`, `commonBinDirs` returning `[]` on
win32). It had appeared in no doc at all.

718 tests green, both workspaces build.

### Session 19 — the task pipeline: phases, plans, apply

Phase 0 (six fixes) and phase 1 (`src/pipeline.ts`) shipped earlier this round. This
entry covers the plan layer.

**Plans are markdown, and applying one is a three-way merge.** `src/plan.ts` parses and
validates; `src/plan-apply.ts` diffs the file against the board against whatever an agent
is holding right now; `baton plan check|apply` is the surface. Both modules are pure, so
every rule below is a unit test rather than a fleet run.

Two rules carry the design. **Finished work is never rewound** — a re-applied plan that
edits a `done` task is reported and skipped, because the plan states intent and history
states fact. **Removal is not deletion** — dropping a task that never materialized removes
a row, but dropping one with a branch and a worktree *cancels* it; deleting would orphan
the worktree with nothing left pointing at it. An edit landing under a working agent needs
`--force`; a slug owned by another plan is refused outright, `--force` included, since both
rows resolve to the same `baton/<slug>` branch.

Validation is all-or-nothing (every problem at once, nothing applied) and includes the gap
the design review found: **two tasks in the same phase may not claim overlapping scope**.
The barrier gates *between* phases and does nothing *within* one — and within a phase is
exactly where parallel agents run.

**Four bugs found by probe, not by reading**, all in the parser as first written:
- A task heading matched only `\S+`, so `### add auth schema` failed the regex, became
  indistinguishable from prose, and **the task and everything under it vanished with no
  issue raised** — a plan that applies "successfully" while missing work.
- `## Phase two` (spelled out) parsed as prose, so every task under it joined the
  *previous* phase — serialized work silently running in parallel.
- `scopesOverlap` used a bare `startsWith`, so `src/db` covered `src/dbutil.ts`. Overlap
  is a hard error, so the false positive rejected good plans.
- `@../../etc/passwd` was kept verbatim as an assignee.

Each fix was mutation-verified (revert → exactly the intended test fails → restore). Two
mutations initially *survived* the conflict tests, which meant the tests were weaker than
the code; the half-applied case (`one slug conflicts, the rest are fine → write nothing`)
was added to close it.

`mutateTasks` (src/store.ts) is new: read-modify-write of the whole list under the lock,
because `loadTasks` then `saveTasks` from a command is a lost update against a running
daemon — and the diff has to be decided against the list about to be overwritten. `--dry-run`
is the same code path with the write suppressed, so what is shown is what happens.

Plans live in tracked `baton/plans/` (see its README), not `.baton/` — in team mode that
directory is how a teammate's plan arrives. Plan files are inert data: nothing in them is
ever executed, which is what makes applying a plan that arrived over git safe. Their prose
still reaches agent context, so it stays untrusted input.

**The board (`baton ls`) and `baton task add|rm`** finish phase 2. `ls` keeps its flat
table when nothing is phased and groups by phase once a plan is applied — complete /
open / locked behind — because "what may I start now" is the only question a five-agent
board is really asked. When nothing is eligible it says *which*: finished, or waiting on
a human. `task add` is the thing you noticed halfway through — same queued row, same
barrier, no plan file.

**Lazy worktrees exposed a board that lied.** `worktreeStatus` reports a *failed* git
call as `clean`, which was harmless when every task had a worktree. A queued task has
none, so every unstarted task rendered as a tidy checkout — and `collectStatus` spawned
git + agent detection per phantom path on the dashboard's 2s poll (a 40-task plan: ~80
subprocesses to produce that fiction). `isMaterialized` (baseCommit, not path existence)
now gates both; `collectStatus` carries worktree-backed tasks only, since queued work
belongs in the pipeline view. **Note for the UI phase:** a task whose worktree was
*deleted* still reads as `clean` — the same conflation, pre-existing, and fixing it means
touching `cleanup`/`rm` semantics that key off `state !== 'clean'`.

`task add` refuses an unknown or later-phase dependency (unsatisfiable is never what
anyone meant) but only *warns* on same-phase scope overlap — the same rule as a plan, in
a different room: a plan is applied unattended, this command has a human in front of it.

One test initially passed for the wrong reason — the temp repo was dirty from untracked
`.baton/`, so the "not clean" assertion held with the guard removed. Rewritten to assert
the placeholder positively against a deliberately dirty repo, and re-mutated.

1427 tests green, both workspaces build.

### Session 19c — lifecycle: claim, stall, pause, block

`baton next` · `baton take [--resume]` · `baton pause` · `baton block`. The transitions
live in `src/lifecycle.ts` as pure `(tasks, args) → tasks | refusal`, run inside
`mutateTasks` — so the check and the write happen against the same list under the lock,
and the claim race is a unit test rather than a hope. Verified with six real processes
racing one task: one winner, five correct refusals, contributor chain intact.

**Claim first, build second, roll back on failure.** The claim is written under the lock;
the worktree is created after, outside it, because it is slow. If git fails the claim is
released — a task stuck `claimed` with no worktree is worse than one never claimed:
invisible to `next` (not queued), useless to its holder, and holding its phase against
everyone else. A branch that already exists is never reused; it may hold someone else's
work.

**Liveness = max(heartbeat, newest worktree mtime)** (`src/liveness.ts`), per the spec's
correction to its own first draft: an agent running a 20-minute build makes no MCP calls
and is very much alive. The mtime walk is bounded (2000 entries, depth 6, skips
`.git`/`node_modules`/build dirs) and the cap can only make liveness look OLDER — so the
failure direction is refusing a takeover we might have allowed, which is the safe one.
The claim timestamp is a floor, so a task claimed a minute ago is never "silent for two
hours".

**`pause` is the honest counterpart to `done`.** An interruption must never be recorded
as a completion — a session that hits its limit hands the task back queued, worktree and
contributor history intact. `block` differs deliberately: it stays OWNED, because a
blocked task returned to the pool is a loop, not a queue.

`take` now serves both meanings of "pick up work" — a queued pipeline task is claimed, a
pre-pipeline row (no stored `state`) still reads its HANDOFF.md exactly as before.

**Bug found by racing real processes:** four of five losers fell through to the brief path
and printed "No HANDOFF.md" — which reads as *nothing here* when the truth is *occupied by
agent5*. Now they get the holder's name and the `--resume` hint. This is the third time
this session that a probe against real behavior found something reading the code did not.

1466 tests green, both workspaces build.

### Session 19d — the done gate

`baton done <slug>` on a pipeline task now runs the evidence gate (`src/evidence.ts`,
pure) and lands the task in `review` — or `done` when the plan wrote down that it opted
out. Baton still executes nothing: a plan file is inert data, which is what makes it safe
to apply one that arrived over git, so the gate verifies that work HAPPENED and is honest
that it cannot verify the work is right.

Hard refusals (facts about the repo, and `--force` cannot buy past them): **zero commits**,
uncommitted changes, conflict markers. Zero commits is the one that matters most — an
agent that ran out of context and reported success is the most expensive failure in a
five-agent pipeline, because every later phase then builds on nothing. Uncommitted work
refuses because a merge takes the branch, not the worktree.

Out-of-scope edits are **recorded, never refused** (`outOfScope` on the task): a real fix
often needs a line somewhere the plan did not predict, and refusing would only teach
agents to declare `**` and defeat the mechanism. `expects` becomes an agent
**attestation** — held until `--attest`, then labelled *"agent attestation — not verified
by baton"* so nothing downstream mistakes it for a test run.

A failed gate writes nothing: the task stays active and still owned, so a refused `done`
never leaves work in a half-finished state. Closing a task held by another agent is
refused outright — that is the "wrong task marked done" hallucination in its most
damaging form.

1490 tests green, both workspaces build.

### Session 19e — the review gate

`baton review approve|reject <slug>` gives the verdict, alongside the existing
save/list/show/resolve that record what a review *found*. The evidence gate proves work
happened; this is the only layer aimed at whether it is right, which is why
`requireReview` defaults on.

**The reviewer must not be a contributor** — enforced in `gateReview` (`src/lifecycle.ts`),
by agent id rather than session, so a fresh session does not launder authorship. No flag
gets past it: `--force` applies only to open findings, which is a judgement call, never to
who you are. A human running the CLI without `BATON_AGENT` is the intended escape hatch
for a one-agent fleet, and the refusal says so.

`--reject` returns the task to `active` with the reason on `reviewedBy.notes`; the branch,
worktree and contributor chain all survive, and `finishedSha` is dropped because it
recorded a head that is no longer accepted. A rejection with no reason is refused for the
same reason `block` refuses one — the agent would go back to work with nothing to change.
Approving over the review record's own open findings is refused too: two pieces of shared
state contradicting each other, and the next agent believes whichever it reads first.

`review` is deliberately non-terminal, so a task awaiting a verdict holds its phase exactly
like unfinished work (`◍` on the board, and `blockers()` says *"awaiting review — a
different agent must judge it"* instead of reporting it as work in flight).

Two gaps the tests found, both now closed in `baton next`:

- A **rejected task was invisible to its own author** — back to `active` and held, so
  nothing eligible ever picked it and `next` said "Nothing eligible". `next` now leads
  with the work you already hold, which also answers "do you have any pending task?"
  correctly for a session returning after an interruption.
- **Reviewing was not offered as work.** An idle agent was told the pipeline was quiet
  while a task sat in `review` holding the barrier. `reviewableBy(agent, tasks)` now
  surfaces it, filtered to agents who did not write it.

1518 tests green, both workspaces build. Eight mutations tested; each killed exactly its
own tests.

### Session 19f — a deleted worktree stops reading as a clean one

The bug flagged (and deferred) in 19b, now fixed at the root. `worktreeStatus` mapped
**both** "git could not answer" and "git says nothing changed" to `clean` — opposite facts
under one word. Reproduced first against real git: a path that had *never existed*
returned byte-identical output to a pristine checkout.

So a task whose worktree someone deleted was drawn as tidy on the board, in `baton ls`,
and in the dashboard (`STATUS_META[status] || STATUS_META.clean` rendered the unknown
status as a green **Clean** pill) — and `baton done` printed *"working tree clean"* about a
directory it had never read.

`WorktreeStatus.state` now has a fourth value, `missing`. The reason this was deferred is
that `cleanup` and `rm` both asked `state !== 'clean'` to mean "there is work here to
lose", so adding a state would have made them refuse to clean up a worktree *because it
was already gone*. Both now call `hasUnsavedWork(st)` — the question they were actually
asking — which is `dirty || conflict` and nothing else.

The done gate warns rather than refuses: the commits are the evidence and the branch
outlives the directory, so `finishedSha` falls back to the branch head. But it must not
print that a check passed when it never ran — that is the same confusion one layer up.

1528 tests green (+10). Four mutations tested, including restoring the original bug.

### Session 19g — the MCP surface (phase 4)

`my_tasks`, `take_task`, `complete_task`, `report_blocked` (`src/mcp-pipeline.ts`). These
are the same operations the CLI already exposes, reached from inside an agent's own
session — the difference between a pipeline a person drives and one the agents drive
themselves. They call the same lifecycle functions rather than re-deciding anything; a
second copy of "may I claim this" would drift, and the copy an agent reaches for is the one
that must not.

Two deliberate omissions: **no `force`** (an agent that can waive its own attestation has
no attestation — that stays a person's call in a terminal), and no plan editing.

**The tool-description budget went 2100 → 2800**, the one raise it has taken for a feature
rather than a convenience. Everything situational still costs nothing: each answer carries
its own next command, so the permanent per-session tax stays down to the trigger phrase.

**Cancellation notices** ride on the `reg()` wrapper. An agent inside a worktree has no
reason to look at the board again, so a task cancelled underneath it would be discovered at
`complete_task` — after the work. `groundMovedNotice` is pure and covers three cases: the
task was cancelled, the task is gone, or another agent adopted it while this one was quiet.

**Checkpoint diff-stamping** (§6.2): every `save_progress` is stamped with the repo as it
stood, and `checkpointFlag` fires when items move to completed with no commits and no
uncommitted changes behind them. Narrow on purpose — thinking, reading and failed
experiments are honest checkpoints, and a flag that cries wolf gets scrolled past. The flag
goes back to the agent that wrote it, at the one moment it can still correct the claim.

Probed through the real MCP server over stdio, not just the unit harness: 17 tools
register, `my_tasks` answers with the contract, `take_task` returns the worktree and the
work-only-here rule, `complete_task` refuses with the zero-commit check.

**A bug the probe found.** A plan field written as `- scope: src/**` was silently swallowed
into the description, and the task shipped with no scope — in a phase full of parallel
agents, exactly the collision scope exists to prevent. The asymmetry was the tell: an
unknown **bold** field already errored, so the stricter mistake was reported and the looser
one was not. Now refused, with the correction shown.

1553 tests green (+25). Six mutations tested; each killed exactly its own tests.

### Session 19h — lineage that lives in git (phase 5, part 1)

The storage model claims that losing `.baton/` costs nothing permanent, because
`baton history reindex` rebuilds the index from git. That was aspirational until now.

**`Baton-Task:` trailers** (`src/trailers.ts`, pure). Baton makes none of these commits —
agents do, with plain `git commit` — so the trailer comes from a `prepare-commit-msg`
hook (`src/hooks-git.ts`). One shared hook, deciding per invocation: linked worktrees
share `.git/hooks`, so it asks Baton at commit time which task owns the directory it is
running in and does nothing everywhere else, including the main checkout. It never
overwrites a hook it did not write, and exits 0 on every path — a hook that can block
`git commit` can strand an agent's work.

**`baton history reindex`** walks `baton/*` branches and honors a trailer only when its
slug names a task this repo created (§7.5). Forged claims are counted and shown, not
silently dropped: something writing trailers for tasks that do not exist is worth seeing.

**Lineage now distinguishes landed from in-flight.** Reindex walks branches, so the index
holds real commits that are NOT on main. `who_touched` returns those under
`onBranchNotYetMerged`, and `baton history` marks them — an agent told a file "was
changed" that assumes the change landed builds against code nowhere it can see.

Three bugs found by probing rather than reading:

1. **The hook installed itself into the repository root.** Baton's own git hardening sets
   `core.hooksPath=` so its calls never fire repo hooks — and that override makes
   `rev-parse --git-path hooks` answer `./`. The file was written where nothing runs it,
   and nothing reported a problem, so the install looked like it worked. `hooksDir()` now
   uses `--git-common-dir`, and `gitConfigValue()` (new, in `util/exec.ts`) reads a config
   key with our own override for that key dropped — which is also what makes a husky-style
   `core.hooksPath` visible at all.
2. **`branchCommits` read `%s`** — the subject only — so the trailer in the body was
   invisible to the one reader that needed it. It now carries `body` as a separate field;
   `message` still means the subject for every existing caller.
3. **`recordMerge` inserted file rows unconditionally**, so every reindex added another
   copy of every file. Invisible at merge time, where each commit is new by construction.

1573 tests green (+20). Seven mutations tested, including restoring the exact hooks-path
bug, which failed four tests.

### Session 19j — the integration barrier (phase 5, part 2 — phase 5 complete)

A phase is not over when its last task is marked done; it is over when its work is on the
base. Between those moments the branches exist only side by side, and two can each be
correct while still not composing.

Chosen shape (user's call): **detect automatically, integrate on command.** The barrier
checks and never writes; `baton integrate [phase] [--dry-run]` is the only thing that
moves the base branch. Auto-merging into someone's base on a 2s poll was the rejected
alternative.

- `src/pipeline.ts` — `integrationHold()`; `openPhase(tasks, opts)` now holds at a
  finished-but-unlanded phase. Pure: the git fact arrives as injected `integrated(phase)`,
  the same shape as `isFetchable`. Omitting it keeps the old behaviour exactly.
- `src/git.ts` — `trialIntegrate()` on `git merge-tree --write-tree`, **cumulative**: each
  branch trialled against the previous result. Per-branch-vs-base would miss the spec's own
  example (two branches clean alone, conflicting together) and open the next phase on a base
  that never built. Writes nothing — no branch, no index, no working tree.
- `src/integrate.ts` — `integratedPhases()` precomputes the answer so gating stays sync.
- Wired into `next`, `take`, `my_tasks` and `take_task` — advisory surfaces AND the two
  paths that actually start work.

Two bugs, both found by running the flow, neither by the unit tests:

1. **The trial commit carried one parent.** With no ancestry link to the branch just
   merged, the next step computed its merge base against the original base — so a branch
   rebased or merged onto an earlier one in the same phase (the ordinary way people resolve
   this) read as conflicting forever, with nothing the user could do to clear it.
2. **Integration squashed.** A squash copies content and keeps no link, so the trial passed
   and the real merge conflicted, leaving the phase HALF-INTEGRATED — the one outcome the
   command's own comment called worst. Now a true merge, which also keeps the `Baton-Task:`
   trailers on the base that phase 5 part 1 built `history reindex` around.

1593 tests green (+16). Verified end to end in a real repo: barrier holds, `--dry-run`
names the conflicting branch and file with `main` untouched, resolution accepted,
both branches landed, phase 2 offered.

**Deviation from spec §9:** one commit per task, not one per phase. A phase-wide squash
would land the work and lose which task produced it.

### Session 19k — phase 6 started: reachability (spec §13 open question 2)

`isFetchable` and `pushedSha` existed only inside pipeline.ts — a contract with **no
producer and no consumer**. `done` on a teammate's laptop does not mean the commits are
here, and starting against them builds on code no other machine has.

Built the answering half, which is the part with a real difficulty: the naive shape is a
network call per task per query, while `baton next` runs on every agent's turn and the
board polls every 2s.

- `src/git.ts` — `defaultRemote()`, `fetchRemote()` (offline is normal, not an error),
  `remoteContains()`. The last is `git branch -r --contains`, deliberately NOT "does the
  object exist locally": after a fetch our own unpushed commits are present too, and a
  yes there is exactly the false positive that matters.
- `src/fetchable.ts` — `fetchableProbe()`: one fetch per repo per 30s, then every task
  answered locally. **Positive answers cached, negative never** — remembering "no" would
  hide a teammate's push for the life of the process, which looks identical to a wedged
  pipeline. Solo repos return null so nothing is gated and behaviour is unchanged.

1599 tests green (+6), including the two that matter: an unpushed local commit reads as
not fetchable, and a push becomes visible after the TTL.

**Deliberately NOT wired into the gate yet.** Nothing writes `pushedSha`, so turning
`isFetchable` on now would mark every dependency "waiting to be pushed" and wedge every
team plan. The producer comes first.

### Session 19m — the barrier was advisory: enforce it where the write happens

Both gates were enforced only where work is *offered*. `baton next` refused a task in a
locked phase; `baton take <that same slug>` claimed it and built its worktree. Reproduced
before touching anything, on a two-task probe repo.

The cause is one line. `claim()` in lifecycle.ts takes `EligibilityOpts` and its own doc
comment says the barrier "is only worth anything if it is enforced at the moment of the
write" — and every caller passed `{}`. The intent shipped; the wiring did not.

- `src/gate.ts` (new) — `resolveGate(root, tasks)`, the one place the two git-backed
  predicates are assembled. Four call sites had been hand-rolling their own; that is how
  one of them ends up with half a gate, which is exactly what happened.
- `src/commands/claim.ts` — resolves the gate before the lock and passes it to `claim()`.
  Every path into the pipeline (CLI `take`, MCP `take_task`) goes through here, so this is
  the chokepoint rather than four enforcement points that must be kept in step.
- `src/lifecycle.ts` — the refusal now carries the *cause* (`blockers()`'s reason) instead
  of "not startable yet — see: baton next". Both new causes name a command and neither is
  guessable.
- `src/commands/next.ts`, `src/commands/take.ts`, `src/mcp-pipeline.ts` — collapsed onto
  `resolveGate`. `my_tasks`'s `waitingOn` was ungated, so its explanation omitted precisely
  the two causes an agent cannot see for itself.

`test/claim-gate.test.ts` (new, 5 tests) against real repos, both directions: refuses a
locked phase and an unpushed dependency, allows both once cleared, and gates nothing in a
repo with no remote. Mutation-tested — dropping the gate kills exactly the two "refuses"
tests and leaves the three "allows" green.

Measured, since this adds git calls to every claim: `resolveGate` is 57ms cold / 20ms warm.
An earlier 0.7s reading was machine load, not the gate.

1610 tests green (+5), 136 files, 57s on a quiet machine — the same suite that had just run
red twice under load, which is what settled the flakiness question below.

**Phase 6 remaining:** memory migration to `baton/`; operator/member split per §7.6;
claims fail-closed.

### Session 19n — §7.6: the operator/member split on the CLI

`src/access.ts` answers "who are you" for the daemon, from a token. The CLI has none —
whoever is at the machine is the caller — so the question a command can actually ask is
*whose plan is this*, and `.baton/host.json` settles it: its presence means this repo's
plan comes from someone else's hub.

The failure being prevented is a **silent fork**, not an escalation. A member who runs
`plan apply` locally rewrites their own tasks.json while the hub's stands; from then on
the two machines coordinate against different plans, agree on nothing, and nothing
reports an error.

- `src/operator.ts` (new) — `decideOperator()` (pure) + `requireOperator()`. Wired into
  the three operator-only commands that exist today: `plan apply`, `task rm`, `integrate`.
- `integrate --dry-run` stays open to members. The trial writes nothing and tells them
  only what `git merge-tree` on branches they already hold would. What is the operator's
  alone is landing it on the shared base.
- No `--force`. An escape hatch on an authorization gate is the gate, and this is a
  surface agents call; `baton host clear` is the explicit way out and the refusal says so.

**Correction to 19l/19m:** those notes claimed `baton push` is operator-only in §7.6. It
is not in that table at all, and it must not be — a member finishing a task and publishing
it is the whole mechanism team mode exists for. Gating it would wedge every cross-machine
plan. Verified a member can still `take` and `push`.

Also not yet built, so not gated: `cancel` and `phase open --force` (phase 8). The MCP
surface needs no check — it never exposed plan editing, by the design note in
`mcp-pipeline.ts`.

`test/operator-gate.test.ts` (8 tests) covers the rule *and* the wiring, the latter by
driving the real commands and asserting the repository afterwards — the pure tests alone
would all pass with the gate called from nowhere, which is the 19m defect exactly.
Mutation-tested at all three call sites. The first pass at the `task rm` test **survived**
its mutation: it pointed at a `done` task, which `task rm` refuses on its own merits, so
it was watching the wrong refusal. Re-pointed at a queued, unmaterialized task.

1618 tests green (+8), 137 files, 36s.

### Session 19l — `baton push`: the producer, and the CI guard (§7.4)

The gate from 19k is now live end to end.

- `src/commands/push.ts` — `baton push [slug] [--allow-ci]`. Pushes the branch, records
  `pushedSha`, clears the fetchable cache so the next `baton next` sees it immediately,
  and names the tasks that were waiting.
- `src/git.ts` — `refSha()`, `pushBranch()` (never `--force`: a force-push from an
  automated path can destroy a teammate's commits, and nothing here needs one).
- `isFetchable` wired into `baton next`.

**§7.4, the CI guard.** A task scoped to CI config + an agent that edits it + a push is
remote code execution on the runner. `ciPaths()` covers GitHub Actions, GitLab, CircleCI,
Jenkins, Azure, Bitbucket, Drone, Travis and Buildkite; anchored, so `vendor/.travis.yml`
cannot trip it. On by default **for every caller** — `baton push` is a CLI command and
agents run CLI commands, so a guard that only covered some future "auto" mode would miss
how this actually gets invoked. Also re-checks state at push time: a cancelled task cannot
publish, because stopping work is only real if it also stops the work leaving the machine.

Verified live against a bare remote: dependent blocked with *"waiting for 'schema' to be
pushed"* → `baton push schema` → dependent offered. CI guard refused with the remote still
holding only `refs/heads/main` (nothing published), then `--allow-ci` pushed and warned.

Fixed while probing: the PIPELINE STALLED message listed nothing and advised "resolve a
blocker, or cancel a task" when the real fix was a push — it now prints `baton push <slug>`
and says nothing is wrong, it just has not been published.

1605 tests green (+6).

**Note on suite flakiness (likely the long-standing "1 failure in ~7 runs").** Under CPU
load, timeout-bounded tests fail: observed 2, then 8, then a *different* 8 and a *different*
9 across consecutive runs at 96–233s wall clock against ~70s clean. Every failing file
passes in isolation, and the set of failures moves between runs — which is the signature.
Not a logic bug; the suite is sensitive to machine load. Worth a timeout review before
trusting a red run.

The cause is NOT the graphify rebuild the commit hook launches — that was 19l's guess and
it was wrong. Traced in 19m to something entirely outside this repo: `~/.claude/statusline.sh`
shells out to `ccusage statusline` on every statusline render, and each invocation spikes to
400–800% CPU. Load average was 118–126 with nothing of Baton's running. That is a per-turn
cost on any agent session in any project, which fits the symptom nobody could pin down — the
suite goes red on whichever timeout-bounded tests happen to overlap a render.

Before blaming a red run on anything in here: `ps -Ao pcpu,pid,comm -r | head`. If the set
of failures moves between runs and each file passes in isolation, it is this.

### Session 19i — three bugs nobody's tests were watching

Each one reproduced before it was touched; each guard mutation-tested.

1. **The board didn't show agents Baton itself started.** `detectAgents` memoizes its ps
   scan for 5s while the poller ticks every 2s, so a just-started run read as nobody's for
   up to five seconds — and a print-mode run shorter than that never showed as working at
   all. The Agents screen was right the whole time; it already merges `runningHeadless()`.
   `collectStatus` now does too (scan first, headless second — roster.ts's precedence, so
   one agent can't get two names on two screens). The first test **passed unfixed**: the ps
   scan caught the test's own `node` child. Warming the cache first reproduced it properly.
2. **The published package shipped without a dashboard.** `files` listed only `dist` while
   `baton serve` resolves `../web/dist`. Adding `web/dist` alone did nothing — with no
   `.npmignore` in `web/`, npm falls back to `web/.gitignore`, which ignores `dist/`, and
   an allowlist does not override a nested ignore file. `npm pack --dry-run` said 0 web
   files before, 4 after. Both halves are needed and both are guarded by
   `test/packaging.test.ts`, which asks npm rather than asserting on config.
3. **Every install doc named a Node floor four majors too low.** package.json, SETUP.md and
   installation.md say ≥ 24 (the floor is `node:sqlite` + FTS5); seven other places said 20
   — including `AGENTS.md`, which the new landing docs page calls the source of truth.
   Fails silently both ways: `ensureFts` falls back to a weaker LIKE scorer without a word,
   and installing from source never enforces `engines`. All seven corrected across both
   repos; the one hit in a dated plan doc left alone rather than rewrite what was believed
   then.

1577 tests green (+2, +1 file). Closes pending items 1 and 5.

## Pending / next 🔜

0. **Task pipeline — phases 1–5 done.** Plans + apply, board, `task add`, lifecycle,
   the done gate, the review gate, the MCP surface (`my_tasks`, `take_task`,
   `complete_task`, `report_blocked`), `Baton-Task:` trailers + `history reindex`, and
   the integration barrier. **Phase 6 is most of the way there**: `baton integrate`,
   `baton push` + the §7.4 CI guard, `isFetchable` wired and enforced at the claim, and
   the §7.6 operator/member split. **Remaining: memory migration to `baton/`, and claims
   fail-closed.** Then **phase 7 — UI** (phase swimlanes, markdown plan view, cancel
   controls with blast radius, demo fixtures kept working). Spec:
   `docs/superpowers/specs/2026-08-05-task-pipeline-design.md`.

1. **Rename to "Baton Lane" — decided 2026-08-06, not yet done.** `baton-cli` on npm is
   taken by `quabug/baton` ("Git-backed session handoff for Claude Code"), so the npm
   name has to change. Checked before deciding: that package is 31 downloads/month, 0
   stars, 0 forks, 15 versions published in one 4-hour burst on 2026-03-15 and untouched
   since — a dead weekend project, so the branding collision is theoretical and there is
   no reason to abandon the Baton identity. Bare `baton` on npm is a 2013 v0.0.0
   placeholder (disputable via npm policy if ever wanted; `baton-cli` is not).

   The change is deliberately small: **npm name → `batonlane`, and nothing else.** The
   typed command stays `baton` — `bin` and package name are independent, and at 31
   downloads/month there is no realistic collision. `.baton/` on disk keeps its name so
   no existing install breaks. "Lane" was chosen over the alternatives because it is
   legible to developers without explanation and already matches the product: phase
   **swimlanes** are in the phase-7 UI spec below.

   To do: `name` in package.json, README/docs/AGENTS.md references, the landing site,
   and the domain (`batonlane.com` + `.io`, GitHub `batonlane` — all free as of today).
2. **tmux test-environment caveat** (2026-06-12): a daemon launched inside a
   sandboxed wrapper (e.g. the IDE preview helper) can wedge the shared tmux server
   (orphaned control client stops draining → every tmux command on the machine
   hangs). Hardening added: control clients attach with `-d` (kick stale clients),
   all one-shot tmux calls have a 10s timeout, errors surface as clean 4xx/503.
   Normal usage — `baton serve` run from a real terminal — is unaffected (verified
   end-to-end). If tmux ever wedges: `pkill -f 'tmux -C attach' && rm -rf /tmp/tmux-$UID`.
3. **Visual pass** — confirmed in-browser 2026-06-12: Launch 3-way start mode (radio
   group, Preview badge clears on real modes), real claude TUI rendering in the Live
   Terminal tab via SSE, keystrokes from the browser moving the TUI selector, tmux
   session create/adopt/kill from the UI. Still pending a look when Chrome MCP is up:
   Handoff "suggested" chip (demo-verified earlier).
4. **Non-Claude token usage** — codex/gemini session formats aren't parsed yet
   (src/usage.ts is Claude-only); their sessions show no token data.
5. **Fleet broadcast** (Daintree-style: one prompt → N sessions at once) — researched,
   deferred by user choice this round.
6. **Roadmap (MVP.md)** — M3 redaction-first secret stripping for safe export; M4 link
   sharing + permissions (hosted phase).

## Where things live

```
src/cli.ts            CLI registration (kb, pass/take/done, hooks, mcp, signals, blame…)
src/server.ts         daemon: /api/* + SSE /api/events + static dashboard serving
src/events.ts         transport-agnostic event bus (ring buffer for SSE replay)
src/watch.ts          per-worktree recursive fs watcher → file.edited events
src/poller.ts         daemon-side status differ (runs only while SSE clients exist)
src/signals.ts        live edit signals + checkFiles (the wait/coordinate layer)
src/reports.ts        completion reports (built at merge time)
src/mcp.ts            `baton mcp` stdio server (check_files, get_report, who_touched…)
src/skills/           skill catalog + install/import; bundled/<id>/ = file-backed multi-file skills (SKILL.md + references/)
src/agents/           agent registry (one entry per CLI) + roster + MCP connect
src/kb/               graphify wrapper, sub-project detection, kb state, MCP snippets
src/kb/codebasemd.ts  CODEBASE.md generation (tree, stack, god-nodes, staleness footer)
src/kb/transfer.ts    KB export/import/share (tar pack, re-anchor, committed kb/ dir)
src/routing.ts        task-type → agent routing (baton.config.json, keyword scoring)
src/usage.ts          real token usage from Claude session JSONLs (+ cost estimates)
src/spawn.ts          headless agent runs (claude -p / codex exec / gemini -p)
src/handoff/          Claude JSONL session parser + HANDOFF.md brief builder
web/src/lib/connections.ts   daemon connections (real project switcher)
web/src/hooks/useEvents.ts   SSE client hook
web/src/features/            one file per screen; KnowledgeGraph.tsx is the graph page
.refs/                reference open-source code (graphify etc.) — gitignored, learning only
```

**Demo mode is the showcase, not a bug**: default ON only on the Vite dev origin
(`:5173`); the daemon-served UI (`:7077`) is real by default. Real-mode changes must be
gated on `BatonAPI.demo` so the demo keeps working.
