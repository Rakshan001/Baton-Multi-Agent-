// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Types for the folded Team Sync state (docs/system-design/team-sync/README.md
 * §5, §7). Self-contained on purpose: the solo pipeline's `TaskState`
 * (src/pipeline.ts) is extended separately, and the two must not import each
 * other until the materialise-on-take step (§7.1) joins them.
 *
 * Everything here is plain JSON (no Maps, no undefined) so a folded state can be
 * canonicalised and hashed (`stateHash`) and compared across devices.
 */

export type Role = 'custodian' | 'lead' | 'developer' | 'designer' | 'viewer' | 'relay';
export const ROLES: readonly Role[] = ['custodian', 'lead', 'developer', 'designer', 'viewer', 'relay'];
/** Team-wide roles: always granted on project `*`. */
export const TEAM_ROLES: readonly Role[] = ['custodian', 'relay'];
/** What a Lead may grant or revoke, in its own projects only (§5.2 "≤ Developer"). */
export const BELOW_LEAD: readonly Role[] = ['developer', 'designer', 'viewer'];

/** Org-chain event types (◆ in §6.2). Folded first; authority for everything else derives from them. */
export const ORG_TYPES: ReadonlySet<string> = new Set([
  'team.genesis',
  'device.admit',
  'device.revoke',
  'device.revoke.amend',
  'role.grant',
  'role.revoke',
  'role.proposal',
  'role.cosign',
  'recovery.restore',
  'project.define',
  'project.alias',
  'project.rekey',
]);

export type TeamTaskState =
  | 'unassigned'
  | 'assigned'
  | 'acknowledged'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'review'
  | 'changes'
  | 'approved'
  | 'pushed'
  | 'merged'
  | 'done'
  | 'cancelled'
  | 'needs-owner';

export const TERMINAL_STATES: ReadonlySet<TeamTaskState> = new Set(['done', 'cancelled']);

/** 0 = P0 (critical) … 3 = P3 (low). Default P2. */
export type PriorityLevel = 0 | 1 | 2 | 3;
export const DEFAULT_PRIORITY_LEVEL: PriorityLevel = 2;
/** §7.3: at most this many unacknowledged reminders raise the effective priority. */
export const MAX_REMINDER_BOOST = 2;

export interface DeviceInfo {
  member: string;
  spki: string;
  label: string;
  model: string;
  /** Hash of the event that admitted it (genesis, admit or recovery.restore). */
  admittedBy: string;
  /** Feed position after which this device's events are void; null while live. */
  cutoffSeq: number | null;
  inventory: string[];
}

export interface MemberProfile {
  name: string;
  jobRole: string;
  timezone: string;
}

export interface MemberInfo {
  /** Sorted `"<project|*>:<role>"` grants. */
  roles: string[];
  devices: string[];
  profile: MemberProfile | null;
}

export interface ProjectInfo {
  name: string;
  remotes: string[];
  rootCommits: string[];
  subpath: string | null;
}

export interface RoleProposal {
  proposer: string;
  action: 'grant' | 'revoke';
  member: string;
  done: boolean;
}

/** The membership/roles/projects state (the org chain, folded). */
export interface OrgState {
  genesis: string | null;
  recoveryPub: string | null;
  recoveryEpoch: number;
  devices: Record<string, DeviceInfo>;
  members: Record<string, MemberInfo>;
  projects: Record<string, ProjectInfo>;
  proposals: Record<string, RoleProposal>;
}

export interface OrgView extends OrgState {
  /** Live (non-revoked) devices whose member holds Custodian. */
  custodians: string[];
  /** §5.4: no custodian device remains — grants and admissions are frozen until recovery.restore. */
  recoveryMode: boolean;
  /** device → the seq at which a fork was proven; the feed is frozen below it. */
  forks: Record<string, number>;
}

export interface TaskLifecycle {
  state: TeamTaskState;
  assignee: string | null;
  agent: string | null;
  /** Lamport of the effective assign, for §7.3 ordering. */
  assignLamport: number | null;
  acked: boolean;
  /** First ack in fold order for the current assignment. */
  ackEvent: string | null;
  /** Reminders since the last ack. */
  reminders: number;
  /** Device holding the take (§7.6); only it may move the task forward. */
  holder: string | null;
  reviewSha: string | null;
  approvedSha: string | null;
  pushRequestSha: string | null;
}

export interface ConflictSide {
  event: string;
  lifecycle: TaskLifecycle;
}

export interface LostClaim {
  device: string;
  member: string;
  event: string;
  winner: string;
}

/**
 * The structured brief a Lead attaches to a task (`task.upsert` field `brief`).
 * On the wire `outOfScope` and `skills` may be omitted; the fold stores them as
 * `[]`, so a folded brief always has this full shape (the pipeline's TaskBrief).
 */
export interface TeamBrief {
  goal: string;
  inScope: string[];
  outOfScope: string[];
  acceptance: string[];
  skills: string[];
}

/** Bounds the fold enforces on a brief (anything larger is refused as `invalid-body`). */
export const BRIEF_LIMITS = {
  goal: 600,
  items: 32,
  itemChars: 400,
  skillChars: 64,
} as const;

export interface TeamTask {
  id: string;
  project: string;
  createdBy: string;
  createdEvent: string;
  parent: string | null;
  title: string;
  group: string | null;
  priority: PriorityLevel;
  urgent: boolean;
  brief: TeamBrief | null;
  briefRev: number;
  noteRef: string | null;
  phase: number | null;
  dependsOn: string[];
  /** false when a Lead opted the task out of review (§7.2). */
  review: boolean;
  lifecycle: TaskLifecycle;
  /** §7.3: `priority − min(reminders, 2)`, never above P0. */
  effectivePriority: PriorityLevel;
  /** §7.6: set while state is `needs-owner`; a Lead picks a side with conflict.resolve. */
  conflict: { sides: ConflictSide[] } | null;
  lostClaims: LostClaim[];
  /** Hash and lamport of the last event that changed this task. */
  lastEvent: string;
  lastLamport: number;
}

export interface EventNote {
  hash: string;
  reason: string;
}

export interface PendingEvent {
  hash: string;
  /** Unknown event hashes, or `device:<id>` when the author's key isn't known yet. */
  missing: string[];
}

export interface TeamState {
  team: string;
  org: OrgView;
  tasks: Record<string, TeamTask>;
  /** Waiting for deps; they never take effect until those arrive (§6.1). */
  pending: PendingEvent[];
  /** Malformed, badly signed, or with a chosen lamport: never take effect. */
  rejected: EventNote[];
  /** Valid but the author lacked authority at its deps, or the action didn't apply. */
  unauthorized: EventNote[];
  /** Past a revoke cutoff or a proven fork (strong removal, §5.4 / §9). */
  voided: string[];
  /** Events with a higher `v` than this build folds ("Update Baton to see N newer events"). */
  newerVersion: number;
}
