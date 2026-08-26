// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import CodeBlock from "@/components/CodeBlock";
import { C, Callout, DocHeader, DocPager, DocSection, DocTable, LI, P, UL } from "@/components/docs-ui";

export const metadata: Metadata = {
  title: "Memory & knowledge base",
  description:
    "Evidence-anchored facts, staleness detection and repair, plus the code knowledge graph behind CODEBASE.md.",
};

export default function MemoryDoc() {
  return (
    <>
      <DocHeader
        eyebrow="// staying honest"
        title="Memory & knowledge base"
        lede={
          <>
            Shared memory between agents has a failure mode nobody talks about:
            agent A saves a fact, agent B changes the code, and agent C
            confidently acts on a falsehood. Baton&rsquo;s memory layer is
            designed around that exact problem.
          </>
        }
      />

      <DocSection id="staleness" title="The staleness problem">
        <P>
          A plain notes file gets more dangerous as more agents work, because
          every commit is a chance to invalidate someone else&rsquo;s saved
          knowledge — and a stale fact served as fresh is a hallucination with a
          citation. Most memory systems only append. Baton&rsquo;s answer: a fact
          is only served while the evidence it was saved against still exists.
        </P>
      </DocSection>

      <DocSection id="anchoring" title="Evidence anchoring">
        <P>
          Every fact saved with <C>baton memory add</C> is pinned to the commit
          it was written at and to a content hash of each file it cites. On every
          read, Baton re-hashes those files:
        </P>
        <DocTable
          head={["freshness", "meaning"]}
          rows={[
            ["● fresh", "every anchor file hashes the same — the evidence is intact"],
            [
              "◐ aging",
              "commits have touched the anchored paths since the fact was saved",
            ],
            [
              "○ stale",
              "an anchor file changed or vanished — the fact is withheld and served only as a pointer: “this was believed, re-verify before relying on it”",
            ],
          ]}
        />
        <P>
          The aging count is scoped to the fact&rsquo;s anchored paths — six
          agents committing elsewhere in the repo doesn&rsquo;t age a fact about{" "}
          <C>src/server.ts</C>. Facts saved without naming files get anchors
          derived from the paths in their own text; a fact that stays truly
          anchorless ages out instead of being trusted forever.
        </P>
        <Callout label="the design bet">
          Withholding beats deleting. A stale fact still tells the next agent
          where to look — &ldquo;something was known about this file; re-check
          it&rdquo; — without letting it be quoted as current truth.
        </Callout>
      </DocSection>

      <DocSection id="repair" title="Repair, GC, and the audit log">
        <CodeBlock
          code={`baton memory list     # all facts with freshness (● fresh · ◐ aging · ○ stale)
baton memory repair   # re-anchor stale facts whose verifiable terms survived
baton memory gc       # repair what's verifiable, drop what's still stale
baton memory log      # superseded/removed facts — archived, not destroyed`}
        />
        <P>
          <C>repair</C> is mechanical, not magical: it extracts verifiable terms
          from the fact (identifiers, paths, flags) and re-anchors only if those
          exact tokens still exist in the changed files. Anything it can&rsquo;t
          verify is listed for a human — or an agent with fresh context — to
          re-check. Removed facts go to an archive, so <C>log</C> can answer
          &ldquo;what did we used to believe, and when did it stop being
          true?&rdquo;
        </P>
      </DocSection>

      <DocSection id="knowledge-graph" title="The code knowledge graph">
        <CodeBlock
          code={`baton kb init      # graph per sub-project + merged graph + git hooks
baton kb status    # projects, node/edge counts, last build
baton kb rebuild   # incremental rebuild — no LLM needed`}
        />
        <P>
          Alongside memory, <C>baton kb</C> indexes the repo into a queryable
          graph of files, symbols, and relationships, rebuilt incrementally on
          commit via git hooks. Its headline export is <C>CODEBASE.md</C> — a
          repo map under ~2k tokens. An agent reading the map instead of grepping
          the tree spends a fraction of the context.
        </P>
        <UL>
          <LI>
            <C>baton kb mcp</C> prints MCP config so agents query the graph
            directly.
          </LI>
          <LI>
            <C>baton kb context</C> emits a shareable markdown context pack for
            any external chatbot (pipe it to <C>pbcopy</C> and paste).
          </LI>
          <LI>
            <C>baton kb export</C> / <C>import</C> move the whole knowledge base
            between machines as a <C>.tar.gz</C> — imports are re-anchored and
            staleness-checked, the same rules as everything else.
          </LI>
          <LI>
            <C>baton kb share</C> toggles git-sharing of the KB via a committed{" "}
            <C>kb/</C> directory, so teammates skip re-indexing.
          </LI>
          <LI>
            <C>baton bugs</C> asks &ldquo;has this bug been fixed
            before?&rdquo; — surfacing prior fixes and the commits that may have
            re-broken them.
          </LI>
        </UL>
      </DocSection>

      <DocPager href="/docs/memory" />
    </>
  );
}
