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
import { createInterface } from 'node:readline';
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

/** Claude Code's project-dir encoding: every non-alphanumeric char → '-'. */
export function sessionDirFor(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** Newest .jsonl transcript in the session dir for `cwd`, or null. */
export async function latestSessionFile(cwd: string): Promise<string | null> {
  try {
    const dir = sessionDirFor(cwd);
    const entries = await readdir(dir);
    const files = entries.filter((f) => f.endsWith('.jsonl'));
    if (!files.length) return null;
    const stats = await Promise.all(
      files.map(async (f) => ({ f: join(dir, f), mtime: (await stat(join(dir, f))).mtimeMs })),
    );
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats[0].f;
  } catch {
    return null;
  }
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

  const rl = createInterface({ input: createReadStream(file, 'utf-8'), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
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
  } finally {
    rl.close();
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
