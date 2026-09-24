# External seats (opt-in)

A seat answered by a different model family (OpenAI, Google) brings training and failure modes
Claude does not share, so the spread of views is real rather than simulated — and it sends your
brief to a third party. So external seats are **never default**, **never silent**, and **never sent
secrets**.

The approach below — prefer a provider's CLI, fall back to its HTTP API with keys from the
environment, and keep going when one provider fails — is adapted from
[gcpdev/llm-council-skill](https://github.com/gcpdev/llm-council-skill) (© 2026 Gustavo Publio,
MIT; full notice in Baton's source at `src/skills/bundled/llm-council/NOTICE` and at the
upstream repository). No scripts ship with this skill; run the commands directly.

> **Why a skill scanner flags this file.** Baton's content scanner reports `credential-access`
> on the lines below that name the providers' key variables and tell you to scrub secrets from the
> brief. Nothing here reads, prints or stores a credential value: the commands only test whether a
> variable is set and pass it in a request header. Those findings are expected.

---

## ⛔ Before the first external call

1. **Ask.** "This will send the council brief (not the repo) to <provider> via <CLI/API>. OK?"
   Proceed only on an explicit yes. The consent covers this council run only.
2. **Scrub.** Re-read the brief for API keys, tokens, passwords, private URLs with credentials,
   `.env` values, customer data, and internal hostnames the user would not publish. Replace with a
   description of shape (`DATABASE_URL=<postgres url>`).
3. **Send the brief, not files.** An external seat without repo access answers from the brief
   alone, so its claims default to `[unverified]` unless the brief's GROUNDING already verified
   them.
4. **Mention cost.** API calls bill the user's account; a CLI may consume their plan quota. Deep
   councils with review make several calls per provider.

---

## Detect what is available

```bash
command -v codex  >/dev/null && echo "codex CLI available"
command -v gemini >/dev/null && echo "gemini CLI available"
[ -n "$OPENAI_API_KEY" ] && echo "OpenAI key present"
[ -n "$GEMINI_API_KEY" ] && echo "Gemini key present"
```

Never print key values. **A provider that is not available is never seated** — use a subagent
seat for that lens from the start, and tell the user what would enable the provider next time
(install a CLI or export a key).

---

## CLI path (preferred)

Write the filled member prompt to a temp file and pass it on stdin, so shell quoting cannot mangle
it and the prompt does not land in the process list:

```bash
# OpenAI Codex CLI — non-interactive, read-only sandbox, prompt read from stdin ("-")
codex exec --sandbox read-only - < "$PROMPT_FILE"

# Google Gemini CLI — non-interactive; piped stdin is used as the prompt
gemini -p "" < "$PROMPT_FILE"
```

These CLIs are agents that can read their working directory: keep the read-only sandbox, or run
them from an empty temp directory. Use a timeout (e.g. 120 s) so a hung
seat cannot stall the council. Flags change between CLI versions — if a command errors, check
`codex --help` / `gemini --help` rather than guessing.

---

## API path (fallback)

Keys come from the environment only (`OPENAI_API_KEY`, `GEMINI_API_KEY`). The model comes from
`OPENAI_MODEL` / `GEMINI_MODEL`; if unset, ask the user which model to use and set it for the
command — the snippets below stop with an error rather than guess. Record the model in the
transcript. Do not hard-code keys in commands that land in shell history or transcripts.

**OpenAI** (chat completions):

```bash
jq -n --arg m "${OPENAI_MODEL:?set OPENAI_MODEL}" --rawfile p "$PROMPT_FILE" \
  '{model:$m, messages:[{role:"user", content:$p}]}' |
curl -sS --max-time 120 https://api.openai.com/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: application/json" -d @- |
jq -r '.choices[0].message.content // .error.message'
```

**Gemini** (generateContent):

```bash
jq -n --rawfile p "$PROMPT_FILE" '{contents:[{parts:[{text:$p}]}]}' |
curl -sS --max-time 120 \
  "https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL:?set GEMINI_MODEL}:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" -H "Content-Type: application/json" -d @- |
jq -r '.candidates[0].content.parts[0].text // .error.message'
```

The key travels in a header, not the URL, so it does not appear in logs that record URLs.

---

## When a seat fails

One rule, same as SKILL.md Phase 3. A seated external seat that fails at run time (non-zero exit,
API error, timeout, empty reply, or a reply too far off-template to recover a position):

1. Record the provider and the error (redact anything key-like). Do not retry more than once.
2. **Continue with the remaining seats** and label the gap:
   `degraded: external seat <provider> failed (<reason>)` in the run header and the transcript.
3. **Only if fewer than 3 members remain**, re-seat the missing lens once as a `subagent` (or
   `inline` if the host has no subagents), labelled `backfill for <provider>`.
4. If that still leaves fewer than 3 answers, stop without a verdict.

(Unavailable providers never reach this point — they are not seated; see "Detect".)

---

## Recording external seats

In the transcript, each external seat lists: provider, access path (`cli` / `api`), model name as
reported or configured, and whether it also reviewed (if it did, its own letter
is left out of its ranking). In the verdict, attribute distinctive points
to the seat that raised them — part of an external seat's value is knowing which model family saw
what.
