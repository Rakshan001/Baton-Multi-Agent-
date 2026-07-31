/**
 * Per-key async mutex, for read-modify-write cycles on registry files.
 *
 * Every mutation of members.json / teams.json is load → mutate → save with
 * awaits in between, and the daemon serves concurrent requests. Unserialized,
 * two of those cycles interleave and the second save silently erases the first
 * — and one of those erasures is a REVOCATION: `markTokenUsed` fires on the
 * revoked member's own next request, and if it loaded the registry before the
 * owner's revoke saved, its stale save puts the token back to work. A grouping
 * feature must never be able to un-revoke a credential, so every mutator runs
 * inside this lock, keyed by the file it writes.
 *
 * In-process only, which matches where the race lives: the daemon is one
 * process. A CLI command writing the same file while a daemon runs is still a
 * last-write-wins between processes — rare, owner-driven, and the reason the
 * dashboard endpoints exist.
 */
const tails = new Map<string, Promise<unknown>>();

export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run after the predecessor SETTLES — a failed write must not wedge the
  // queue behind it, so rejection is treated the same as completion.
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  tails.set(key, tail);
  void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return run;
}
