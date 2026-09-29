// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Pairing (#/settings/team/pair), spec D §5.3, Team Sync §8/§12
   Custodian side: name + projects + role → a 120 s single-use code →
   the joining device's request with 6 SAS words → Allow (signed).
   Joining side: address + code → compare the same 6 words → wait.
   Beacons never grant trust; a baton://pair link only pre-fills this.
   ============================================================ */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, Loader2, Radar, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { ROLE_LABEL, teamApi } from "@/lib/teamApi";
import type { ProjectRole } from "@/types";
import { useTeam, Page, PageHeader, TeamUnavailable, type TeamCtx } from "./context";
import { ActError, useAct } from "./confirm";
import { Banner, CopyButton, Panel, useNow } from "./ui";

const OFFER_MS = 120_000;
const WORDLIST = ["amber", "birch", "cedar", "delta", "ember", "falcon", "glacier", "harbor", "indigo", "juniper", "lantern", "meadow", "noble", "orbit", "pebble", "quartz", "ripple", "saffron", "thistle", "velvet", "willow", "zephyr"];

function words(seed: number): string[] {
  let x = seed || 1;
  return Array.from({ length: 6 }, () => { x = (x * 1103515245 + 12345) % 2147483648; return WORDLIST[x % WORDLIST.length]!; });
}

function newCode(): string {
  const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  // Demo codes still come from the CSPRNG: a guessable code is a guessable admission.
  const pick = (n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => a[x % a.length]).join("");
  return `${pick(4)}-${pick(3)}-${pick(3)}`;
}

function SasWords({ list }: { list: string[] }) {
  return (
    <ol className="grid list-none grid-cols-3 gap-1.5 font-mono text-sm max-sm:grid-cols-2" aria-label="Verification words">
      {list.map((w, i) => (
        <li key={i} className="flex items-center gap-2 rounded-md border border-border-subtle bg-background px-2.5 py-2">
          <span className="text-[11px] text-muted-foreground">{i + 1}</span>{w}
        </li>
      ))}
    </ol>
  );
}

function Ring({ left }: { left: number }) {
  const r = 18, c = 2 * Math.PI * r, frac = left / OFFER_MS;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="-rotate-90">
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border-default)" strokeWidth="3" />
      <circle cx="22" cy="22" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" />
    </svg>
  );
}

