// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Claude Code session extraction for handoff briefs. Reads the JSONL
 * transcript Claude Code keeps under ~/.claude/projects/<encoded-cwd>/ and
 * pulls out what the NEXT agent needs: the plan/todo state, files touched,
 * commands run, and the last few assistant decisions.
 *
 * The format is undocumented and drifts between versions — every accessor
 * here is defensive and the whole parse degrades to "no session context"
 * rather than ever throwing.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TodoItem {
  content: string;
  status: string;
}

export interface SessionContext {
  sessionFile: string;
  /** Files the agent read (context it had). */
  filesRead: string[];
  /** Files the agent edited/wrote (work it did). */
  filesEdited: string[];
  /** Shell commands run (first line each). */
  commands: string[];
  /** Last recorded todo list — the closest thing to "the plan". */
  todos: TodoItem[];
  /** Last few assistant prose blocks — decisions and findings. */
  lastNotes: string[];
  /** Rough size of the conversation, for the cost-arbitrage display. */
  estTokens: number;
}

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Claude Code's project-dir encoding: every non-alphanumeric char → '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function sessionDirFor(cwd: string): string {
  return join(claudeProjectsDir(), encodeCwd(cwd));
}

/** Top-level .jsonl transcripts in `dir`, newest first ([] when unreadable).
 *  A file that vanishes between readdir and stat is skipped, not fatal. */
export async function transcriptsIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const files = entries.filter((f) => f.endsWith('.jsonl'));
    const stats = (await Promise.allSettled(
      files.map(async (f) => ({ f: join(dir, f), mtime: (await stat(join(dir, f))).mtimeMs })),
    )).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats.map((s) => s.f);
  } catch {
    return [];
  }
}

/** All top-level .jsonl transcripts for `cwd`, newest first ([] when none).
 *  Subagent transcripts are deliberately not listed: callers read `[0]`. */
export async function listSessionFiles(cwd: string): Promise<string[]> {
  return transcriptsIn(sessionDirFor(cwd));
}

/** `<dir>/<sessionId>/subagents/*.jsonl` for one top-level transcript ([] when none). */
export async function subagentTranscripts(sessionFile: string): Promise<string[]> {
  const dir = join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort().map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Newest .jsonl transcript in the session dir for `cwd`, or null. */
export async function latestSessionFile(cwd: string): Promise<string | null> {
  return (await listSessionFiles(cwd))[0] ?? null;
}

/**
 * A JSONL file's lines, streamed. Splits on `\n` ONLY (a trailing `\r` is
 * dropped): `readline` also breaks on U+2028/U+2029, which JSON allows raw
 * inside a string, so one such line became pieces that each failed to parse
 * and the whole line was silently lost. Read errors reject the iteration.
 */
export async function* readLines(file: string): AsyncGenerator<string> {
  let carry = '';
  for await (const chunk of createReadStream(file, 'utf-8') as AsyncIterable<string>) {
    const parts = (carry + chunk).split('\n');
    carry = parts.pop()!;
    for (const p of parts) yield p.endsWith('\r') ? p.slice(0, -1) : p;
  }
  if (carry) yield carry.endsWith('\r') ? carry.slice(0, -1) : carry;
}

interface ToolUseBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

export async function parseSession(file: string): Promise<SessionContext> {
  const ctx: SessionContext = {
    sessionFile: file,
    filesRead: [],
    filesEdited: [],
    commands: [],
    todos: [],
    lastNotes: [],
    estTokens: 0,
  };
  const read = new Set<string>();
  const edited = new Set<string>();
  const commands: string[] = [];
  const notes: string[] = [];
  let chars = 0;

  try {
    for await (const line of readLines(file)) {
      chars += line.length;
      let m: { type?: string; message?: { content?: unknown } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== 'assistant') continue;
      const content = m.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolUseBlock[]) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 40) {
          notes.push(block.text.trim());
        }
        if (block.type !== 'tool_use' || !block.input) continue;
        const input = block.input;
        const filePath = typeof input.file_path === 'string' ? input.file_path : null;
        switch (block.name) {
          case 'Read':
            if (filePath) read.add(filePath);
            break;
          case 'Edit':
          case 'Write':
          case 'MultiEdit':
          case 'NotebookEdit':
            if (filePath) edited.add(filePath);
            break;
          case 'Bash':
            if (typeof input.command === 'string') commands.push(input.command.split('\n')[0].slice(0, 160));
            break;
          case 'TodoWrite':
            if (Array.isArray(input.todos)) {
              ctx.todos = (input.todos as Array<Record<string, unknown>>)
                .filter((t) => typeof t?.content === 'string')
                .map((t) => ({ content: String(t.content), status: String(t.status ?? 'pending') }));
            }
            break;
        }
      }
    }
  } catch {
    /* truncated/locked file — keep whatever we collected */
  }

  ctx.filesRead = [...read].slice(-40);
  ctx.filesEdited = [...edited];
  ctx.commands = commands.slice(-20);
  ctx.lastNotes = notes.slice(-3);
  ctx.estTokens = Math.round(chars / 4);
  return ctx;
}

/** Best-effort session context for a worktree; null when none found. */
export async function sessionContextFor(cwd: string): Promise<SessionContext | null> {
  const file = await latestSessionFile(cwd);
  if (!file) return null;
  try {
    return await parseSession(file);
  } catch {
    return null;
  }
}
