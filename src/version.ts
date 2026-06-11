/** Single source of the CLI version (package.json), shared by the daemon and KB packs. */
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

export const BATON_VERSION: string = (() => {
  try {
    return (require_('../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