function AddDevice({ ctx }: { ctx: TeamCtx }) {
  const [params] = useSearchParams();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(params.get("request") ? 3 : 1);
  const [name, setName] = useState(params.get("request") ? "Sam Okafor" : "");
  const [role, setRole] = useState<ProjectRole>("developer");
  const [projects, setProjects] = useState<string[]>(params.get("request") ? ["*"] : []);
  const [code, setCode] = useState(newCode);
  const [issued, setIssued] = useState(() => Date.now());
  const [tried, setTried] = useState(false);
  const admit = useAct();
  const now = useNow(1000);
  const left = Math.max(0, OFFER_MS - (now - issued));
  const expired = step === 2 && left === 0;
  const secs = Math.ceil(left / 1000);
  // The smallest threshold not yet passed, so the text changes only at 60, 30 and 10 s.
  const milestone = [60, 30, 10].filter((m) => secs <= m).pop() ?? null;
  const sas = useMemo(() => words(code.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0)), [code]);
  const requester = params.get("request") ? "Sam's MacBook Air" : `${name.split(" ")[0] || "New"}'s MacBook Air`;

  // Demo: a device redeems the code a few seconds after it is shown.
  useEffect(() => {
    if (step !== 2 || expired) return;
    const t = setTimeout(() => setStep(3), 6000);
    return () => clearTimeout(t);
  }, [step, expired, code]);

  const regenerate = () => { setCode(newCode()); setIssued(Date.now()); };
  const valid = name.trim() && projects.length > 0;
  const link = `baton://pair?h=192.168.1.20&p=7443&c=${code}`;

  if (!ctx.caps.admit) {
    return <Banner tone="info" title={ctx.ws.recovery.mode ? "Pairing is paused in recovery mode" : "Only custodians can add devices"}>Ask a custodian to pair the new device.</Banner>;
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Progress">
        {["Who", "Code", "Verify", "Done"].map((s, i) => (
          <li key={s} aria-current={step === i + 1 ? "step" : undefined} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", step === i + 1 ? "border-border-strong text-foreground" : step > i + 1 ? "border-border-subtle text-muted-foreground" : "border-border-subtle text-muted-foreground")}>
            {step > i + 1 ? <Check aria-hidden className="size-3" /> : <span className="font-mono">{i + 1}</span>}{s}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Panel title="Who is joining?">
          <form className="grid gap-4 p-3" noValidate onSubmit={(e) => { e.preventDefault(); setTried(true); if (valid) { regenerate(); setStep(2); } }}>
            <div className="grid gap-1.5">
              <Label htmlFor="pair-name">Name</Label>
              <Input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-invalid={tried && !name.trim()} />
              {tried && !name.trim() && <p className="text-xs text-status-danger-foreground">Enter the person's name.</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pair-role">Role</Label>
              <select id="pair-role" value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} className="h-9 rounded-md border border-input bg-background px-2 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11">
                {(["developer", "designer", "viewer", "lead"] as ProjectRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Applies to the projects below. Designers work through agents with guard mode enforced.</p>
            </div>
            <fieldset className="grid gap-1.5">
              <legend className="mb-1 text-sm font-medium">Projects</legend>
              <div className="flex flex-wrap gap-1.5">
                {ctx.ws.projects.map((p) => {
                  const on = projects.includes(p.key);
                  return (
                    <label key={p.key} className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background max-md:h-11", on ? "border-border-strong bg-selected" : "border-border hover:bg-accent")}>
                      <input type="checkbox" className="size-3.5 accent-current" checked={on} onChange={() => setProjects(on ? projects.filter((k) => k !== p.key) : [...projects, p.key])} />{p.name}
                    </label>
                  );
                })}
              </div>
              {tried && projects.length === 0 && <p className="text-xs text-status-danger-foreground">Pick at least one project.</p>}
            </fieldset>
            <div className="flex justify-end"><Button type="submit" size="sm">Create pairing code</Button></div>
          </form>
        </Panel>
      )}

      {step === 2 && (
        <Panel title={`Pair ${name.split(" ")[0]}'s device`} description="On their Mac, open Baton → Join a team, then enter the address and code.">
          <div className="grid gap-4 p-3">
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <div className="rounded-md border border-border-subtle bg-background p-3">
                <div className="text-xs text-muted-foreground">Address</div>
                <div className="mt-1 flex items-center justify-between gap-2"><span className="font-mono text-base">192.168.1.20:7443</span><CopyButton text="192.168.1.20:7443" /></div>
              </div>
              <div className="rounded-md border border-border-subtle bg-background p-3">
                <div className="text-xs text-muted-foreground">One-time code</div>
                <div className="mt-1 flex items-center justify-between gap-2"><span className={cn("font-mono text-base tracking-wider", expired && "line-through opacity-60")}>{code}</span><CopyButton text={code} /></div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn(expired ? "text-status-danger-foreground" : "text-foreground")}><Ring left={left} /></span>
              <p className="text-[13px]" aria-hidden>{expired ? "Code expired. Make a new one." : `Expires in ${Math.ceil(left / 1000)} s. Single use.`}</p>
              {/* Announce only at 60 s, 30 s, 10 s and expiry, never every second. */}
              <p role="status" className="sr-only">{expired ? "The code expired. Make a new one." : milestone ? `The code expires in ${milestone} seconds.` : ""}</p>
              <Button size="sm" variant="outline" className="ml-auto max-md:h-11" onClick={regenerate}><RefreshCw aria-hidden />Regenerate</Button>
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <span>Or send this link. It only pre-fills their confirmation screen:</span>
              <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-mono text-foreground">{link}</span><CopyButton text={link} label="Copy link" /></div>
            </div>
            {!expired && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin" />Waiting for the device to connect…</p>}
          </div>
        </Panel>
      )}

      {step === 3 && (
        <Panel title={`${requester} wants to join`} description="Ask them to read their six words aloud. Allow only if every word matches.">
          <div className="grid gap-4 p-3">
            <SasWords list={sas} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => { setStep(1); }}>Deny</Button>
              <Button onClick={async () => {
                const r = await admit.sign({ kind: "device.admit", params: { offerCode: code, name: name || "Sam Okafor", deviceLabel: requester, model: "MacBook Air (M3)", sasWords: sas, roles: Object.fromEntries(projects.map((k) => [k, role])) } }, `${requester} admitted`);
                if (r.ok) setStep(4);
              }}>Words match. Allow</Button>
            </div>
            <ActError error={admit.error} />
          </div>
        </Panel>
      )}

      {step === 4 && (
        <Panel title="Device paired">
          <div className="flex flex-wrap items-center gap-3 p-3 text-[13px]">
            <ShieldCheck aria-hidden className="size-5 text-status-online-foreground" />
            <span className="flex-1">{name || "They"} can now sync with the team.</span>
            <Button size="sm" asChild><Link to="/board">Assign a first task</Link></Button>
            <Button size="sm" variant="ghost" onClick={() => { setName(""); setProjects([]); setTried(false); setStep(1); }}>Pair another</Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function JoinTeam() {
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<"form" | "verify" | "waiting" | "done">("form");
  const [tried, setTried] = useState(false);
  const sas = useMemo(() => words(code.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0)), [code]);
  const codeOk = /^[A-Z0-9]{4}-[A-Z0-9]{3}-[A-Z0-9]{3}$/i.test(code.trim());
  const addrOk = /^(10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168)\.[\d.]+:\d{2,5}$/.test(addr.trim());

  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setTimeout(() => setPhase("done"), 3500);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Found on your network" description="You'll still need the code from a custodian.">
        <ul className="list-none divide-y divide-border-subtle">
          <li className="flex items-center gap-3 px-3 py-2.5 text-[13px]">
            <Radar aria-hidden className="size-4 text-muted-foreground" />
            <span className="flex-1">Studio Mac mini <span className="text-muted-foreground">· Acme core</span></span>
            <Button size="sm" variant="ghost" className="max-md:h-11" onClick={() => setAddr("192.168.1.20:7443")}>Use address</Button>
          </li>
        </ul>
      </Panel>
      {phase === "form" && (
        <Panel title="Enter the address and code">
          <form className="grid gap-3 p-3" noValidate onSubmit={(e) => { e.preventDefault(); setTried(true); if (codeOk && addrOk) setPhase("verify"); }}>
            <div className="grid gap-1.5">
              <Label htmlFor="j-addr">Address</Label>
              <Input id="j-addr" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="192.168.1.20:7443" className="font-mono" aria-invalid={tried && !addrOk} aria-describedby="j-addr-h" />
              <p id="j-addr-h" className={cn("text-xs", tried && !addrOk ? "text-status-danger-foreground" : "text-muted-foreground")}>A local network address with a port. Internet addresses aren't accepted.</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="j-code">Code</Label>
              <Input id="j-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7Q4-M2X-9PL" className="font-mono tracking-wider" aria-invalid={tried && !codeOk} />
              {tried && !codeOk && <p className="text-xs text-status-danger-foreground">Codes look like K7Q4-M2X-9PL.</p>}
            </div>
            <div className="flex justify-end"><Button type="submit" size="sm">Connect</Button></div>
          </form>
        </Panel>
      )}
      {phase === "verify" && (
        <Panel title="Check these match the custodian's screen" description="Read them aloud to each other. If any word differs, stop.">
          <div className="grid gap-4 p-3">
            <SasWords list={sas} />
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setPhase("form")}>They don't match</Button>
              <Button onClick={() => setPhase("waiting")}>They match</Button>
            </div>
          </div>
        </Panel>
      )}
      {phase === "waiting" && (
        <p role="status" className="flex items-center gap-2 rounded-lg border border-border-subtle bg-card px-3 py-3 text-[13px]">
          <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />Waiting for the custodian to allow this device…
        </p>
      )}
      {phase === "done" && (
        <Banner tone="info" title="You're in" icon={ShieldCheck} action={<Button size="sm" asChild><Link to="/inbox">Open Inbox</Link></Button>}>
          This device is catching up on the team's history. Tasks for you will appear in your Inbox.
        </Banner>
      )}
    </div>
  );
}

export function PairingScreen() {
  const ctx = useTeam();
  const [params, setParams] = useSearchParams();
  if (!ctx) return <TeamUnavailable title="Add teammate" />;
  const mode = params.get("mode") === "join" ? "join" : "add";
  const tab = (id: "add" | "join", label: string) => (
    <button type="button" role="tab" aria-selected={mode === id} onClick={() => setParams(id === "join" ? { mode: "join" } : {}, { replace: true })}
      className={cn("h-9 rounded-md px-3 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:h-11", mode === id ? "bg-selected text-foreground" : "text-muted-foreground hover:text-foreground")}>
      {label}
    </button>
  );
  return (
    <Page>
      <PageHeader title="Pair a device" description="Devices join with a one-time code and six matching words. No tokens are ever shown."
        actions={<Button size="sm" variant="ghost" asChild><Link to="/settings/team">Team admin</Link></Button>}>
        <div role="tablist" aria-label="Pairing side" className="mt-3 flex gap-1">{tab("add", "Add a device")}{tab("join", "Join a team")}</div>
      </PageHeader>
      <div className="mx-auto max-w-2xl p-4 md:p-6">
        {mode === "add" ? <AddDevice ctx={ctx} /> : <JoinTeam />}
        <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground"><UserPlus aria-hidden className="size-3.5" />QR codes arrive when the QR library is approved; the address, code and link work today.</p>
      </div>
    </Page>
  );
}
