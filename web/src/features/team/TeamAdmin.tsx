// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — Settings → Team (#/settings/team), spec D §5.8, Rev 3 §12
   Custodians and recovery status, every device, project access as a
   person × project matrix, and protected branches (guardrails §1).
   ============================================================ */
import { Link } from "react-router-dom";
import { Check, ShieldAlert, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/primitives";
import { BatonAPI } from "@/lib/api";
import { roleIn, ROLE_LABEL, teamApi } from "@/lib/teamApi";
import { links } from "@/lib/routes";
import { useTeam, Page, PageHeader, TeamUnavailable } from "./context";
import { SignButton } from "./confirm";
import { Banner, Panel, PersonAvatar, ago } from "./ui";

export function TeamAdminScreen() {
  const ctx = useTeam();
  if (!ctx) return <TeamUnavailable title="Team admin" />;
  const { ws, caps } = ctx;
  const custodians = ws.people.filter((p) => p.custodian);
  const devices = ws.people.flatMap((p) => p.devices.map((d) => ({ p, d })));
  const anyLead = caps.anyLead;

  return (
    <Page>
      <PageHeader title="Team admin" description={`${ws.teamName} · ${ws.people.length} people · ${devices.filter(({ d }) => !d.revokedAt).length} devices`}
        actions={<>
          {caps.admit && <Button size="sm" asChild><Link to="/settings/team/pair"><UserPlus aria-hidden />Pair a device</Link></Button>}
          <Button size="sm" variant="ghost" asChild><Link to="/settings/team/classic">Members and invites (classic)</Link></Button>
        </>} />
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 md:p-6">
        {ws.recovery.mode && (
          <Banner tone="danger" title="Recovery mode: no custodian can act">
            Work continues, but admitting devices and granting roles are paused. Only the paper recovery key can restore custodians.
          </Banner>
        )}

        <Panel title="Custodians and recovery" description="Custodians admit and revoke devices. Changes to custodians need two signatures.">
          <ul className="list-none divide-y divide-border-subtle">
            {custodians.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5 px-3 py-2.5 text-[13px]">
                <PersonAvatar person={p} />
                <Link to={links.member(p.id)} className="font-medium hover:underline">{p.name}</Link>
                <span className="text-xs text-muted-foreground">{p.devices.filter((d) => !d.revokedAt).length} device{p.devices.length === 1 ? "" : "s"} · {p.presence === "online" ? "online" : `last seen ${ago(p.lastSeen)}`}</span>
              </li>
            ))}
            <li className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-[13px]">
              {custodians.length >= 2 || ws.recovery.paperKey
                ? <ShieldCheck aria-hidden className="size-4 text-status-online-foreground" />
                : <ShieldAlert aria-hidden className="size-4 text-status-danger-foreground" />}
              <span className="flex-1">
                {custodians.length} custodian{custodians.length === 1 ? "" : "s"}
                {ws.recovery.paperKey ? ` · paper recovery key created ${ago(ws.recovery.paperKeyCreatedAt)}` : " · no paper recovery key"}
              </span>
              <span className="text-xs text-muted-foreground">{custodians.length >= 2 || ws.recovery.paperKey ? "Recoverable" : "At risk: add a custodian or a paper key"}</span>
            </li>
            {BatonAPI.demo && (
              <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-[13px]">
                <span><span className="text-muted-foreground">Demo:</span> preview recovery mode</span>
                <Switch checked={ws.recovery.mode} onChange={(v) => teamApi.setRecovery(v)} label="Preview recovery mode" />
              </li>
            )}
          </ul>
        </Panel>

        <Panel title="Project access" description="Roles per person and project. Grants and revokes are signed events.">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Project roles by person</caption>
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] tracking-wide text-muted-foreground uppercase">
                  <th scope="col" className="sticky left-0 bg-card px-3 py-2 font-medium">Person</th>
                  {ws.projects.map((p) => <th key={p.key} scope="col" className="px-2 py-2 font-mono font-medium normal-case">{p.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {ws.people.map((person) => (
                  <tr key={person.id} className="border-b border-border-subtle last:border-0">
                    <th scope="row" className="sticky left-0 bg-card px-3 py-2 text-left font-normal whitespace-nowrap">
                      <span className="inline-flex items-center gap-2"><PersonAvatar person={person} size={20} />{person.name}{person.custodian && <span className="rounded border border-border px-1 text-[10px] text-muted-foreground uppercase">Custodian</span>}</span>
                    </th>
                    {ws.projects.map((p) => {
                      const r = roleIn(person, p.key);
                      return <td key={p.key} className="px-2 py-2 text-xs whitespace-nowrap">{r ? ROLE_LABEL[r] : <span className="text-muted-foreground">—<span className="sr-only">No access</span></span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Protected branches" description="Agents never touch these. Changes land through a pull request, review and merge.">
          <ul className="list-none divide-y divide-border-subtle">
            {ws.projects.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[13px]">
                <span className="w-16 font-mono text-xs">{p.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{p.protectedBranches.join(", ")}</span>
                <span className="ml-auto inline-flex items-center gap-1 text-xs">
                  {p.serverProtection
                    ? <><Check aria-hidden className="size-3.5 text-status-online-foreground" />GitHub protection on</>
                    : <><ShieldAlert aria-hidden className="size-3.5 text-status-danger-foreground" /><span className="text-status-danger-foreground">GitHub protection off</span></>}
                </span>
                {!p.serverProtection && caps.manage(p.key) && anyLead && (
                  <SignButton action={{ kind: "project.protect", params: { projectKey: p.key } }} ok="Protection applied">Apply recommended protection…</SignButton>
                )}
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Devices" description="Every device across the team. Relays store and forward only.">
          <ul className="list-none divide-y divide-border-subtle">
            {devices.map(({ p, d }) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.label}</span> <span className="text-xs text-muted-foreground">{d.model} · {p.name}{d.relay ? " · relay" : ""}</span>
                  <span className="block font-mono text-[11px] text-muted-foreground">{d.fingerprintWords}</span>
                </span>
                <span className="text-xs text-muted-foreground">{d.revokedAt ? `Revoked ${ago(d.revokedAt)}` : d.online ? "Online" : `Last seen ${ago(d.lastSeen)}`}</span>
                {caps.admit && !d.revokedAt && !d.thisDevice && (
                  <SignButton variant="ghost" action={{ kind: "device.revoke", params: { memberId: p.id, deviceId: d.id } }} ok={`${d.label} revoked`}>Revoke…</SignButton>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Page>
  );
}
