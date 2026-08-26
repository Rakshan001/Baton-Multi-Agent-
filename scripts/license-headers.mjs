// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every source file states who wrote it and under what terms.
 *
 * This is not bookkeeping. NOTICE invokes AGPL-3.0 section 7(b) to require that
 * the attribution survive a rebrand, and names the per-file headers as one of
 * the places it must survive. A requirement to preserve a header that was never
 * there is unenforceable — so a file shipped without one quietly widens the gap
 * a downstream can walk through, and "we did not know" gets easier to say.
 *
 * Run bare to check (CI does this and fails the build); run with --fix to add
 * what is missing. Both are idempotent.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const HEADER = ['// Copyright (C) 2026 Rakshan Shetty', '// SPDX-License-Identifier: AGPL-3.0-or-later']

const SOURCE = /\.(ts|tsx|mjs|cjs|js|jsx)$/
// Vendored, generated, or reference trees. `.refs/` in particular holds other
// people's open-source code for study — stamping our copyright on it would be a
// false claim, which is the exact failure this script exists to prevent.
const EXCLUDED = /(^|\/)(node_modules|dist|build|out|\.next|\.refs|coverage|graphify-out)\//

// A directive prologue ("use client", "use strict") must precede every statement
// in the file, and a shebang must be byte zero. A comment above either is legal,
// but bundler handling of a comment before "use client" has been inconsistent
// enough that it is not worth betting the RSC boundary on. Header goes after.
const SHEBANG = /^#!/
const DIRECTIVE = /^\s*['"]use (client|server|strict)['"]\s*;?\s*$/

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && SOURCE.test(f) && !EXCLUDED.test(f))

const fix = process.argv.includes('--fix')
const missing = []
const skipped = []

for (const file of tracked) {
  const raw = readFileSync(file)
  if (raw.length === 0) continue // an empty file carries no expression to protect

  // Decode/re-encode round trip. A file that does not survive it is not UTF-8,
  // and rewriting it here would corrupt bytes we do not understand.
  const text = raw.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    skipped.push(file)
    continue
  }

  // Already stamped — checking only the top of the file so that the word
  // "copyright" appearing in ordinary code below cannot count as a header.
  const lines = text.split('\n')
  if (lines.slice(0, 5).some((l) => /SPDX-License-Identifier|Copyright \(C\)/i.test(l))) continue

  if (!fix) {
    missing.push(file)
    continue
  }

  let at = SHEBANG.test(lines[0]) ? 1 : 0
  // Step over blank lines to find the first line that says something; if it is
  // a directive, the header belongs below it rather than above.
  let probe = at
  while (probe < lines.length && lines[probe].trim() === '') probe++
  if (probe < lines.length && DIRECTIVE.test(lines[probe])) at = probe + 1

  lines.splice(at, 0, ...HEADER)
  writeFileSync(file, lines.join('\n'))
  missing.push(file)
}

for (const file of skipped) console.warn(`skipped (not valid UTF-8): ${file}`)

if (missing.length === 0) {
  console.log(`license-headers: all ${tracked.length} source files carry attribution`)
  process.exit(0)
}

if (fix) {
  console.log(`license-headers: added attribution to ${missing.length} file(s)`)
  process.exit(0)
}

console.error(`license-headers: ${missing.length} source file(s) are missing the attribution header:\n`)
for (const file of missing) console.error(`  ${file}`)
console.error(`\nNOTICE requires this header be preserved. Run: node scripts/license-headers.mjs --fix`)
process.exit(1)
