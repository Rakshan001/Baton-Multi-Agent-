// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { C, DocHeader, DocPager, DocSection, DocTable, P } from "@/components/docs-ui";

export const metadata: Metadata = {
  title: "CLI reference",
  description:
    "Every baton command, grouped by the job it does, with the flags that matter.",
};

// Descriptions track the `.description()` strings in src/cli.ts. If a command
// changes there, change it here — a docs page that lies about a flag is worse
// than no docs page.

const GETTING_STARTED = [
  ["baton setup", "set up Baton for a repo — or a folder of several repos (hub vs individual)"],
  ["baton connect", "wire the baton coordination MCP server into every agent, so they can see each other"],
  ["baton serve", "start the local daemon: JSON API + the built web dashboard (--write enables mutations)"],
] as const;

const TASKS = [
  ["baton new <task>", "scaffold a branch + worktree for a task (--scope to claim path globs)"],
  ["baton ls", "list tasks with git status, ahead/behind, and age"],
  ["baton status", "central view: live agent, status, ahead/behind, likely conflicts (-w to watch)"],
  ["baton merge <slug>", "merge a task's branch into the current branch (squash + archive)"],
  ["baton rm <slug>", "remove a task's worktree + branch"],
  ["baton path <slug>", "print a task's worktree path"],
  ["baton doctor", "audit junk: orphaned worktrees, branches, tmux sessions, leaked temp files, hub coherence"],
  ["baton clean", "reclaim junk + GC worktrees whose branches are already merged (dry-run unless --fix)"],
] as const;

const HANDOFF = [
  ["baton pass <slug> --to <agent>", "package this session into a HANDOFF.md brief for another agent"],
  ["baton take <slug>", "pick up a brief: prints the execution prompt, marks it in-progress"],
  ["baton done <slug>", "mark a handoff brief as done"],
  ["baton resume", "list open handoff briefs, or print the pickup prompt for one"],
  ["baton route <task>", "which agent should take this task (rules from baton.config.json, no LLM)"],
] as const;

const COORDINATION = [
  ["baton signals", "show live edit signals — which files are being edited by which session right now"],
  ["baton blame <file>", "which task/agent touched a file: live editors + merged history"],
  ["baton history <file>", "trace which task/agent/commits touched a file (from the local index)"],
  ["baton hooks install", "install agent-side hooks: handoff brief + edit guard + orient (Claude), afterFileEdit guard (Cursor)"],
  ["baton orient", "print a budgeted project brief (memory, recent work, structure) for a fresh session"],
  ["baton progress <note>", "tell other agents your current intent (shown on your files via check_files)"],
  ["baton mcp", "run the coordination MCP server over stdio (check_files, get_report, who_touched…)"],
] as const;

const KNOWLEDGE = [
  ["baton memory", "list all facts with freshness (● fresh · ◐ aging · ○ stale)"],
  ["baton memory add", "save a fact from the terminal"],
  ["baton memory rm", "remove a fact"],
  ["baton memory repair", "re-anchor stale facts whose verifiable terms survived the change"],
  ["baton memory gc", "repair what is mechanically verifiable, then drop the still-stale facts"],
  ["baton memory log", "KB change history: superseded/removed facts (archived, not destroyed)"],
  ["baton kb init", "set up the knowledge base: graph per sub-project + merged graph + git hooks"],
  ["baton kb status", "show projects, node/edge counts, last build"],
  ["baton kb rebuild", "rebuild graphs (incremental by default, no LLM needed)"],
  ["baton kb share", "toggle git-sharing of the KB via a committed kb/ directory"],
  ["baton kb export / import", "move the KB as a shareable .tar.gz (imports re-anchored + staleness-checked)"],
  ["baton kb context", "print a shareable markdown context pack for any external chatbot"],
  ["baton kb mcp", "print MCP config so an agent can query the knowledge graph"],
  ["baton bugs <query>", "has this bug been fixed before? — prior fixes + commits that may have re-broken them"],
] as const;

const AGENTS = [
  ["baton start <slug>", "run an agent headlessly in the task's worktree, streaming output"],
  ["baton stop <slug>", "stop a baton-started headless agent"],
  ["baton usage", "real token usage per Claude Code session (parsed from session files, costs estimated)"],
  ["baton skills", "list all skills and where each is installed"],
  ["baton skills install", "install a skill into your agents (all of them unless --agent)"],
  ["baton skills uninstall", "remove an installed skill from your agents"],
  ["baton skills import", "import a skill from a path or URL into the catalog"],
] as const;

export default function CliDoc() {
  return (
    <>
      <DocHeader
        eyebrow="// baton --help, expanded"
        title="CLI reference"
        lede={
          <>
            The full command surface, grouped by job. Descriptions match the CLI
            itself — run any command with <C>--help</C> for its flags.
          </>
        }
      />

      <DocSection id="getting-started" title="Getting started">
        <DocTable head={["command", "what it does"]} rows={GETTING_STARTED} />
      </DocSection>

      <DocSection id="tasks" title="Tasks & worktrees">
        <DocTable head={["command", "what it does"]} rows={TASKS} />
      </DocSection>

      <DocSection id="handoff" title="Session handoff">
        <DocTable head={["command", "what it does"]} rows={HANDOFF} />
      </DocSection>

      <DocSection id="coordination" title="Live coordination">
        <DocTable head={["command", "what it does"]} rows={COORDINATION} />
      </DocSection>

      <DocSection id="knowledge" title="Memory, knowledge base & bugs">
        <DocTable head={["command", "what it does"]} rows={KNOWLEDGE} />
      </DocSection>

      <DocSection id="agents" title="Running agents">
        <DocTable head={["command", "what it does"]} rows={AGENTS} />
        <P>
          Every command supports <C>--help</C>; destructive ones dry-run by
          default and ask for <C>--fix</C> or confirmation.
        </P>
      </DocSection>

      <DocPager href="/docs/cli" />
    </>
  );
}
