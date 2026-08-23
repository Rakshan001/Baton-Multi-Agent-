// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadBrand } from './brand.js';

interface ProjectsFile { version: 1; roots: string[] }

function filePath(): string {
  if (process.env.BATON_PROJECTS_FILE) return process.env.BATON_PROJECTS_FILE;
  return join(homedir(), `.${loadBrand().commandName}`, 'projects.json');
}

function real(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

export function readProjects(): string[] {
  const p = filePath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ProjectsFile;
    if (raw?.version !== 1 || !Array.isArray(raw.roots)) return [];
    return [...new Set(raw.roots.map(real))];
  } catch { return []; }
}

export function writeProjects(roots: string[]): void {
  const p = filePath();
  mkdirSync(dirname(p), { recursive: true });
  const body: ProjectsFile = { version: 1, roots: [...new Set(roots.map(real))] };
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, p);
}

export function addProject(root: string): string[] {
  writeProjects([...readProjects(), real(root)]);
  return readProjects();
}

export function forgetProject(root: string): string[] {
  const t = real(root);
  writeProjects(readProjects().filter((r) => real(r) !== t));
  return readProjects();
}

export function assertGitRepo(root: string): void {
  if (!existsSync(join(root, '.git'))) {
    throw new Error(`Not a git repository: ${root}`);
  }
}
