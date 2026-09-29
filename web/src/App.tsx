// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — App root
   Data + overlays live here; the frame is the Orca-style shell in
   ./shell (sidebar · top bar · ⌘K palette · right detail sheet).
   Screens are addressed by hash routes (lib/routes.ts) so every one of
   them can be deep-linked, including from notifications.
   ============================================================ */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { Icon } from "./components/Icon";
import { ToastViewport } from "./components/Toast";
import { TweaksPanel } from "./components/TweaksPanel";
import { TooltipProvider } from "./components/ui/tooltip";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./components/ui/sheet";
import { usePrefs, ls } from "./hooks/usePrefs";
import { useStatus, useRootAgents, useHistory, usePoll } from "./hooks/usePoll";
import { useEvents } from "./hooks/useEvents";
import { BatonAPI } from "./lib/api";
import { showToast } from "./lib/toast";
import { WORKSPACE } from "./lib/preview";
import { pathFor, routeForPath } from "./lib/routes";
import { loadConnections, projectFromMeta, DEFAULT_CONNECTION, type Connection } from "./lib/connections";
import type { ScenarioName } from "./lib/demoData";
import { CommandCenter } from "./features/CommandCenter";
import { KnowledgeGraphScreen } from "./features/KnowledgeGraph";
import { ActivityScreen } from "./features/Activity";
import { ConflictsScreen } from "./features/Conflicts";
import { HistoryScreen } from "./features/History";
import { AgentsScreen } from "./features/Agents";
import { SkillsScreen } from "./features/Skills";
import { SettingsScreen } from "./features/Settings";
import { Connect } from "./features/Connect";
import { SignIn } from "./features/SignIn";
import { DetailSheet } from "./features/Detail";
import { DiffViewer } from "./features/Diff";
import { HandoffDialog } from "./features/Handoff";
import { LaunchSession } from "./features/Launch";
import { LiveSession } from "./features/Live";
import { MemoryScreen } from "./features/Memory";
import { PipelineScreen } from "./features/Pipeline";
import { ReviewsScreen } from "./features/Reviews";
import { TeamScreen } from "./features/Team";
import { SidebarContent } from "./shell/Sidebar";
import { TopBar } from "./shell/TopBar";
import { CommandPalette } from "./shell/CommandPalette";
import { useTeamSync } from "./shell/teamSync";
import { prefersSimpleMode, roleSummary, teamApi, unreadCount, useTeamWorkspace } from "./lib/teamApi";
import { ConfirmHost } from "./features/team/confirm";
import { PeopleScreen } from "./features/team/People";
import { TeamBoardScreen } from "./features/team/Board";
import { InboxScreen } from "./features/team/Inbox";
import { WorkloadScreen } from "./features/team/Workload";
import { ProfileScreen } from "./features/team/Profile";
import { SimpleModeScreen } from "./features/team/SimpleMode";
import { PairingScreen } from "./features/team/Pairing";
import { TeamAdminScreen } from "./features/team/TeamAdmin";
import { TaskSheet } from "./features/team/TaskSheet";
import { nameHue } from "./features/team/ui";
import type { Meta, AgentId, Project, AgentRosterEntry } from "./types";

/**
 * "The daemon stopped answering, and everything below is the last thing we
 * knew" — said once, across the full width, above everything.
 *
 * Deliberately not a toast: a toast is for something that just happened and
 * then stops mattering. This matters for exactly as long as it is true, and it
 * has to still be there when someone opens the laptop an hour later.
 */
