import CopyChip from "./CopyChip";
import Reveal from "./Reveal";
import { REPO_URL, LICENSE_URL, GOOD_FIRST_ISSUES_URL, QUICKSTART_CMD } from "./site";

export default function OpenSourceCTA() {
  return (
    <section
      id="open-source"
      className="relative mx-auto max-w-5xl px-5 py-28 text-center lg:py-36"
      aria-labelledby="open-source-title"
    >
      {/* ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-[40rem] max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
        style={{ background: "radial-gradient(ellipse, #ff9d2e22, transparent 70%)" }}
      />

      <Reveal className="relative">
        <p className="eyebrow mb-5">{"// open source"}</p>
        <h2 id="open-source-title" className="text-display text-balance text-4xl sm:text-5xl lg:text-6xl">
          Baton is <span className="amber-gradient">open source.</span>
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted">
          MIT licensed, zero-dependency daemon, runs entirely on your machine.
          Clone it, read every line, and pass it on.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3 font-mono text-xs">
          <Stat label="license" value="MIT" />
          <Stat label="daemon" value="zero-dep" />
          <Stat label="node" value="≥ 20" />
        </div>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="glow-amber rounded-full bg-amber px-6 py-3 text-sm font-semibold text-black transition-transform hover:scale-[1.02]"
          >
            Star on GitHub
          </a>
          <a
            href={GOOD_FIRST_ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-line-strong px-6 py-3 text-sm font-medium text-fg transition-colors hover:bg-white/5"
          >
            Good first issues
          </a>
        </div>

        <div className="mx-auto mt-10 max-w-2xl text-left">
          <pre className="overflow-x-auto rounded-xl border border-line bg-ink-2 p-4 font-mono text-sm leading-relaxed text-muted">
            <code>
              <span className="text-faint">$</span> git clone {"\\"}
              {"\n  "}https://github.com/Rakshan001/Baton-Multi-Agent-.git baton
              {"\n"}
              <span className="text-faint">$</span> cd baton && npm install && npm install --prefix web
              {"\n"}
              <span className="text-faint">$</span> npm run build && npm run build --prefix web
              {"\n"}
              <span className="text-faint">$</span> node dist/cli.js{" "}
              <span className="text-amber">serve --write</span>
              {"\n  "}
              <span className="text-faint"># → http://localhost:7077</span>
            </code>
          </pre>
          <div className="mt-4 flex justify-center">
            <CopyChip
              command={QUICKSTART_CMD}
              display="Copy the full quick start"
              prefix="$"
            />
          </div>
        </div>

        <p className="mt-10 font-mono text-xs text-faint">
          License:{" "}
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className="text-muted underline-offset-4 hover:text-amber hover:underline">
            MIT © Rakshan Shetty
          </a>
        </p>
      </Reveal>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-line bg-ink-2/80 px-3 py-1.5 text-faint">
      {label} <span className="text-amber">{value}</span>
    </span>
  );
}
