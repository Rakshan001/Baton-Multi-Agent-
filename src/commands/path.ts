// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `baton path <slug>` — print a task's worktree path (for `cd $(baton path x)`).
 */
import { getTask , activeBatonRoot } from '../store.js';

export async function pathCmd(slug: string): Promise<void> {
  const root = await activeBatonRoot();
  const task = await getTask(root, slug);
  if (!task) {
    console.error(`No task '${slug}'. See: baton ls`);
    process.exitCode = 1;
    return;
  }
  console.log(task.worktreePath);
}
