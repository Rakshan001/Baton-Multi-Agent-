// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getBrand: () => ipcRenderer.invoke('brand:get'),
  listFleet: () => ipcRenderer.invoke('fleet:list'),
  stopDaemon: (pid: number, port: number) => ipcRenderer.invoke('fleet:stop', pid, port),
  cleanRecord: (pid: number, port: number) => ipcRenderer.invoke('fleet:clean', pid, port),
  cleanDead: () => ipcRenderer.invoke('fleet:clean-dead'),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  addProject: () => ipcRenderer.invoke('projects:add'),
  forgetProject: (root: string) => ipcRenderer.invoke('projects:forget', root),
  startProject: (root: string, write: boolean) => ipcRenderer.invoke('projects:start', root, write),
  openDashboard: (port: number) => ipcRenderer.invoke('dashboard:open', port),
  closeDashboard: () => ipcRenderer.invoke('dashboard:close'),
  getGraphify: (port: number) => ipcRenderer.invoke('graphify:status', port),
  stopGraphify: (port: number, projectId: string) => ipcRenderer.invoke('graphify:stop', port, projectId),
  cliStatus: () => ipcRenderer.invoke('cli:status'),
  installCli: () => ipcRenderer.invoke('cli:install'),
  uninstallCli: (deleteDataDir: boolean) => ipcRenderer.invoke('cli:uninstall', deleteDataDir),
  onFleetChanged: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('fleet:changed', h);
    return () => ipcRenderer.removeListener('fleet:changed', h);
  },
};

contextBridge.exposeInMainWorld('desktop', api);
