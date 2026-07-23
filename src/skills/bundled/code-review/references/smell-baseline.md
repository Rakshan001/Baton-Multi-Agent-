# Smell baseline — the Standards axis fallback

Twelve classic code smells (Fowler, *Refactoring*, ch. 3). This baseline applies **even in a repo
that documents no conventions at all**, which is why the Standards axis always carries it.

Two rules bind it, and they are not optional:

- **The repo overrides.** A documented repo standard always wins. Where the repo endorses
  something this list would flag, suppress the smell — don't report it.
- **Always a judgement call.** Every entry here is a labelled heuristic ("possible Feature Envy"),
  never a hard violation. Only a documented standard can be breached outright.

Also skip anything the project's tooling already enforces — a linter's job is not review's job.

Each entry reads *what it is* → *how to fix it*. Match them against the diff, not the whole repo.

| Smell | What it is | How to fix |
| --- | --- | --- |
| **Mysterious Name** | A function, variable, or type whose name doesn't reveal what it does or holds. | Rename it. If no honest name comes, the design is murky — that's the real finding. |
| **Duplicated Code** | The same logic shape appears in more than one hunk or file in the change. | Extract the shared shape; call it from both sites. |
| **Feature Envy** | A method that reaches into another object's data more than its own. | Move the method onto the data it envies. |
| **Data Clumps** | The same few fields or params keep travelling together — a type wanting to be born. | Bundle them into one type; pass that. |
| **Primitive Obsession** | A primitive or string standing in for a domain concept that deserves its own type. | Give the concept its own small type. |
| **Repeated Switches** | The same `switch` / `if`-cascade on the same type recurs across the change. | Replace with polymorphism, or one map both sites share. |
| **Shotgun Surgery** | One logical change forces scattered edits across many files in the diff. | Gather what changes together into one module. |
| **Divergent Change** | One file or module is edited for several unrelated reasons. | Split it so each module changes for one reason. |
| **Speculative Generality** | Abstraction, parameters, or hooks added for needs the spec doesn't have. | Delete it; inline back until a real need shows up. |
| **Message Chains** | Long `a.b().c().d()` navigation the caller shouldn't depend on. | Hide the walk behind one method on the first object. |
| **Middle Man** | A class or function that mostly just delegates onward. | Cut it; call the real target directly. |
| **Refused Bequest** | A subclass or implementer that ignores or overrides most of what it inherits. | Drop the inheritance; use composition. |

## Reporting format

For each smell found, the Standards sub-agent should emit:

```
possible <Smell Name> — <file>:<line>
  <the hunk, quoted>
  → <the one-line fix from the table above, applied to this case>
```

And for a documented-standard breach (which *is* a hard violation):

```
VIOLATION: <standard file> — "<the rule, quoted>"
  <file>:<line>
  <the hunk, quoted>
```

Keep the two visually distinct. A reader must be able to tell at a glance which findings are
binding and which are opinion.

## What is NOT a finding

- Formatting, import order, or quote style — the formatter owns those.
- A smell the repo's own standards explicitly endorse.
- Pre-existing code the diff merely moved without changing.
- Style preferences with no documented standard and no entry in this table.
