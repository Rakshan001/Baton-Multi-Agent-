/**
 * Plan the runtime dependency closure for the packaged CLI payload.
 * Reimplements the orcabaton approach — never import that repo.
 *
 * Nested node_modules win (Node resolution). Missing required deps refuse.
 */
export function planDependencyClosure({ direct, readManifest }) {
  const found = new Map();
  const queue = direct.map((name) => ({ name, from: '', required: true, by: 'root' }));

  while (queue.length > 0) {
    const want = queue.shift();
    let dir = null;
    let manifest = null;
    const parts = want.from === '' ? [] : want.from.split('/');
    for (let depth = parts.length; depth >= 0; depth--) {
      const base = parts.slice(0, depth);
      if (base.at(-1) === 'node_modules') continue;
      const candidate = [...base, 'node_modules', want.name].join('/');
      const read = readManifest(candidate);
      if (read) {
        dir = candidate;
        manifest = read;
        break;
      }
    }
    if (dir == null) {
      if (!want.required) continue;
      return {
        action: 'refuse',
        code: 'missing-dependency',
        detail: `\`${want.name}\` (required by \`${want.by}\`) is not installed`,
      };
    }
    if (found.has(dir)) continue;
    found.set(dir, { name: want.name, dir, version: manifest.version ?? null });
    const deps = manifest.dependencies ?? {};
    for (const [name, _range] of Object.entries(deps)) {
      queue.push({ name, from: dir, required: true, by: want.name });
    }
    // optionalDependencies — best effort
    for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
      queue.push({ name, from: dir, required: false, by: want.name });
    }
  }

  return { action: 'copy', packages: [...found.values()] };
}
