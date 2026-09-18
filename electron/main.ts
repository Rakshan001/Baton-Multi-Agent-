// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop shell. Spawns `serve` as a sibling Node process; never imports the
 * HTTP server. Fleet ops go through fleet.ts → dist/daemons.js.
 */
import {
  app, BrowserView, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage,
  Notification, shell, Tray,
} from 'electron';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTRIBUTION, attributionLines } from './attribution.js';
import { brandingDir, loadBrand } from './brand.js';
import {
  bundledCliPath, getCliInstallState, installCliSymlink, installCliUserPath, uninstallCli,
} from './cli-install.js';
import {
  cleanDeadFleetRecords, cleanFleetRecord, listFleet, stopFleetDaemon, type FleetRow,
} from './fleet.js';
import { isAllowedDashboardUrl } from './nav-guard.js';
import {
  nextInQueue, planNotifications, readNotifyPrefs, writeNotifyPrefs,
  type AttentionMap, type AttentionRow, type QueueEntry,
} from './notify.js';
import { addProject, assertGitRepo, forgetProject, readProjects } from './projects.js';
import { lastLines, spawnServe, type SpawnHandle } from './spawn.js';

const here = dirname(fileURLToPath(import.meta.url));
const brand = loadBrand();
const spawns = new Map<string, SpawnHandle>();

let mainWindow: BrowserWindow | null = null;
let dashView: BrowserView | null = null;
let tray: Tray | null = null;
let quitting = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let attentionTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Notification state. `attentionSeen === null` means "never polled" — the first
 * sweep seeds the baseline silently, see electron/notify.ts:planNotifications.
 */
let attentionSeen: AttentionMap | null = null;
let attentionQueue: QueueEntry[] = [];
let lastJumpKey: string | null = null;
let notifyPrefs = { enabled: true };

/**
 * How often the desktop asks every running daemon what its worktrees look like.
 *
 * `/api/worktrees` rides the poller's own git scan (`src/server.ts:2368`) but it
 * is still a round trip per project, and a stall is 45 minutes old by definition
 * (`STALL_GRACE_MS`) — so a minute is the same reasoning `STALL_SCAN_MS`
 * (`src/poller.ts:32`) already settled on, and costs ~1/30th of the fleet tick.
 */
const ATTENTION_MS = 60_000;

/** The hotkey. Alt keeps it clear of the platform's own Cmd/Ctrl+Shift space. */
const ATTENTION_HOTKEY = 'CommandOrControl+Alt+W';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

async function mergeFleet(): Promise<FleetRow[]> {
  const live = await listFleet();
  const byRoot = new Map(live.map((r) => [r.root, r]));
  const rows: FleetRow[] = [...live];
  for (const root of readProjects()) {
    if (byRoot.has(root)) continue;
    rows.push({
      pid: null,
      port: null,
      root,
      name: basename(root),
      state: existsSync(root) ? 'stopped' : 'missing',
      startedAt: null,
      writeEnabled: false,
      host: false,
      version: null,
    });
  }
  return rows;
}

function emitFleetChanged(): void {
  mainWindow?.webContents.send('fleet:changed');
  void refreshTray();
}

function uiPath(): string {
  const built = join(here, '..', 'ui-dist', 'index.html');
  if (existsSync(built)) return built;
  return join(here, '..', 'ui', 'index.html');
}

function createWindow(): void {
  const icon = join(brandingDir(), 'icons', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    title: brand.productName,
    backgroundColor: '#0f1115',
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const entry = uiPath();
  if (existsSync(entry)) void mainWindow.loadFile(entry);
  else void mainWindow.loadURL(process.env.BATON_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5174');

  mainWindow.on('close', (e) => {
    // Close ≠ quit while tray is watching (Linux falls back to quit if tray failed).
    if (!quitting && tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; dashView = null; });
}

function closeDashboard(): void {
  if (!mainWindow || !dashView) return;
  mainWindow.setBrowserView(null);
  dashView = null;
}

async function openDashboard(port: number): Promise<void> {
  if (!mainWindow) return;
  const ports = new Set(
    (await mergeFleet()).filter((r) => r.port != null).map((r) => r.port!),
  );
  ports.add(port);
  closeDashboard();
  dashView = new BrowserView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.setBrowserView(dashView);
  const [w, h] = mainWindow.getContentSize();
  dashView.setBounds({ x: 0, y: 48, width: w, height: Math.max(100, h - 48) });
  dashView.setAutoResize({ width: true, height: true });

  dashView.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedDashboardUrl(url, ports)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  dashView.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedDashboardUrl(url, ports)) {
      event.preventDefault();
      console.warn('[nav-guard] blocked', url);
      void shell.openExternal(url);
    }
  });
  await dashView.webContents.loadURL(`http://127.0.0.1:${port}/`);

  const watch = setInterval(() => {
    void listFleet().then((rows) => {
      const still = rows.some((r) => r.port === port && r.state === 'running');
      if (!still) {
        clearInterval(watch);
        closeDashboard();
        if (mainWindow) {
          void dialog.showMessageBox(mainWindow, {
            type: 'info',
            message: 'That project stopped',
            detail: 'Returning to the fleet list.',
          });
        }
      }
    });
  }, 3000);
}

