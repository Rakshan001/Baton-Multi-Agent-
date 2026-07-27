import type { Metadata } from "next";
import Link from "next/link";
import CodeBlock from "@/components/CodeBlock";
import { C, Callout, DocHeader, DocPager, DocSection, LI, P, UL } from "@/components/docs-ui";
import { DOCS_GROUPS } from "@/components/docs-nav";
import { QUICKSTART_CMD } from "@/components/site";

export const metadata: Metadata = {
  // Absolute: the layout's "%s — Baton docs" template applies to child
  // segments, not to the layout's own page, which would leave this one
  // unbranded next to every other docs title.
  title: { absolute: "Baton docs — overview & quick start" },
  description:
    "What Baton is, what it writes to disk, and the commands that get it running.",
};

export default function DocsIndex() {
  const guides = DOCS_GROUPS.flatMap((group) =>
    group.pages.filter((page) => page.href !== "/docs"),
  );

  return (
    <>
      <DocHeader
        eyebrow="// docs"
        title="Overview & quick start"
        lede={
          <>
            Baton is a local coordination hub for AI coding agents — Claude Code,
            Cursor, Codex, Gemini, Aider, OpenCode — sharing one repo. Everything
            runs on your machine, and everything it produces is a file in your
            repo.
          </>
        }
      />

      <DocSection id="what-baton-is" title="What Baton actually is">
        <P>Three pieces, all local:</P>
        <UL>
          <LI>
            A CLI (<C>baton</C>) that scaffolds one git worktree per task,
            packages sessions into handoff briefs, and answers questions like
            &ldquo;who is editing this file right now?&rdquo;
          </LI>
          <LI>
            A daemon (<C>baton serve</C>) — a zero-dependency <C>node:http</C>{" "}
            server on <C>127.0.0.1:7077</C> that serves a JSON API, streams live
            events over SSE, and hosts the dashboard.
          </LI>
          <LI>
            MCP tools every agent can call mid-task — <C>check_files</C>,{" "}
            <C>who_touched</C>, <C>get_report</C> — so coordination happens
            inside the agent&rsquo;s loop, not after the collision.
          </LI>
        </UL>
        <P>
          State lives in a <C>.baton/</C> directory inside your repo: task
          metadata, worktrees, edit-signal history, completion reports, memory,
          and the knowledge graphs. No external database and no cloud service —
          delete the directory and Baton is gone.
        </P>
      </DocSection>

      <DocSection id="quick-start" title="Quick start">
        <P>
          Baton is not published to npm yet, so the quick start is a clone and a
          build.
        </P>
        <CodeBlock label="clone → build → serve" code={QUICKSTART_CMD} />
        <P>
          That leaves the dashboard on <C>http://localhost:7077</C>. Then, in the
          repo you want your agents to share:
        </P>
        <CodeBlock
          label="wire up a project"
          code={[
            'baton setup    # set up Baton for a repo — or a folder of several repos',
            'baton connect  # wire the coordination MCP server into every agent',
            'baton new "my first task"   # branch + isolated worktree, ready for an agent',
          ].join("\n")}
        />
        <Callout label="read-only by default">
          The daemon only accepts mutating API calls when started with{" "}
          <C>--write</C>. Without it you get a read-only dashboard — useful when
          you just want to watch.
        </Callout>
      </DocSection>

      <DocSection id="guides" title="Guides">
        <P>Where to go next, in reading order.</P>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {guides.map((page) => (
            <li key={page.href}>
              <Link
                href={page.href}
                className="panel group flex h-full flex-col p-5 transition-colors hover:border-line-strong"
              >
                <span className="text-fg transition-colors group-hover:text-amber">
                  {page.label} →
                </span>
                <span className="mt-2 text-sm leading-relaxed text-muted">
                  {page.blurb}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </DocSection>

      <DocPager href="/docs" />
    </>
  );
}
