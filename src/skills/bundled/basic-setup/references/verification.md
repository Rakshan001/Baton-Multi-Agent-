# Verification — evidence, not claims

Run every check and **show the output**. A claim without output is a failure, not a summary.
If a check fails, fix it or report it explicitly. Never describe unverified work as done.

## Checklist

```
[ ] 1. dependencies install cleanly
[ ] 2. the project builds / the dev server boots
[ ] 3. lint and format run without crashing
[ ] 4. the example test passes
[ ] 5. .env is ignored and .env.example is tracked
[ ] 6. no secret is already in git history
[ ] 7. PLANTED-SECRET DRILL — a fake key is provably blocked   ← the one that matters
[ ] 8. STRUCTURE.md and AGENTS.md exist and name the real folders
```

## 1-4 — it actually runs

| Stack | Install | Build / boot | Test |
|---|---|---|---|
| Next.js | `npm install` | `npm run build` | `npm test` |
| React+Vite / Nuxt | `npm install` | `npm run build` | `npm test` |
| NestJS | `npm install` | `npm run build` | `npm test` |
| Express | `npm install` | `npx tsc --noEmit` | `npm test` |
| Django | `pip install -r requirements.txt` | `python manage.py check` | `pytest` |
| FastAPI | `pip install -r requirements.txt` | `python -c "import app.main"` | `pytest` |

A build that fails is not "mostly working". Fix it or report it as broken.

## 5-6 — secret hygiene

```bash
git check-ignore -v .env          # must print a match → .env is ignored
git ls-files --error-unmatch .env.example   # must succeed → example IS tracked
git ls-files | grep -E '(^|/)\.env$' && echo "FAIL: .env is tracked"
gitleaks git --redact --verbose   # full history — must find nothing
```

If history contains a secret, **report it as urgent and tell the user to rotate the key.**
Installing a hook does not fix an already-leaked credential.

## 7 — The planted-secret drill

This is the only check that proves the hook actually fires. "gitleaks is installed" can be true
while the hook never runs — that is exactly the failure that leaks a key.

```bash
# Use a canary that matches a real detector but is not a real credential.
printf 'AWS_ACCESS_KEY_ID=AKIA2E0A8F3B244C9986\n' > .baton-hook-canary.tmp
git add .baton-hook-canary.tmp

if git commit -m "canary: this commit MUST be blocked" >/dev/null 2>&1; then
  echo "✗ DRILL FAILED — the commit went through. The hook is NOT protecting this repo."
  git reset --soft HEAD~1
else
  echo "✓ DRILL PASSED — commit blocked by the pre-commit hook."
fi

# Always clean up, pass or fail.
git reset -q HEAD .baton-hook-canary.tmp 2>/dev/null || true
rm -f .baton-hook-canary.tmp
```

**Rules for the drill:**

- The canary is a fake key in a scratch file. It is never a real credential.
- Clean up on **both** paths — a stray canary file or staged entry is a failure of the drill.
- If the commit succeeded, the drill **failed**. Do not report the project as protected.
  Diagnose in this order: is `core.hooksPath` set correctly · is `.githooks/pre-commit`
  executable · is gitleaks on PATH · did a `.gitleaks.toml` allowlist swallow the canary.
- If the canary itself is allowlisted by the default ruleset, the drill proves nothing — swap in
  a different detector shape and re-run rather than accepting a silent pass.

## 8 — the docs match reality

Open `STRUCTURE.md` and `AGENTS.md` and confirm every path named in them exists on disk. A
structure document that references folders that were never created is worse than none — it
teaches the wrong layout to the next developer and to every agent that reads it.

## The report

State plainly:

```
CREATED       <files and folders>
VERIFIED      <each check with its result>
SKIPPED       <what, and why>
NOT PROTECTED <the honest list — see security.md § What is deliberately NOT solved>
NEXT          <three concrete things the user should do>
```

Then ask about committing. After they answer, ask **separately** about pushing. Approval to
commit is not approval to push.
