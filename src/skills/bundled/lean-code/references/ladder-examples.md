# Ladder examples — before/after

Each pair is the *same task*, over-built vs lean. The lean version names what it skipped and
when you'd add it back.

## Email validation

- **Over-built:** a 70-line RFC 5322 parser, a DNS MX lookup, a confirmation-email flow.
- **Lean:** one regex that catches fat-fingered addresses.
  ```python
  import re
  def is_valid_email(s: str) -> bool:
      return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", s))
  ```
  Skipped: full RFC parsing + MX lookup. Add them only when you must reject
  `user+tag@sub.domain.co.uk` correctly or catch typo'd domains — until then this covers 99% of
  "oops".

## Debounce

- **Over-built:** a `Debouncer` class with options for leading/trailing edges, max-wait, and
  cancellation you don't use.
- **Lean:** the closure that does exactly what's needed.
  ```js
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  ```
  Skipped: leading-edge + maxWait. Reach for `lodash.debounce` the day you actually need them.

## "Make this configurable"

- **Over-built:** a config file, a loader, a schema validator, and env-var overrides for a single
  boolean nobody has asked to change.
- **Lean:** a named constant at the top of the file. Promote it to real config the first time a
  second caller needs a different value — not before (rung 1, YAGNI).

## Reuse over rewrite (rung 2)

- **Over-built:** a fresh `slugify()` because you didn't look.
- **Lean:** `grep -rn "slug" src/` (or query the knowledge graph) first — the repo already has
  one. Import it. Re-implementing what's a few files over is the most common slop.
