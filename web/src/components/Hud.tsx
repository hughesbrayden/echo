"use client";

import { useEffect, useState } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import type { Announcement } from "@/lib/announce";
import type { Motion } from "@/lib/motion";
import type { Narration } from "@/lib/narrator";

type Answers = NonNullable<FrameResponse["answers"]>;

// Rough vertical field of view of a phone's main camera in portrait, degrees.
// Only used to place the horizon line, so close is good enough.
const VERTICAL_FOV_DEG = 62;

export type Severity = "alarm" | "warning" | "info" | "clear";

export function severityOf(a: Announcement | null): Severity {
  if (!a) return "info";
  if (a.kind === "clear") return "clear";
  if (a.kind === "warning") return a.urgent ? "alarm" : "warning";
  return "info";
}

// Urgency 0..3 as the HUD's colour scale.
function urgencyTone(urgency: number): Severity {
  if (urgency >= 2) return "alarm";
  if (urgency >= 1) return "warning";
  return "info";
}

const TONE_TEXT: Record<Severity, string> = {
  alarm: "text-[var(--hud-alarm)]",
  warning: "text-[var(--hud-warn)]",
  info: "text-[var(--hud-accent)]",
  clear: "text-[var(--hud-ok)]",
};
const TONE_BG: Record<Severity, string> = {
  alarm: "bg-[var(--hud-alarm)]",
  warning: "bg-[var(--hud-warn)]",
  info: "bg-[var(--hud-accent)]",
  clear: "bg-[var(--hud-ok)]",
};

