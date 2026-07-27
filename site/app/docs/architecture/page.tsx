import type { Metadata } from "next";
import { C, Callout, DocHeader, DocPager, DocSection, DocTable, LI, P, UL } from "@/components/docs-ui";

export const metadata: Metadata = {
  title: "Architecture",
  description:
    "Baton's zero-dependency daemon, SSE event bus, SQLite signal storage, MCP tools, and loopback security model.",
};

export default function ArchitectureDoc() {
  return (
    <>
      <DocHeader
        eyebrow="// under the hood"
        title="Architecture"
        lede={
          <>
            Small enough to read in an afternoon, boring on purpose. One daemon,
            one event bus, files and SQLite in your repo — and a security model
            built for a tool that runs with write access to your code.
          </>
        }
      />

      <DocSection id="daemon" title="The daemon">
        <P>
          <C>baton serve</C> starts a single Node process on{" "}
          <C>127.0.0.1:7077</C>. The HTTP layer is raw <C>node:http</C> — no
          Express, no framework, by explicit decision. It serves three things:
        </P>
        <UL>
          <LI>
            a JSON API (<C>/api/status</C>, <C>/api/tasks/…</C>, …) for task
            state, signals, memory, and the knowledge base;
          </LI>
          <LI>
            SSE streams for realtime — server-sent events, not socket.io:
            one-directional live data over plain HTTP, resumable by a simple
            reconnect;
          </LI>
          <LI>the built dashboard (a React app) as static files.</LI>
        </UL>
        <P>
          A status poller scans git state on an interval and shares its snapshot
          with both the SSE stream and plain API reads, so five agents plus an
          open dashboard don&rsquo;t multiply into dozens of git spawns per
          second. Slow SSE consumers are disconnected past a buffer cap instead
          of growing the heap — a stalled browser tab can&rsquo;t take the daemon
          down.
        </P>
      </DocSection>

      <DocSection id="event-bus" title="The event bus">
        <P>
          Every live event — task changes, edit signals, terminal output — flows
          through one in-process bus. Subscribers (the SSE fan-out, the watcher,
          housekeeping timers) attach to that single choke point, and each
          callback is isolated: one misbehaving subscriber loses its own event,
          never the process. That property is what makes &ldquo;coordinating six
          agents&rdquo; boring instead of fragile.
        </P>
      </DocSection>

      <DocSection id="storage" title="Storage: files and SQLite, in your repo">
        <DocTable
          head={["where", "what lives there"]}
          rows={[
            [
              ".baton/wt/<slug>/",
              "one git worktree per task — the isolation boundary",
            ],
            [
              ".baton/wt/<slug>/HANDOFF.md",
              "the session brief — plain markdown, diffs like code",
            ],
            [
              ".baton/ (SQLite)",
              <>
                edit signals, per-file history, and reports — synchronous{" "}
                <C>node:sqlite</C>, WAL mode, busy-timeout tuned for concurrent
                writers
              </>,
            ],
            [
              ".baton/reports/",
              "completion reports: what shipped, what it cost",
            ],
            [
              "kb/ + CODEBASE.md",
              "the knowledge graphs and their <2k-token export (optionally git-shared)",
            ],
          ]}
        />
        <P>
          There is no external database and no server-side state outside the
          repo. Back up the repo and you&rsquo;ve backed up Baton;{" "}
          <C>rm -rf .baton</C> and it never existed.
        </P>
      </DocSection>

      <DocSection id="mcp" title="MCP: coordination inside the agent loop">
        <P>
          <C>baton connect</C> wires a stdio MCP server (<C>baton mcp</C>) into
          every detected agent&rsquo;s config. That gives each agent tools it can
          call mid-task:
        </P>
        <DocTable
          head={["tool", "answers"]}
          rows={[
            ["check_files", "“is another session editing these files right now?”"],
            ["who_touched", "“which task/agent has touched this file before?”"],
            ["get_report", "“what did the last task in this area ship?”"],
            ["orient", "“I’m a fresh session — what is this project and what just happened?”"],
            ["recall_memory", "“what has been learned about this area, and is it still true?”"],
          ]}
        />
        <P>
          This is the difference between coordination as documentation and
          coordination as an API: the agent doesn&rsquo;t have to remember to
          check the dashboard — it can ask, programmatically, at the moment it
          matters.
        </P>
      </DocSection>

      <DocSection id="security" title="Security model">
        <P>
          A daemon with write access to your repo deserves paranoia.
          Baton&rsquo;s exposure is deliberately narrow:
        </P>
        <UL>
          <LI>
            <strong className="font-medium text-fg">Loopback only.</strong> The
            server binds <C>127.0.0.1</C> — nothing on your network can reach it.
          </LI>
          <LI>
            <strong className="font-medium text-fg">Origin guard.</strong> Every
            mutating endpoint rejects requests whose <C>Origin</C> isn&rsquo;t
            loopback, so a malicious web page can&rsquo;t CSRF your daemon from a
            browser tab.
          </LI>
          <LI>
            <strong className="font-medium text-fg">Host-header check.</strong>{" "}
            Non-loopback <C>Host</C> values are refused before routing, closing
            the DNS-rebinding hole where a hostile site re-points its DNS at{" "}
            <C>127.0.0.1</C> and the browser treats your daemon as same-origin.
          </LI>
          <LI>
            <strong className="font-medium text-fg">Writes are opt-in.</strong>{" "}
            Mutating endpoints exist only when the daemon is started with{" "}
            <C>serve --write</C>.
          </LI>
          <LI>
            <strong className="font-medium text-fg">No shell-outs.</strong> Git
            runs through one hardened, shell-free exec wrapper — arguments are
            argv arrays, never interpolated strings.
          </LI>
        </UL>
        <Callout label="threat model">
          Baton assumes your machine is yours and your browser is hostile. It
          does not try to defend against a malicious local process — nothing
          running as your user can — but a web page you visit should never be
          able to read your task list or touch your repo through it.
        </Callout>
      </DocSection>

      <DocPager href="/docs/architecture" />
    </>
  );
}
