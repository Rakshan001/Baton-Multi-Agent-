import { ImageResponse } from "next/og";

export const alt =
  "Baton — Plan on your expensive agent. Pass the baton to your cheap one.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0a0a0b";
const FG = "#f4f4f5";
const MUTED = "#a1a1aa";
const AMBER = "#ff9d2e";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: INK,
          color: FG,
        }}
      >
        <div style={{ display: "flex", fontSize: 40, fontWeight: 600 }}>
          <span style={{ color: AMBER }}>/</span>
          <span>baton</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 62, fontWeight: 700 }}>
            <span>Plan on your&nbsp;</span>
            <span style={{ color: AMBER }}>expensive</span>
            <span>&nbsp;agent.</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 62,
              fontWeight: 700,
              color: MUTED,
            }}
          >
            <span>Pass the baton to your cheap one.</span>
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
          <span>
            Coordinate Claude Code · Cursor · Codex · Gemini on one repo — open
            source
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