// Top status strip: wordmark, live state, session clock, link health.
export function StatusBar({
  live,
  startedAt,
  sent,
  latencyMs,
  stub,
}: {
  live: boolean;
  startedAt: number | null;
  sent: number;
  latencyMs: number | null;
  stub: boolean;
}) {
  const now = useNow(live);
  const elapsed = live && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const fps = latencyMs ? (1000 / Math.max(latencyMs, 500)).toFixed(1) : "–";

  return (
    <div className="hud-glass flex items-center justify-between gap-3 rounded-2xl px-3 py-2">
      <div className="flex items-center gap-2">
        <EchoMark className="h-5 w-5 text-[var(--hud-accent)]" />
        <span className="text-sm font-semibold tracking-[0.3em]">ECHO</span>
      </div>
      <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-white/70">
        {live && (
          <>
            <span>{mm}:{ss}</span>
            <span className="hidden min-[380px]:inline">{sent} fr</span>
            <span>{latencyMs ?? "–"} ms</span>
            <span className="hidden min-[420px]:inline">{fps} Hz</span>
          </>
        )}
        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-widest ${
            live ? "bg-[var(--hud-alarm)]/15 text-[var(--hud-alarm)]" : "bg-white/10 text-white/60"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${live ? "hud-pulse bg-[var(--hud-alarm)]" : "bg-white/40"}`} />
          {live ? (stub ? "SIM" : "LIVE") : "STANDBY"}
        </span>
      </div>
    </div>
  );
}

// Corner brackets, centre reticle and an artificial horizon from camera pitch.
export function Viewfinder({ pitch, headOffset }: { pitch: number | null; headOffset: number | null }) {
  const horizon = pitch === null ? null : clamp(50 + (pitch / VERTICAL_FOV_DEG) * 100, 6, 94);
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {horizon !== null && (
        <div
          className="absolute inset-x-[12%] flex items-center gap-2 transition-[top] duration-300 ease-out"
          style={{ top: `${horizon}%` }}
        >
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/50" />
          <span className="font-mono text-[10px] tabular-nums text-white/60">
            {pitch! > 0 ? "+" : ""}
            {Math.round(pitch!)}°
          </span>
          <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/50" />
        </div>
      )}

      <div className="absolute left-1/2 top-1/2 h-10 w-10 -translate-x-1/2 -translate-y-1/2">
        <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-white/60" />
        <span className="absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-white/60" />
        <span className="absolute left-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white/60" />
        <span className="absolute right-0 top-1/2 h-px w-3 -translate-y-1/2 bg-white/60" />
        <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
      </div>

      {headOffset !== null && <HeadingTape offset={headOffset} />}
    </div>
  );
}

// A strip under the status bar: where the head points relative to the walk.
function HeadingTape({ offset }: { offset: number }) {
  // ±60° spans the tape; positive offset is looking left, so the marker moves left.
  const x = clamp(50 - (offset / 60) * 50, 4, 96);
  return (
    <div className="absolute inset-x-[18%] top-[calc(env(safe-area-inset-top)+4.25rem)] h-5">
      <div className="absolute inset-x-0 top-1/2 h-px bg-white/25" />
      {[0, 25, 50, 75, 100].map((t) => (
        <span
          key={t}
          className={`absolute top-1/2 w-px -translate-y-1/2 bg-white/40 ${t === 50 ? "h-3" : "h-1.5"}`}
          style={{ left: `${t}%` }}
        />
      ))}
      <span
        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 transition-[left] duration-300 ease-out"
        style={{ left: `${x}%` }}
      >
        <span className="block h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-[var(--hud-accent)]" />
      </span>
    </div>
  );
}

// A target box where the decision model places the main thing in view.
export function TargetMarker({ answers }: { answers: Answers | null | undefined }) {
  if (!answers || answers.subject === "other" || answers.hazard_close < 0.25) return null;
  const x = answers.direction === "left" ? 22 : answers.direction === "right" ? 78 : 50;
  const y = clamp(42 + answers.base_row * 10, 30, 88);
  const tone = urgencyTone(answers.urgency);
  const size = 64 + answers.distance * 28; // Closer things draw bigger.
  const label = answers.subject.replace(/_/g, " ");

  return (
    <div
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-300 ease-out"
      style={{ left: `${x}%`, top: `${y}%`, width: size, height: size }}
      aria-hidden
    >
      <div className={`hud-target absolute inset-0 ${TONE_TEXT[tone]}`} />
      <div
        className={`absolute left-1/2 top-full mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-black ${TONE_BG[tone]}`}
      >
        {label}
        {answers.meters !== null && ` · ${answers.meters} m`}
      </div>
    </div>
  );
}

// The decision model's main signals as bars.
export function SignalPanel({ answers }: { answers: Answers | null | undefined }) {
  const rows: { label: string; value: number; tone: Severity }[] = answers
    ? [
        { label: "HAZARD", value: answers.hazard_close, tone: answers.hazard_close >= 0.6 ? "alarm" : "warning" },
        { label: "SPEAK", value: answers.worth_saying, tone: "info" },
        { label: "URGENCY", value: answers.urgency / 3, tone: urgencyTone(answers.urgency) },
        { label: "PROXIMITY", value: answers.distance / 2, tone: answers.distance >= 1.5 ? "alarm" : "info" },
        { label: "GROUND", value: answers.ground_change, tone: answers.ground_change >= 0.5 ? "warning" : "info" },
      ]
    : [];

  return (
    <div className="hud-glass w-36 rounded-2xl p-3">
      <PanelTitle>Decision</PanelTitle>
      <div className="mt-2 flex flex-col gap-2">
        {rows.length === 0 && <p className="font-mono text-[10px] text-white/40">awaiting frame…</p>}
        {rows.map((r) => (
          <div key={r.label}>
            <div className="flex justify-between font-mono text-[9px] tracking-wider text-white/60">
              <span>{r.label}</span>
              <span className="tabular-nums text-white/90">{Math.round(r.value * 100)}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-[width] duration-300 ease-out ${TONE_BG[r.tone]}`}
                style={{ width: `${clamp(r.value * 100, 2, 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {answers && (
        <p className="mt-2.5 font-mono text-[9px] tabular-nums text-white/40">
          model {answers.latencyMs} ms{answers.stub && " · stub"}
        </p>
      )}
    </div>
  );
}

// Walking state from the phone's motion sensors.
export function MotionPanel({ motion, allowed }: { motion: Motion | null; allowed: boolean }) {
  return (
    <div className="hud-glass w-32 rounded-2xl p-3">
      <PanelTitle>Motion</PanelTitle>
      {!allowed ? (
        <p className="mt-2 text-[11px] leading-snug text-[var(--hud-warn)]">Sensors unavailable</p>
      ) : !motion ? (
        <p className="mt-2 font-mono text-[10px] text-white/40">calibrating…</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-1">
            <Chip on={motion.walking}>{motion.walking ? "WALK" : "STILL"}</Chip>
            <Chip on={motion.turning} tone="warning">
              {motion.turning ? "TURN" : "STEADY"}
            </Chip>
          </div>
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums">
            <Stat label="CAD" value={`${motion.cadence.toFixed(1)}/s`} />
            <Stat label="PITCH" value={`${Math.round(motion.pitch)}°`} />
            <Stat label="HEAD" value={`${Math.round(motion.headOffset)}°`} />
            <Stat label="YAW" value={`${Math.round(motion.yawRate)}°/s`} />
          </dl>
        </>
      )}
    </div>
  );
}

// The background narrator's running picture of the scene.
export function NarrationStrip({ narration }: { narration: { narration: Narration; latencyMs: number } | null }) {
  if (!narration) return null;
  const { summary, path, ground } = narration.narration;
  const pathTone: Severity = path === "open" ? "clear" : path === "obstructed" ? "warning" : "info";
  return (
    <div className="hud-glass rounded-2xl px-3.5 py-2.5">
      <div className="flex items-center justify-between">
        <PanelTitle>Scene</PanelTitle>
        <div className="flex gap-1 font-mono text-[9px] font-semibold tracking-wider">
          <span className={`rounded px-1.5 py-0.5 uppercase ${TONE_TEXT[pathTone]} bg-white/5`}>path {path}</span>
          {ground !== "unknown" && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 uppercase text-white/70">{ground.replace("_", " ")}</span>
          )}
        </div>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug text-white/85">{summary}</p>
    </div>
  );
}

// A red edge flash when the alarm sounds. Keyed by the caller so it replays.
export function AlarmFlash() {
  return <div className="hud-alarm-flash pointer-events-none absolute inset-0" aria-hidden />;
}

export function EchoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" opacity={0.5} />
    </svg>
  );
}

export function PanelTitle({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] font-semibold tracking-[0.25em] text-white/45 uppercase">{children}</p>;
}

function Chip({ on, tone = "info", children }: { on: boolean; tone?: Severity; children: React.ReactNode }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider ${
        on ? `${TONE_BG[tone]} text-black` : "bg-white/10 text-white/60"
      }`}
    >
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-white/45">{label}</dt>
      <dd className="text-right text-white/90">{value}</dd>
    </>
  );
}

// The current time, ticking once a second while active. Starts at 0 so the
// server render stays deterministic; callers clamp the first tick.
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
