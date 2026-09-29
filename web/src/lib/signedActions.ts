// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — signed team actions (spec D Rev 3 §8, Team Sync §12.2)

   The contract between the renderer and whoever signs. Irreversible team
   actions are described ONLY by a kind plus structured params (ids, shas,
   decisions). The signer, which is Electron main in the desktop app,
   builds the confirmation text itself from those params, shows a native
   dialog, signs, and applies. The renderer never passes a callback, never
   passes display text, and never calls the mutation itself.

   Demo mode has no Electron main, so lib/teamApi.ts provides a demo
   "main" with the same contract: it builds the dialog text from the
   params, asks through an in-page dialog, then applies the demo change.
   ============================================================ */
import { BatonAPI } from "./api";
import type { AgentBrief, Priority, ProjectRole } from "../types";

/** Every irreversible action and exactly what it carries. */
export interface SignedParams {
  /** Assign or reassign an existing task. */
  "task.assign": { taskId: string; rev: number; memberId: string };
  /** Create one task per project (a feature group when several), optionally assigned. */
  "task.create": {
    title: string; projects: string[]; memberId: string | null; priority: Priority; urgent: boolean;
    brief: AgentBrief; note: string; attachmentIds: string[];
  };
  /** Approve, request changes on, or question a review at a specific commit. */
  "review.decide": { taskId: string; sha: string; decision: "approved" | "changes" | "question"; comment: string; askPush: boolean };
  /** Push the task branch to origin from this device. */
  "git.push": { taskId: string; branch: string | null };
  /** Squash-merge the reviewed commit into the protected branch. */
  "git.merge": { taskId: string; sha: string; branch: string };
  /** Keep one side of a needs-owner conflict. */
  "conflict.resolve": { taskId: string; keep: "a" | "b" };
  /** Revoke one device. */
  "device.revoke": { memberId: string; deviceId: string };
  /** Revoke every device a member has (remove from the team). */
  "member.remove": { memberId: string };
  /** Admit a device that redeemed a pairing offer and matched the SAS words. */
  "device.admit": { offerCode: string; name: string; deviceLabel: string; model: string; sasWords: string[]; roles: Record<string, ProjectRole> };
  /** Turn on GitHub branch protection (L4) for a project's protected branches. */
  "project.protect": { projectKey: string };
  /** Accept an offered skill (spec C). Reserved for the skill-offer screen. */
  "skill.accept": { skillId: string; version: number; agents: string[] };
}

export type SignedKind = keyof SignedParams;
export type SignedAction = { [K in SignedKind]: { kind: K; params: SignedParams[K] } }[SignedKind];

export type SignedResult =
  | { ok: true; /** ids the action created, e.g. new task ids */ created?: string[] }
  | { ok: false; reason: "cancelled" | "unavailable" | "rejected"; message?: string };

/** What Electron preload exposes (keychain-signer task implements it). */
export interface DesktopSigner {
  confirmAndSign<K extends SignedKind>(kind: K, params: SignedParams[K]): Promise<SignedResult>;
}

type DemoMain = (a: SignedAction) => Promise<SignedResult>;
let demoMain: DemoMain | null = null;

/** lib/teamApi.ts registers the demo "main" here. */
export function registerDemoMain(fn: DemoMain) { demoMain = fn; }

/** The one way to perform an irreversible team action. */
export async function confirmAndSign(action: SignedAction): Promise<SignedResult> {
  const desktop = (window as unknown as { desktop?: Partial<DesktopSigner> }).desktop;
  if (desktop?.confirmAndSign) {
    return desktop.confirmAndSign(action.kind, action.params as never);
  }
  if (BatonAPI.demo && demoMain) return demoMain(action);
  return { ok: false, reason: "unavailable", message: "Signed team actions need the Baton desktop app." };
}
