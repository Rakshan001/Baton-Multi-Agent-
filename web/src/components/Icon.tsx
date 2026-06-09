/* ============================================================
   BATON — Icon set (lucide-style, 24px, stroke=currentColor)
   Ported from icons.jsx.
   ============================================================ */
import type { CSSProperties } from "react";

export const ICON_PATHS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-4.3-4.3",
  command: "M9 9V7a2 2 0 1 0-2 2h2Zm0 0h6m-6 0v6m6-6V7a2 2 0 1 1 2 2h-2Zm0 0v6m0 0v2a2 2 0 1 0 2-2h-2Zm-6 0v2a2 2 0 1 1-2-2h2Zm0 0h6",
  sun: "M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM12 1.5v2M12 20.5v2M3.5 12h-2M22.5 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
  monitor: "M4 4.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1ZM8.5 21h7M12 17v4",
  refresh: "M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M5 12.5 10 17.5 19.5 7",
  checkCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8.5 12l2.5 2.5 4.5-5",
  chevronDown: "M6 9.5 12 15.5 18 9.5",
  chevronRight: "M9.5 6 15.5 12 9.5 18",
  chevronLeft: "M14.5 6 8.5 12 14.5 18",
  chevronsRight: "M7 7l5 5-5 5M13 7l5 5-5 5",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  gitBranch: "M6.5 4v9m0 0a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0-9a2.5 2.5 0 1 0 0 0ZM17.5 7a2.5 2.5 0 1 0 0 0Zm0 2.5c0 4-4 3.5-7 5.5",
  gitMerge: "M6.5 7v10m0-10a2.5 2.5 0 1 0 0-.1ZM6.5 17a2.5 2.5 0 1 0 .1 0ZM17.5 14a2.5 2.5 0 1 0 .1 0Zm-.2-.1C17 10 13 10.5 8.5 8",
  gitCommit: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM3 12h6M15 12h6",
  gitPullRequest: "M6.5 7v10M6.5 7a2.5 2.5 0 1 0 0-.1ZM6.5 17a2.5 2.5 0 1 0 .1 0ZM17.5 17V9.5A2.5 2.5 0 0 0 15 7h-2.5m0 0 2-2m-2 2 2 2M17.5 17a2.5 2.5 0 1 0 .1 0Z",
  alertTriangle: "M10.3 4 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0ZM12 9v4M12 16.5v.5",
  alertOctagon: "M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5ZM12 8v4.5M12 16v.3",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  externalLink: "M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6",
  columns: "M4 4.5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM9.3 4.5v15M14.7 4.5v15",
  share: "M18 8a3 3 0 1 0 0-.1ZM6 15a3 3 0 1 0 0-.1ZM18 19a3 3 0 1 0 0-.1ZM8.6 13.6l6.8 4M15.4 6.4l-6.8 4",
  network: "M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM5 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 9v3M12 12 6.5 15M12 12l5.5 3",
  history: "M3.5 9A9 9 0 1 1 3 13.5M3.5 9V4.5M3.5 9H8M12 7.5V12l3 2",
  layers: "M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12.5 12 17l9-4.5M3 17 12 21.5 21 17",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 .9-1.4V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.4.9H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5.9Z",
  bot: "M12 3v3M7 8h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM4 13H3M21 13h-1M9.5 12.5v1.5M14.5 12.5v1.5",
  grid: "M4 4.5h6v6H4zM14 4.5h6v6h-6zM4 14.5h6v6H4zM14 14.5h6v6h-6z",
  grip: "M9 6a1 1 0 1 0 .01 0ZM15 6a1 1 0 1 0 .01 0ZM9 12a1 1 0 1 0 .01 0ZM15 12a1 1 0 1 0 .01 0ZM9 18a1 1 0 1 0 .01 0ZM15 18a1 1 0 1 0 .01 0Z",
  maximize: "M8 3H4a1 1 0 0 0-1 1v4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M3 16v4a1 1 0 0 0 1 1h4",
  minimize: "M8 3v3a1 1 0 0 1-1 1H4M16 3v3a1 1 0 0 0 1 1h3M20 16h-3a1 1 0 0 0-1 1v3M4 16h3a1 1 0 0 1 1 1v3",
  fileWarning: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7l-4-4ZM13 3v4h4M12 11v3M12 17v.3",
  panelRight: "M4 4.5h16a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1ZM15 4.5v15",
  terminal: "M5 6l5 5-5 5M12 17h7",
  zap: "M13 3 5 13h6l-1 8 8-10h-6l1-8Z",
  dot: "M12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3.5 2",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5Z",
  folder: "M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  trash: "M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6",
  play: "M7 5l12 7-12 7V5Z",
  pause: "M8 5v14M16 5v14",
  link: "M9 15l6-6M10.5 6.5l1.8-1.8a4 4 0 0 1 5.7 5.7l-1.8 1.8M13.5 17.5l-1.8 1.8a4 4 0 0 1-5.7-5.7l1.8-1.8",
  sparkle: "M12 3c.7 4.5 3.5 7.3 8 8-4.5.7-7.3 3.5-8 8-.7-4.5-3.5-7.3-8-8 4.5-.7 7.3-3.5 8-8Z",
  inbox: "M3 13l3-8a1 1 0 0 1 1-.7h10a1 1 0 0 1 1 .7l3 8M3 13v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5M3 13h5l1.5 2.5h5L16 13h5",
  wifiOff: "M2 4l20 20M8.5 11.5a7 7 0 0 1 4-1.4M5 8.5A12 12 0 0 1 8 6.7M16 10.5a7 7 0 0 1 2 1M19.5 8.5a12 12 0 0 0-3-2M12 18.5h.01",
  moreH: "M5 12a1 1 0 1 0 .01 0ZM12 12a1 1 0 1 0 .01 0ZM19 12a1 1 0 1 0 .01 0Z",
  cornerUpRight: "M5 19v-7a3 3 0 0 1 3-3h11M15 5l4 4-4 4",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({
  name, size = 16, strokeWidth = 1.75, className, style, fill = "none",
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
  fill?: string;
}) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  const filledDot = name === "dot";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} style={style}
      fill={filledDot ? "currentColor" : fill} stroke={filledDot ? "none" : "currentColor"}
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path d={d} />
    </svg>
  );
}
