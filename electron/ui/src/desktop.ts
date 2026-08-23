// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface Brand {
  productName: string;
  commandName: string;
  appId: string;
  tagline: string;
  accentColor: string;
  repository: string;
}

export type FleetState = 'running' | 'stale' | 'stopped' | 'missing';

export interface FleetRow {
  pid: number | null;
  port: number | null;
  root: string;
  name: string;
  state: FleetState;
  startedAt: string | null;
  writeEnabled: boolean;
  host: boolean;
  version: string | null;
}

export interface DesktopApi {
  getBrand: () => Promise<Brand>;
  listFleet: () => Promise<FleetRow[]>;
  stopDaemon: (pid: number, port: number) => Promise<string>;
  cleanRecord: (pid: number, port: number) => Promise<void>;
  cleanDead: () => Promise<number>;
  openExternal: (url: string) => Promise<void>;
  addProject: () => Promise<{ ok: boolean; root?: string; error?: string }>;
  forgetProject: (root: string) => Promise<void>;
  startProject: (root: string, write: boolean) => Promise<{ ok: boolean; error?: string; lines?: string[] }>;
  openDashboard: (port: number) => Promise<void>;
  closeDashboard: () => Promise<void>;
  getGraphify: (port: number) => Promise<{
    ok: boolean;
    graphifyInstalled?: boolean;
    hint?: string;
    projects?: Array<{
      id: string; nodes?: number; edges?: number; building?: boolean; lastBuiltAt?: string | null;
    }>;
    error?: string;
  }>;
  stopGraphify: (port: number, projectId: string) => Promise<{ ok: boolean; error?: string }>;
  cliStatus: () => Promise<{ installed: boolean; detail: string; commandName: string }>;
  installCli: () => Promise<{ detail?: string }>;
  uninstallCli: (deleteDataDir: boolean) => Promise<{ detail?: string }>;
  onFleetChanged: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export function api(): DesktopApi {
  if (!window.desktop) throw new Error('desktop bridge missing — open this UI inside Electron');
  return window.desktop;
}