/* ------------------------------------------------------------------ */
/* Attention: notifications, dock badge, hotkey                        */
/* ------------------------------------------------------------------ */

/**
 * Ask one daemon what its worktrees look like. Read-only and un-gated
 * (`src/server.ts:2368`), so this works against a daemon started without
 * `--write` too.
 *
 * Every failure mode is "this project contributes no rows this tick": a daemon
 * that just stopped must never be reported as a fleet of abandoned worktrees.
 */
async function fetchAttentionRows(row: FleetRow): Promise<AttentionRow[]> {
  if (row.port == null) return [];
  try {
    const res = await fetch(`http://127.0.0.1:${row.port}/api/worktrees`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return [];
    const body = await res.json() as Array<{
      slug?: string; health?: string; state?: string | null;
      branch?: string | null; quietForMs?: number | null;
    }>;
    if (!Array.isArray(body)) return [];
    return body
      .filter((w): w is { slug: string; health: string } & typeof w =>
        typeof w.slug === 'string' && typeof w.health === 'string')
      .map((w) => ({
        root: row.root,
        projectName: row.name,
        port: row.port,
        slug: w.slug,
        // `health` is consumed verbatim — the four-state vocabulary is derived
        // once, in `deriveHealth` (`src/worktrees.ts:168`). Nothing here decides
        // what "stalled" means.
        health: w.health,
        state: w.state ?? null,
        branch: w.branch ?? null,
        quietForMs: w.quietForMs ?? null,
      }));
  } catch {
    return [];
  }
}

/** Dock badge (macOS), taskbar count (Linux). Never throws the tick. */
function setBadge(count: number): void {
  try {
    if (typeof app.setBadgeCount === 'function') app.setBadgeCount(count);
  } catch { /* unsupported platform — the tray tooltip still carries the count */ }
}

/**
 * One sweep: read health from every running daemon, ask notify.ts what that
 * means, then do exactly what it says. All the judgement is in the pure
 * function; this is the adapter.
 */
async function refreshAttention(): Promise<void> {
  const running = (await listFleet()).filter((r) => r.state === 'running' && r.port != null);
  const rows = (await Promise.all(running.map(fetchAttentionRows))).flat();
  const plan = planNotifications(attentionSeen, rows, notifyPrefs);
  attentionSeen = plan.next;
  attentionQueue = plan.queue;
  setBadge(plan.badge);

  if (!Notification.isSupported()) return;
  for (const n of plan.notifications) {
    const note = new Notification({ title: n.title, body: n.body });
    // Clicking a notification must land on the thing it is about, or it is just
    // an interruption with no action attached.
    note.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      lastJumpKey = n.key;
      if (n.port != null) void openDashboard(n.port);
    });
    note.show();
  }
}

/**
 * The hotkey: jump to the next worktree needing attention, worst first.
 *
 * Deliberately a PULL. It answers even when notifications are switched off —
 * turning the shouting off is not the same as giving up the ability to ask.
 */
function jumpToNextAttention(): void {
  const target = nextInQueue(attentionQueue, lastJumpKey);
  mainWindow?.show();
  mainWindow?.focus();
  if (!target) {
    lastJumpKey = null;
    mainWindow?.webContents.send('attention:none');
    return;
  }
  lastJumpKey = target.key;
  mainWindow?.webContents.send('attention:jump', target);
  if (target.port != null) void openDashboard(target.port);
}

/** Flip the preference, persist it, and act on it immediately. */
function setNotifyEnabled(enabled: boolean): { enabled: boolean } {
  notifyPrefs = writeNotifyPrefs({ enabled });
  if (!enabled) setBadge(0);
  else void refreshAttention();
  void refreshTray();
  return notifyPrefs;
}