function StaleBanner({ since, onRetry, retrying }: {
  since: number | null; onRetry: () => void; retrying: boolean;
}) {
  const [, force] = useState(0);
  // Re-render on a timer so "1m ago" does not sit frozen at "1s ago" — the age
  // IS the message here, and a stale staleness notice would be its own joke.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);
  const age = since === null ? null : Math.max(0, Math.round((Date.now() - since) / 1000));
  const ago = age === null ? "before the first load"
    : age < 60 ? `${age}s ago`
      : age < 3600 ? `${Math.floor(age / 60)}m ago`
        : `${Math.floor(age / 3600)}h ago`;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", gap: 10, flex: "none",
      padding: "8px 16px", fontSize: "var(--fs-12)",
      color: "var(--conflict-text)", background: "var(--conflict-soft)",
      borderBottom: "1px solid var(--conflict-border)",
    }}>
      <Icon name="wifiOff" size={13} style={{ flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ fontWeight: "var(--fw-semibold)" }}>Not connected to the daemon.</strong>{" "}
        Everything below is the last data received, {ago} — sessions may have started or stopped since.
      </span>
      <button className="btn fr" style={{ height: 26, flex: "none" }} onClick={onRetry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

/** Module-level so the identity is stable — a new function each render would
 *  resubscribe on every render. */
const subscribeApi = (fn: () => void) => BatonAPI.subscribe(fn);

/** Read before HashRouter mounts — it normalises an empty hash to `#/`. */
const INITIAL_HASH = typeof window !== "undefined" ? window.location.hash : "";

export default function App() {
  return (
    <HashRouter>
      <TooltipProvider delayDuration={300}>
        <AppInner />
      </TooltipProvider>
    </HashRouter>
  );
}

function AppInner() {
  const prefs = usePrefs();
  const location = useLocation();
  const routerNavigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const [diffSlug, setDiffSlug] = useState<string | null>(null);
  const [handoffSlug, setHandoffSlug] = useState<string | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState<{ agent: AgentId | null } | null>(null);
  const [liveSlug, setLiveSlug] = useState<string | null>(null);
  const [filter, setFilter] = useState<"conflict" | "ready" | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [projectId, setProjectId] = useState(() => BatonAPI.project);
  const [scenario, setScenarioState] = useState<ScenarioName>(() => BatonAPI.scenario);
  const [demo, setDemoState] = useState(() => BatonAPI.demo);
  const setDemo = (v: boolean) => { BatonAPI.setDemo(v); setDemoState(v); };
  const [connections, setConnections] = useState<Connection[]>(loadConnections);
  const [connectionId, setConnectionId] = useState(() => BatonAPI.connectionId);
  const [simpleMode, setSimpleModeRaw] = useState<boolean>(() => ls.get("baton:simpleMode", false));
  const setSimpleMode = (v: boolean) => { setSimpleModeRaw(v); ls.set("baton:simpleMode", v); };
  const activeConn = connections.find((c) => c.id === connectionId) ?? DEFAULT_CONNECTION;
  const teamWs = useTeamWorkspace();
  const { sync, setDemoState: setDemoSync } = useTeamSync(demo, teamWs);
  // The daemon has refused this browser's credential (or we never had one).
  // Subscribed rather than polled so the gate appears the instant any request
  // or the event stream is turned away.
  const needsAuth = useSyncExternalStore(subscribeApi, () => BatonAPI.needsAuth);

  const events = useEvents({ enabled: !prefs.offline && !demo, baseUrl: activeConn.baseUrl });
  const status = useStatus(events.live);
  const rootAgents = useRootAgents();
  const history = useHistory(events.live);
  const meta = usePoll<Meta>(() => BatonAPI.getMeta(), { interval: 30000, deps: [connectionId] });
  const agents = usePoll<AgentRosterEntry[]>(() => BatonAPI.getAgents(), { interval: 8000, deps: [connectionId] });

  // Real mode: the UI's write capability follows the daemon (`baton serve --write`)
  // instead of hiding behind a per-browser toggle. Demo mode keeps pure prefs.
  const daemonWrite = demo ? null : (meta.data ? !!meta.data.writeEnabled : null);
  useEffect(() => {
    prefs.followDaemonWrite(daemonWrite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemonWrite]);

  // One source of truth for "where am I": the hash. The old `baton:route`
  // value is still written (as a route id) so a bare URL reopens the last
  // screen, exactly as before hash routing.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (location.pathname === "/" && (INITIAL_HASH === "" || INITIAL_HASH === "#")) {
      const saved = ls.get<string>("baton:route", "home");
      const path = pathFor(saved);
      if (path !== "/") routerNavigate(path, { replace: true });
    }
  }, [location.pathname, routerNavigate]);
  const routeId = routeForPath(location.pathname).id;
  useEffect(() => { ls.set("baton:route", routeId); }, [routeId]);

  const navigate = useCallback((id: string) => routerNavigate(pathFor(id)), [routerNavigate]);
  // ⌘K data hits deep-link into a screen with its search pre-filled.
  const [searchSeed, setSearchSeed] = useState<{ route: string; q: string; n: number }>({ route: "", q: "", n: 0 });
  const seedSearch = useCallback((r: string, q: string) => { setSearchSeed((s) => ({ route: r, q, n: s.n + 1 })); navigate(r); }, [navigate]);
  const onOpen = useCallback((slug: string) => setSelected(slug), []);
  const onLaunch = useCallback((agent: AgentId | null) => setLaunchOpen({ agent }), []);
  const onLive = (slug: string) => setLiveSlug(slug);

  const project: Project = demo
    ? (WORKSPACE.projects.find((p) => p.id === projectId) || WORKSPACE.projects[0])
    : projectFromMeta(activeConn, meta.data ?? null);
  const onProject = (id: string) => {
    const clearSelection = () => { setSelected(null); setFilter(null); setDiffSlug(null); setHandoffSlug(null); setLiveSlug(null); setLaunchOpen(null); };
    if (demo) {
      if (id === projectId) return;
      setProjectId(id);
      clearSelection();
      BatonAPI.setProject(id);
      const p = WORKSPACE.projects.find((x) => x.id === id)!;
      showToast({ kind: "info", title: `Switched to ${p.name}`, desc: p.path });
      return;
    }
    if (id === connectionId) return;
    const conn = connections.find((c) => c.id === id);
    if (!conn) return;
    setConnectionId(conn.id);
    clearSelection();
    BatonAPI.setConnection(conn);
    status.refetch(); history.refetch(); meta.refetch();
    showToast({ kind: "info", title: `Switched to ${conn.name}`, desc: conn.baseUrl || "this origin", mono: true });
  };
  const setScenario = (s: ScenarioName) => {
    setScenarioState(s);
    setSelected(null); setFilter(null);
    BatonAPI.setScenario(s);
    const desc: Record<ScenarioName, string> = {
      busy: "Several active agents, live conflicts, work ready to merge.",
      calm: "Mostly clean, one agent working.",
      empty: "No sessions yet.",
      offline: "The daemon is unreachable.",
    };
    showToast({ kind: "info", title: `Scenario: ${s}`, desc: desc[s] });
  };

  // ⌘K / Ctrl+K
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const sessions = status.data || [];
  const conflicts = sessions.filter((s) => s.status === "conflict").length;
  const apiState = prefs.offline || status.error ? "offline" : status.isFetching ? "fetching" : "online";
  const viewer = meta.data?.viewer;
  // Demo: the team viewer (switchable under "View as"). Real: the daemon's viewer.
  const teamViewer = teamWs?.people.find((p) => p.id === teamWs.viewerId);
  const pname = (k: string) => teamWs?.projects.find((p) => p.key === k)?.name ?? k;
  const userName = teamViewer?.name ?? viewer?.name ?? "You";
  const userRole = teamViewer
    ? roleSummary(teamViewer, pname)
    : viewer?.role ? (viewer.role === "owner" ? "Owner" : "Member") : viewer?.local ? "This machine" : null;
  const inboxUnread = unreadCount(teamWs);
  const viewAs = demo && teamWs ? {
    people: teamWs.people.map((p) => ({ id: p.id, name: p.name, role: roleSummary(p, pname) })),
    current: teamWs.viewerId,
    onChange: (id: string) => { teamApi.setViewer(id); setSimpleMode(prefersSimpleMode(teamWs.people.find((p) => p.id === id))); },
  } : undefined;

  // connection phase, derived from the real first status poll
  const firstLoadDone = status.data !== null || status.error !== null;
  const phase: "connecting" | "connected" | "offline" =
    prefs.offline ? "offline" : !firstLoadDone ? "connecting" : status.error && !status.data ? "offline" : "connected";

  // clear the retry spinner once a refetch settles
  useEffect(() => { if (retrying && !status.isFetching) setRetrying(false); }, [retrying, status.isFetching]);
  const retry = () => { setRetrying(true); status.refetch(); history.refetch(); meta.refetch(); };

  const tweaks = <TweaksPanel prefs={prefs} scenario={scenario} setScenario={setScenario} demo={demo} setDemo={setDemo} />;
  const toasts = <ToastViewport />;

  // The credential gate stands in FRONT of the offline screen, and the order
  // matters: a 401 means the daemon is up and does not know us. Showing
  // "Baton isn't running" there would send a member off to debug the one
  // machine that is working fine.
  if (needsAuth && !demo) {
    return (
      <div className="h-full">
        <SignIn baseUrl={activeConn.baseUrl} refused={!!BatonAPI.token}
          onSignedIn={() => { status.refetch(); history.refetch(); meta.refetch(); agents.refetch(); }} />
        {tweaks}{toasts}
      </div>
    );
  }

  if (phase !== "connected") {
    return (
      <div className="h-full">
        <Connect phase={phase === "connecting" ? "connecting" : "offline"} onRetry={retry} retrying={retrying}
          alternatives={!demo && connections.length > 1 ? connections.filter((c) => c.id !== connectionId) : []}
          onPick={onProject} />
        {tweaks}{toasts}
      </div>
    );
  }

  const seed = (r: string) => (searchSeed.route === r ? searchSeed : undefined);
  const w = prefs.writeEnabled;
  const home = <CommandCenter status={status} rootAgents={rootAgents.data ?? []} view={prefs.view} setView={prefs.setView} onOpen={onOpen} writeEnabled={w} filter={filter} setFilter={setFilter} project={project} onNewSession={() => onLaunch(null)} />;

  const classicTeam = <TeamScreen writeEnabled={w} subscribe={events.subscribe} knownProjects={(meta.data?.projects ?? []).map((p) => p.id)} />;

  const selectedRow = (slug: string | null) => sessions.find((s) => s.slug === slug);

  /*
   * Connected once, unreachable now.
   *
   * `phase` only reports "offline" when there is NO data, so a link that dies
   * after the first load leaves the whole board rendering its last snapshot —
   * counters, session cards, "N Active" — with nothing but a 12 px dot in the
   * header to say otherwise. Over a tunnel that is the failure this dashboard
   * exists to prevent: you glance at it after the laptop woke up, read
   * "2 Active sessions", and believe it.
   *
   * The data stays (blanking it would throw away the last thing we truthfully
   * knew). What changes is that it stops claiming to be current.
   */
  const stale = !demo && !prefs.offline && apiState === "offline" && status.data !== null;

  const sidebarProps = {
    project, onProject, demo, connections, onConnectionsChange: setConnections, conflicts, inboxUnread,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}
        className="sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>
      {stale && <StaleBanner since={status.lastUpdated} onRetry={retry} retrying={retrying} />}
      <div className="flex min-h-0 flex-1">
        {/* Simple mode is one screen: no navigation to get lost in. */}
        {!simpleMode && <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
          <SidebarContent {...sidebarProps} />
        </aside>}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onMenu={() => setNavOpen(true)} onSearch={() => setCmdOpen(true)} onLaunch={() => onLaunch(null)}
            projectName={project.name} prefs={prefs} demo={demo} apiState={apiState} lastUpdated={status.lastUpdated}
            onRefresh={() => { status.refetch(); history.refetch(); }} live={events.live} reconnecting={events.reconnecting}
            sync={sync} onDemoSync={setDemoSync} userName={userName} userHue={teamViewer?.avatarHue ?? nameHue(userName)} userRole={userRole} viewAs={viewAs}
            simpleMode={simpleMode} onSimpleMode={setSimpleMode} />
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 bg-background focus:outline-none">
            <div key={routeId} className="h-full" style={{ animation: "route-in var(--dur-2) var(--ease-out)" }}>
              {simpleMode ? (
                <Routes>
                  <Route path="/board/task/:taskId" element={<><SimpleModeScreen onExit={() => setSimpleMode(false)} /><SimpleTaskSheet /></>} />
                  <Route path="*" element={<SimpleModeScreen onExit={() => setSimpleMode(false)} />} />
                </Routes>
              ) : (
                <Routes>
                  <Route path="/" element={home} />
                  <Route path="/activity" element={<ActivityScreen status={status} onOpen={onOpen} onOpenDiff={setDiffSlug} onHandoff={setHandoffSlug} onLive={onLive} />} />
                  <Route path="/pipeline" element={<PipelineScreen writeEnabled={w} />} />
                  <Route path="/conflicts" element={<ConflictsScreen status={status} onOpen={onOpen} />} />
                  <Route path="/graph" element={<KnowledgeGraphScreen writeEnabled={w} />} />
                  <Route path="/memory" element={<MemoryScreen writeEnabled={w} searchSeed={seed("memory")} />} />
                  <Route path="/reviews" element={<ReviewsScreen writeEnabled={w} searchSeed={seed("reviews")} />} />
                  <Route path="/history" element={<HistoryScreen history={history} onOpen={onOpen} searchSeed={seed("history")} />} />
                  <Route path="/agents" element={<AgentsScreen agents={agents} onOpen={onOpen} onLaunch={onLaunch} onHandoff={setHandoffSlug} writeEnabled={w} />} />
                  {/* Without a team workspace (real mode today) the classic v1 screen
                      manages members, so #/people and the legacy "team" route still work. */}
                  <Route path="/people" element={teamWs ? <PeopleScreen /> : classicTeam} />
                  <Route path="/people/:memberId" element={teamWs ? <PeopleScreen /> : classicTeam} />
                  <Route path="/board" element={<TeamBoardScreen />} />
                  <Route path="/board/task/:taskId" element={<TeamBoardScreen />} />
                  <Route path="/inbox" element={<InboxScreen />} />
                  <Route path="/inbox/:itemId" element={<InboxScreen />} />
                  <Route path="/workload" element={<WorkloadScreen />} />
                  <Route path="/skills" element={<SkillsScreen writeEnabled={w} searchSeed={seed("skills")} />} />
                  <Route path="/settings" element={<SettingsScreen prefs={prefs} repo={meta.data?.repo ?? null} viewer={meta.data?.viewer} meta={meta.data} />} />
                  <Route path="/settings/team" element={teamWs ? <TeamAdminScreen /> : classicTeam} />
                  {/* The v1 members / editing-now / teams / share screen: still the live one against a real daemon. */}
                  <Route path="/settings/team/classic" element={classicTeam} />
                  <Route path="/settings/team/pair" element={<PairingScreen />} />
                  <Route path="/profile" element={<ProfileScreen simpleMode={simpleMode} onSimpleMode={setSimpleMode} />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              )}
            </div>
          </main>
        </div>
      </div>

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" showCloseButton={false} className="w-72 max-w-[85vw] bg-sidebar p-0 md:hidden">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Switch project or screen</SheetDescription>
          <SidebarContent {...sidebarProps} onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>

      {selected && <DetailSheet slug={selected} onClose={() => setSelected(null)} writeEnabled={w} onOpenDiff={setDiffSlug} onHandoff={setHandoffSlug} onLive={onLive} />}
      {diffSlug && <DiffViewer slug={diffSlug} session={selectedRow(diffSlug)} onClose={() => setDiffSlug(null)} writeEnabled={w} onHandoff={(s) => { setDiffSlug(null); setHandoffSlug(s); }} />}
      {handoffSlug && <HandoffDialog slug={handoffSlug} session={selectedRow(handoffSlug)} onClose={() => setHandoffSlug(null)} writeEnabled={w} />}
      {liveSlug && <LiveSession slug={liveSlug} session={selectedRow(liveSlug)} sessions={sessions} onClose={() => setLiveSlug(null)} setSlug={setLiveSlug} onOpenDiff={(s) => { setLiveSlug(null); setDiffSlug(s); }} demo={demo} subscribe={events.subscribe} />}
      {launchOpen && <LaunchSession initialAgent={launchOpen.agent} onClose={() => setLaunchOpen(null)} writeEnabled={w} onLaunched={(slug) => setSelected(slug)} />}
      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} navigate={navigate} onOpen={onOpen} onLaunch={onLaunch}
        sessions={sessions} history={history.data || []} prefs={prefs} onSeedSearch={seedSearch} />
      <ConfirmHost />
      {tweaks}{toasts}
    </div>
  );
}

/** Task detail over simple mode (the card title links here); closing returns to My tasks. */
function SimpleTaskSheet() {
  const { taskId } = useParams();
  return taskId ? <TaskSheet id={taskId} back="/" /> : null;
}
