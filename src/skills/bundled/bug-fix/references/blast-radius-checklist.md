# Blast-radius checklist

Goal: before editing, know **everything that depends on what you're about to change**, so a fix
can't silently break existing code.

Use whichever map your project has, in this order of preference:
1. A generated **dependency/call graph** (graph file, build artifact) — most precise.
2. A **language server / IDE "find references"** index.
3. **`grep` + `ctags`** over the source — always available, and the only sound way to catch
   dynamic dispatch, string keys, and network boundaries.

> A static graph is **unsound**: it misses reflection, dynamic dispatch, and any
> service/network boundary. Always back it up with the grep sweep in Step 5.

## Step 1 — (If a graph file exists) confirm its schema before querying

JSON shapes differ between tools/versions. Inspect once per session:

```bash
jq 'keys' <graph-file>.json
jq '(.nodes // .vertices)[0]' <graph-file>.json      # sample node — learn the field names
jq '(.edges // .links)[0]'   <graph-file>.json      # sample edge — source/target naming
```

Adapt the field names (`id`, `name`, `file`, `source`/`target`, `type`) below to what you see.

## Step 2 — Find the target node(s)

```bash
jq '(.nodes // .vertices)[] | select(.name | test("MY_SYMBOL"; "i"))' <graph-file>.json
```
Note its `id` and `file`. (No graph? `grep -rn "MY_SYMBOL" <src>` to locate the definition.)

## Step 3 — List direct dependents (who calls / imports it)

```bash
# Inbound edges → callers/importers of TARGET_ID (what your change can break)
jq --arg id "TARGET_ID" '(.edges // .links)[] | select(.target == $id)' <graph-file>.json
# Outbound edges → what TARGET depends on (what could break IT if its inputs change)
jq --arg id "TARGET_ID" '(.edges // .links)[] | select(.source == $id)' <graph-file>.json
```
Count the inbound dependents — a high count means high blast radius.

## Step 4 — Risk classification

Mark the change **HIGH RISK** (→ STOP and warn the user, do not edit) if ANY hold:
- The target is a **god node / hot spot** or has many inbound dependents.
- You're changing a **shared contract**: an API response/request shape, a DB/ORM model field,
  a widely-imported util, or an event name/payload.
- The change crosses a **service/network boundary** (backend ↔ frontend, service ↔ service) —
  consumers on the other side won't show in a code graph.
- The target sits in a known **risky area** (auth/sessions, CORS, payments, tenancy/permissions,
  migrations, caching).

Otherwise (localized change, few/no external dependents): **LOW RISK** → proceed.

## Step 5 — Cross-boundary grep sweep (always do this for shared contracts)

For an API field/route or shared-symbol change, grep every consumer — including other
repos/packages/clients that the graph can't see:

```bash
grep -rn "FIELD_OR_ROUTE_OR_SYMBOL" <all relevant src dirs / sibling repos>
```
Also search for the symbol used as a **string**: route paths, response field names, event names,
queue/job names, cache keys, ORM projection/select fields, and dynamic `obj[name]()` access.
Any hit means a consumer depends on the current shape → treat as HIGH RISK.

## What to hand the user when STOPPING (HIGH RISK)

1. Root cause (file:line).
2. Proposed fix (what you'd change).
3. Impacted surface: the dependents/contracts/consumers from the steps above.
4. Options (e.g. additive change vs. coordinated multi-repo change vs. accept risk).

Then wait for instructions — do not edit.