async function refreshTray(): Promise<void> {
  if (!tray) return;
  const rows = (await listFleet()).filter((r) => r.state === 'running');
  tray.setToolTip(`${brand.productName} — ${rows.length} running`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: brand.productName, enabled: false },
    // Windows and Linux have no app menu, so the tray is the only place the
    // About panel is reachable there.
    { label: `About ${brand.productName}`, click: () => app.showAboutPanel() },
    { type: 'separator' },
    ...rows.map((r) => ({
      label: `${r.name} :${r.port}`,
      submenu: [
        {
          label: 'Stop',
          click: () => {
            if (r.pid != null && r.port != null) {
              void stopFleetDaemon(r.pid, r.port).then(emitFleetChanged);
            }
          },
        },
        {
          label: 'Open',
          click: () => {
            mainWindow?.show();
            if (r.port != null) void openDashboard(r.port);
          },
        },
      ],
    })),
    { type: 'separator' },
    {
      label: 'Notifications',
      type: 'checkbox' as const,
      checked: notifyPrefs.enabled,
      click: (item: { checked: boolean }) => { setNotifyEnabled(item.checked); },
    },
    {
      label: 'Next needing attention',
      accelerator: ATTENTION_HOTKEY,
      enabled: attentionQueue.length > 0,
      click: () => { jumpToNextAttention(); },
    },
    { type: 'separator' },
    { label: 'Show', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Quit', click: () => { void quitApp(); } },
  ]));
}

function createTray(): void {
  const iconFile = join(brandingDir(), 'icons', 'tray.png');
  const fallback = join(brandingDir(), 'icons', 'icon.png');
  const path = existsSync(iconFile) ? iconFile : fallback;
  let image = nativeImage.createEmpty();
  if (existsSync(path)) {
    image = nativeImage.createFromPath(path);
    if (process.platform === 'darwin') image = image.resize({ width: 16, height: 16 });
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVQ4T2NkYGD4z0ABYBw1gGE0DAB+0Ab6g9k1YAAAAABJRU5ErkJggg==',
    ) : image);
  } catch {
    tray = null;
    return;
  }
  void refreshTray();
}

