// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from 'react';
import { api, type Brand, type FleetRow } from './desktop';
import './styles.css';

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= 0) return '—';
  const m = Math.floor((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export function App() {
  const [brand, setBrand] = useState<Brand | null>(null);
  const [rows, setRows] = useState<FleetRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [writeDefault, setWriteDefault] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [cliDetail, setCliDetail] = useState('');
  const [viewPort, setViewPort] = useState<number | null>(null);
  const [graphify, setGraphify] = useState<Record<number, string>>({});

  const refresh = async () => {
    try {
      const list = await api().listFleet();
      setRows(list);
      setError(null);
      for (const r of list) {
        if (r.state !== 'running' || r.port == null) continue;
        const port = r.port;
        void api().getGraphify(port).then((g) => {
          if (!g.ok) {
            setGraphify((p) => ({ ...p, [port]: g.error ?? '—' }));
            return;
          }
          if (g.graphifyInstalled === false) {
            setGraphify((p) => ({ ...p, [port]: g.hint ?? 'install graphifyy' }));
            return;
          }
          const projects = g.projects ?? [];
          const building = projects.some((p) => p.building);
          const nodes = projects.reduce((n, p) => n + (p.nodes ?? 0), 0);
          const edges = projects.reduce((n, p) => n + (p.edges ?? 0), 0);
          const last = projects.map((p) => p.lastBuiltAt).filter(Boolean).sort().at(-1) ?? null;
          const when = last ? relativeTime(last) : '';
          setGraphify((prev) => ({
            ...prev,
            [port]: building ? 'building…' : `${nodes}n · ${edges}e${when ? ` · ${when}` : ''}`,
          }));
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void api().getBrand().then((b) => {
      setBrand(b);
      document.title = b.productName;
      document.documentElement.style.setProperty('--accent', b.accentColor);
    });
    void refresh();
    void api().cliStatus().then((s) => setCliDetail(s.detail));
    return api().onFleetChanged(() => { void refresh(); });
  }, []);

  if (!brand) return <div className="boot">Loading…</div>;

  return (
    <div className="app">
      <header className="top">
        <div className="brand-block">
          <div>
            <h1>{brand.productName}</h1>
            <p className="tagline">{brand.tagline}</p>
          </div>
        </div>
        <div className="actions">
          <label className="write-toggle" title="Write mode grants repo mutation">
            <input type="checkbox" checked={writeDefault} onChange={(e) => setWriteDefault(e.target.checked)} />
            Start with write
          </label>
          <button
            type="button"
            disabled={busy === 'add'}
            onClick={() => {
              setBusy('add');
              void api().addProject().then((r) => {
                setBusy(null);
                if (!r.ok && r.error !== 'cancelled') setError(r.error ?? 'add failed');
                void refresh();
              });
            }}
          >
            Add project
          </button>
          <button type="button" onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {viewPort != null && (
        <div className="dash-bar">
          <button type="button" onClick={() => { void api().closeDashboard(); setViewPort(null); }}>
            ← Fleet
          </button>
          <span>Dashboard :{viewPort}</span>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      {rows.length === 0 ? (
        <div className="empty">
          <p>No projects yet — add one</p>
          <p className="muted">Remembered projects and running daemons appear here.</p>
        </div>
      ) : (
        <table className="fleet">
          <thead>
            <tr>
              <th>Project</th>
              <th>State</th>
              <th>Port</th>
              <th>Started</th>
              <th>Write</th>
              <th>Graphify</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.root}-${r.pid ?? 0}-${r.port ?? 0}`}>
                <td title={r.root}>{r.name}</td>
                <td><span className={`pill ${r.state}`}>{r.state}</span></td>
                <td>
                  {r.port != null ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => { void api().openDashboard(r.port!); setViewPort(r.port); }}
                    >
                      {r.port}
                    </button>
                  ) : '—'}
                </td>
                <td>{relativeTime(r.startedAt)}</td>
                <td>{r.writeEnabled ? <span className="pill write">write</span> : '—'}</td>
                <td className="muted">{r.port != null ? (graphify[r.port] ?? '—') : '—'}</td>
                <td className="row-actions">
                  {r.state === 'running' && r.pid != null && r.port != null && (
                    <>
                      <button type="button" onClick={() => void api().stopDaemon(r.pid!, r.port!).then(refresh)}>Stop</button>
                      <button type="button" onClick={() => { void api().openDashboard(r.port!); setViewPort(r.port); }}>Open</button>
                    </>
                  )}
                  {r.state === 'stale' && r.pid != null && r.port != null && (
                    <button type="button" onClick={() => void api().cleanRecord(r.pid!, r.port!).then(refresh)}>Clean up</button>
                  )}
                  {r.state === 'stopped' && (
                    <button
                      type="button"
                      disabled={busy === r.root}
                      onClick={() => {
                        setBusy(r.root);
                        void api().startProject(r.root, writeDefault).then((res) => {
                          setBusy(null);
                          if (!res.ok) setError(res.error ?? res.lines?.join('\n') ?? 'start failed');
                          void refresh();
                        });
                      }}
                    >
                      Start
                    </button>
                  )}
                  {r.state === 'missing' && (
                    <button type="button" onClick={() => void api().forgetProject(r.root).then(refresh)}>Forget</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="foot">
        <span className="muted">{cliDetail || `CLI: ${brand.commandName}`}</span>
        <button type="button" onClick={() => void api().installCli().then((s) => { if (s.detail) setCliDetail(s.detail); })}>
          Install CLI…
        </button>
        <button type="button" onClick={() => void api().uninstallCli(false).then((s) => { if (s.detail) setCliDetail(s.detail); })}>
          Remove CLI
        </button>
      </footer>
    </div>
  );
}
