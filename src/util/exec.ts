/**
 * Safe git execution. Runs `git` with an argv array via execa — no shell, so
 * no parsing/expansion/injection regardless of user-controlled task text.
 *
 * Adapted from handler.dev's shell-free exec approach
 * (.refs/handler.dev/packages/server/src/lib/safe-exec.ts, MIT). See NOTICE.
 */
import { execa } from 'execa';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a git command. Throws on non-zero exit. Returns trimmed stdout. */
export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return stdout.trim();
}

/** Run a git command without throwing. Inspect `.ok` for success. */
export async function gitTry(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execa('git', args, { cwd });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? e.message ?? '').trim(),
    };
  }
}