async function quitApp(): Promise<void> {
  const live = (await listFleet()).filter((r) => r.state === 'running');
  if (live.length > 0) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Leave running', 'Stop all', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `${live.length} project(s) still running`,
      detail: 'Quitting does not have to stop your daemons.',
    });
    if (response === 2) return;
    if (response === 1) {
      for (const r of live) {
        if (r.pid != null && r.port != null) await stopFleetDaemon(r.pid, r.port);
      }
    }
  }
  quitting = true;
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle('brand:get', () => loadBrand());
  ipcMain.handle('fleet:list', () => mergeFleet());
  ipcMain.handle('fleet:stop', async (_e, pid: number, port: number) => {
    const out = await stopFleetDaemon(pid, port);
    emitFleetChanged();
    return out;
  });
  ipcMain.handle('fleet:clean', async (_e, pid: number, port: number) => {
    await cleanFleetRecord(pid, port);
    emitFleetChanged();
  });
  ipcMain.handle('fleet:clean-dead', async () => {
    const n = await cleanDeadFleetRecords();
    emitFleetChanged();
    return n;
  });
  ipcMain.handle('shell:open-external', async (_e, url: string) => { await shell.openExternal(url); });
  ipcMain.handle('projects:add', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'cancelled' };
    const root = res.filePaths[0];
    try {
      assertGitRepo(root);
      addProject(root);
      emitFleetChanged();
      return { ok: true, root };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('projects:forget', async (_e, root: string) => {
    forgetProject(root);
    emitFleetChanged();
  });
  ipcMain.handle('projects:start', async (_e, root: string, write: boolean) => {
    try {
      assertGitRepo(root);
      if ((await listFleet()).some((r) => r.root === root && r.state === 'running')) {
        return { ok: false, error: 'already running' };
      }
      const handle = spawnServe(root, { write: !!write });
      spawns.set(root, handle);
      handle.child.on('exit', (code) => {
        spawns.delete(root);
        if (code && code !== 0 && mainWindow) {
          void dialog.showMessageBox(mainWindow, {
            type: 'error',
            message: 'serve exited immediately',
            detail: lastLines(handle).join('\n') || `exit ${code}`,
          });
        }
        emitFleetChanged();
      });
      await new Promise((r) => setTimeout(r, 800));
      emitFleetChanged();
      return { ok: true, lines: lastLines(handle) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('dashboard:open', async (_e, port: number) => { await openDashboard(port); });
  ipcMain.handle('dashboard:close', () => { closeDashboard(); });
  ipcMain.handle('graphify:status', async (_e, port: number) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/kb`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return { ok: false, status: res.status };
      const body = await res.json() as {
        graphifyInstalled?: boolean;
        projects?: Array<{
          id: string; nodes?: number; edges?: number; building?: boolean; lastBuiltAt?: string | null;
        }>;
        merged?: { nodes?: number; edges?: number; building?: boolean; lastBuiltAt?: string | null } | null;
      };
      if (body.graphifyInstalled === false) {
        return {
          ok: true,
          graphifyInstalled: false,
          hint: 'graphify not installed — uv tool install graphifyy',
          projects: body.projects ?? [],
        };
      }
      return { ok: true, graphifyInstalled: true, ...body };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('graphify:stop', async (_e, port: number, projectId: string) => {
    // GraphifyPool is per-daemon; refusing stop when other projects share this backend (D4-E1).
    // Builds are left running on app quit (D4-E3) — never auto-kill here.
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/kb`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return { ok: false, error: `kb ${res.status}` };
      const body = await res.json() as { projects?: Array<{ id: string; building?: boolean }> };
      const projects = body.projects ?? [];
      const others = projects.filter((p) => p.id !== projectId);
      if (others.length > 0) {
        return {
          ok: false,
          error: `Shared graphify backend may affect ${others.length} other project(s) — stop refused`,
        };
      }
      const target = projects.find((p) => p.id === projectId);
      if (!target?.building) return { ok: true, detail: 'not building' };
      return { ok: false, error: 'Cancel rebuild from the dashboard KB panel (shared-process safe)' };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('notify:get', () => ({ ...notifyPrefs, queue: attentionQueue }));
  ipcMain.handle('notify:set', (_e, enabled: boolean) => setNotifyEnabled(!!enabled));
  ipcMain.handle('notify:next', () => { jumpToNextAttention(); });
  ipcMain.handle('cli:status', () => getCliInstallState());
  ipcMain.handle('cli:install', async () => {
    const cli = bundledCliPath();
    if (process.platform === 'win32') return installCliUserPath(dirname(cli));
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['Create symlink', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: `Add \`${brand.commandName}\` to your PATH?`,
      detail:
        `Creates a symlink so you can run \`${brand.commandName}\` from a terminal. `
        + 'Only links the CLI shipped with this app.',
    });
    if (response !== 0) return getCliInstallState();
    return installCliSymlink(cli);
  });
  ipcMain.handle('cli:uninstall', async (_e, deleteDataDir: boolean) => {
    if (deleteDataDir) {
      const { response } = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Keep data', 'Delete data directory'],
        defaultId: 0,
        cancelId: 0,
        message: 'Delete local knowledge base?',
        detail: 'Default is to keep graphs and memory. Uninstalling should not erase your work.',
      });
      if (response === 0) return uninstallCli({ deleteDataDir: false });
    }
    return uninstallCli({ deleteDataDir: !!deleteDataDir });
  });
}

/**
 * The OS-native About panel. Whatever name a distribution ships under, this is
 * where the authorship credit surfaces — see electron/attribution.ts for why it
 * does not come from brand.json.
 */
function applyAboutPanel(): void {
  if (typeof app.setAboutPanelOptions !== 'function') return; // older Electron / tests
  app.setAboutPanelOptions({
    applicationName: brand.productName,
    copyright: attributionLines(brand.productName).join('\n'),
    credits: `${ATTRIBUTION.upstreamName} — ${ATTRIBUTION.upstreamSource}`,
  });
}

app.whenReady().then(() => {
  app.setName(brand.productName);
  applyAboutPanel();
  registerIpc();
  createWindow();
  createTray();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
  pollTimer = setInterval(emitFleetChanged, 5000);
  // The preference is read once at startup and is the reason a user who turned
  // notifications off yesterday is not shouted at today (electron/notify.ts).
  notifyPrefs = readNotifyPrefs();
  try {
    globalShortcut.register(ATTENTION_HOTKEY, jumpToNextAttention);
  } catch { /* the combination is taken by another app — the tray item still works */ }
  void refreshAttention();
  attentionTimer = setInterval(() => { void refreshAttention(); }, ATTENTION_MS);
  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
  try {
    const { powerMonitor } = require('electron') as typeof import('electron');
    powerMonitor.on('resume', () => emitFleetChanged());
  } catch { /* tests */ }
});

app.on('window-all-closed', () => {
  if (process.platform === 'linux' && !tray) {
    quitting = true;
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (pollTimer) clearInterval(pollTimer);
  if (attentionTimer) clearInterval(attentionTimer);
  try { globalShortcut.unregisterAll(); } catch { /* never block the quit */ }
});
