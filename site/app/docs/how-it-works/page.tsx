// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import CodeBlock from "@/components/CodeBlock";
import { C, Callout, DocHeader, DocPager, DocSection, LI, P, UL } from "@/components/docs-ui";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The Baton handoff lifecycle end to end — new, pass, take, signals, merge — and what each step writes to disk.",
};

export default function HowItWorksDoc() {
  return (
    <>
      <DocHeader
        eyebrow="// the lifecycle"
        title="How it works"
        lede={
          <>
            The animation on the home page, compressed into files and commands.
            Five steps take a task from idea, through a planning agent, to an
            executing agent, to a squash-merged branch — and every step is
            inspectable on disk.
          </>
        }
      />

      <DocSection id="isolation" title="1 · A task gets its own checkout">
        <CodeBlock code={'baton new "my task"'} />
        <P>
          Baton creates a branch named <C>baton/my-task</C> and a git worktree at{" "}
          <C>.baton/wt/my-task</C> — a full, independent checkout of the repo on
          that branch. This is the core isolation trick: five agents on five
          tasks are five directories, so no agent can clobber another&rsquo;s
          uncommitted work, and <C>git status</C> in each worktree stays honest.
        </P>
        <P>
          Task metadata (slug, branch, worktree path, status, assigned agent) is
          tracked by Baton and shown by <C>baton ls</C> and <C>baton status</C> —
          the central view with live agent, ahead/behind counts, and likely
          conflicts. In a hub (a folder of several repos set up together), each
          task branches off its own sub-project; <C>baton new --project</C> picks
          which one.
        </P>
      </DocSection>

      <DocSection id="pass" title="2 · The session becomes one file">
        <CodeBlock code={"baton pass my-task --to cursor"} />
        <P>
          This is the baton pass. The command condenses the current session into
          a single <C>HANDOFF.md</C> in the task&rsquo;s worktree — plain
          markdown with a frontmatter header:
        </P>
        <CodeBlock
          label=".baton/wt/my-task/HANDOFF.md"
          code={`---
objective: ship the auth fix
remaining: 2 tasks
est_cost_usd: 0.05
---

## Plan
...

## Remaining checklist
- [ ] wire the new guard into /api/tasks
- [ ] run the suite`}
        />
        <UL>
          <LI>
            <strong className="font-medium text-fg">Objective and plan</strong> —
            what the planning agent decided, so the next one doesn&rsquo;t
            re-derive it.
          </LI>
          <LI>
            <strong className="font-medium text-fg">Remaining checklist</strong>{" "}
            — concrete, checkable steps.
          </LI>
          <LI>
            <strong className="font-medium text-fg">Estimated cost</strong> —
            what finishing should cost on the receiving agent, so the routing
            decision is a number rather than a vibe.
          </LI>
        </UL>
        <P>
          Because it&rsquo;s a file next to the code, it survives crashed
          sessions, works across vendors, and diffs like everything else. There
          is nothing proprietary to export or import.
        </P>
      </DocSection>

      <DocSection id="take" title="3 · Another agent picks it up">
        <CodeBlock code={"baton take my-task   # or: baton resume, to list open briefs"} />
        <P>
          <C>take</C> prints the execution prompt assembled from the brief and
          marks the task in-progress. The prompt prints between delimiters so you
          can pipe it straight into any CLI agent. <C>baton route</C> can pick
          the receiving agent for you from rules in <C>baton.config.json</C> —
          deterministic, with no LLM call.
        </P>
        <Callout label="stale-brief guard">
          Briefs age. If commits landed in the checkout after the brief was
          written, the printed prompt opens with a stale-brief warning telling
          the agent to trust <C>git log</C> and <C>git diff</C> over the
          brief&rsquo;s &ldquo;state of the work&rdquo;. A progress ledger older
          than the last commit is dropped entirely. An out-of-date plan presented
          as current is how agents hallucinate — so Baton says so, in-band, where
          the agent will read it.
        </Callout>
      </DocSection>

      <DocSection id="signals" title="4 · Live edit signals prevent collisions">
        <CodeBlock code={"baton signals   # who is editing which files, right now"} />
        <P>
          <C>baton hooks install</C> adds a small hook to each agent (Claude
          Code, Cursor, …). On every file edit the hook reports the path, and
          Baton records an edit signal — session, file, timestamp — in a local
          SQLite store under <C>.baton/</C>. Signals expire on a short window and
          are reconciled against <C>git status</C>, so a file only counts as
          &ldquo;held&rdquo; while someone is genuinely working on it.
        </P>
        <UL>
          <LI>
            The daemon streams signals over SSE to the dashboard — overlaps flash
            as conflict warnings while both editors are still typing, not at
            merge time.
          </LI>
          <LI>
            Agents can ask before touching a file: the MCP tool{" "}
            <C>check_files</C> answers &ldquo;is anyone editing this?&rdquo;
            inside the agent&rsquo;s own loop.
          </LI>
          <LI>
            <C>baton blame &lt;file&gt;</C> merges live editors with history:
            which task and agent touched this file, ever.
          </LI>
        </UL>
      </DocSection>

      <DocSection id="merge" title="5 · Done, reported, merged">
        <CodeBlock
          code={`baton done my-task    # mark the brief done
baton merge my-task   # squash-merge the branch, archive the task`}
        />
        <P>
          Completion files a report to <C>.baton/reports/</C> — what shipped and
          what it cost. <C>merge</C> squash-merges <C>baton/my-task</C> into your
          current branch and archives the task. History stays queryable:{" "}
          <C>baton history &lt;file&gt;</C> traces which task, agent, and commits
          touched a file long after the branch is gone. <C>baton doctor</C> and{" "}
          <C>baton clean</C> audit and reclaim anything left behind — orphaned
          worktrees, merged branches, leaked tmux sessions.
        </P>
      </DocSection>

      <DocPager href="/docs/how-it-works" />
    </>
  );
}
