// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop shell. Spawns `serve` as a sibling Node process; never imports the
 * HTTP server. Fleet ops go through fleet.ts → dist/daemons.js.
 */
import {
  app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray,
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
});
