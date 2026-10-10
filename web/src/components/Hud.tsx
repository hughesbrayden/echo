"use client";

import type { FrameResponse } from "@/app/api/frame/route";
import type { Announcement } from "@/lib/announce";
import type { Motion } from "@/lib/motion";
import type { Narration } from "@/lib/narrator";

type Answers = NonNullable<FrameResponse["answers"]>;

export type Severity = "stop" | "caution" | "info" | "calm";

export function severityOf(a: Announcement | null): Severity {
  if (!a) return "info";
  if (a.kind === "clear") return "calm";
  if (a.kind === "warning") return a.urgent ? "stop" : "caution";
  return "info";
}

// Urgency 0..3 as a colour.
function urgencyTone(urgency: number): Severity {
  if (urgency >= 2) return "stop";
  if (urgency >= 1) return "caution";
  return "info";
}

const TONE_BG: Record<Severity, string> = {
  stop: "bg-[var(--echo-stop)]",
  caution: "bg-[var(--echo-caution)]",
  info: "bg-[var(--echo-accent)]",
  calm: "bg-[var(--echo-calm)]",
};

// Top line: the name, whether Echo is listening, and what the wearer is doing.
export function TopBar({ live, motion, demo }: { live: boolean; motion: Motion | null; demo: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="echo-glass flex items-center gap-2 rounded-full py-1.5 pr-4 pl-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--echo-accent)]/20">
          <EchoMark className="h-5 w-5 text-[var(--echo-accent)]" />
        </span>
        <span className="text-lg font-semibold">Echo</span>
      </div>
      <div className="flex items-center gap-2">
        {live && motion && (
          <span className="echo-glass rounded-full px-3 py-2 text-sm text-white/85">
            {motion.walking ? "Walking" : "Standing"}
          </span>
        )}
        <span className="echo-glass flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium">
          <span
            className={`h-2.5 w-2.5 rounded-full ${live ? "echo-breathe bg-[var(--echo-calm)]" : "bg-white/40"}`}
          />
          {live ? (demo ? "Listening · demo" : "Listening") : "Ready"}
        </span>
      </div>
    </div>
  );
}

// A soft glow on the thing Echo is paying attention to, with its name.
export function FocusHalo({ answers }: { answers: Answers | null | undefined }) {
  if (!answers || answers.subject === "other" || answers.hazard_close < 0.25) return null;
  const x = answers.direction === "left" ? 24 : answers.direction === "right" ? 76 : 50;
  const y = clamp(42 + answers.base_row * 9, 32, 70);
  const tone = urgencyTone(answers.urgency);
  const size = 90 + answers.distance * 30; // Closer things glow bigger.
  const name = answers.subject.replace(/_/g, " ");

  return (
    <div
      className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 transition-all duration-500 ease-out"
      style={{ left: `${x}%`, top: `${y}%`, width: size, height: size }}
      aria-hidden
    >
      <div className={`echo-halo absolute inset-0 rounded-full ${TONE_BG[tone]}`} />
      <div className="absolute inset-0 rounded-full border-2 border-white/70" />
      <div className="absolute top-full left-1/2 mt-2 -translate-x-1/2 rounded-full bg-white px-3 py-1 text-sm font-semibold whitespace-nowrap text-neutral-900 capitalize shadow-lg">
        {name}
        {answers.meters !== null && <span className="font-normal text-neutral-500"> · about {answers.meters} m</span>}
      </div>
    </div>
  );
}

// The narrator's running picture of where the wearer is.
export function AroundYou({ narration }: { narration: { narration: Narration; latencyMs: number } | null }) {
  if (!narration) return null;
  const { summary, path, ground } = narration.narration;
  const pathLabel = path === "open" ? "Path looks open" : path === "obstructed" ? "Something in the way" : null;
  const groundLabel = ground === "going_up" ? "Going up" : ground === "going_down" ? "Going down" : null;
  return (
    <div className="echo-glass rounded-3xl px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-white/60">Around you</span>
        {pathLabel && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              path === "open"
                ? "bg-[var(--echo-calm)]/20 text-[var(--echo-calm)]"
                : "bg-[var(--echo-caution)]/20 text-[var(--echo-caution)]"
            }`}
          >
            {pathLabel}
          </span>
        )}
        {groundLabel && (
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/80">{groundLabel}</span>
        )}
      </div>
      <p className="mt-1 line-clamp-2 text-base leading-snug text-white/90">{summary}</p>
    </div>
  );
}

// The numbers behind each decision, for the team. Hidden by default.
export function Details({
  answers,
  motion,
  motionAllowed,
  sent,
  latencyMs,
}: {
  answers: Answers | null | undefined;
  motion: Motion | null;
  motionAllowed: boolean;
  sent: number;
  latencyMs: number | null;
}) {
  const bars: { label: string; value: number }[] = answers
    ? [
        { label: "Something close", value: answers.hazard_close },
        { label: "Worth saying", value: answers.worth_saying },
        { label: "Urgency", value: answers.urgency / 3 },
        { label: "Nearness", value: answers.distance / 2 },
        { label: "Ground change", value: answers.ground_change },
      ]
    : [];
  return (
    <div className="echo-glass rounded-3xl p-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        {bars.map((b) => (
          <div key={b.label}>
            <div className="flex justify-between text-xs text-white/70">
              <span>{b.label}</span>
              <span className="tabular-nums">{Math.round(b.value * 100)}%</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[var(--echo-accent)] transition-[width] duration-300"
                style={{ width: `${clamp(b.value * 100, 2, 100)}%` }}
              />
            </div>
          </div>
        ))}
        {!answers && <p className="col-span-2 text-xs text-white/50">Waiting for the first look…</p>}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-white/50 tabular-nums">
        {sent} looks · {latencyMs ?? "–"} ms each
        {answers && ` · model ${answers.latencyMs} ms`}
        {answers?.stub && " · demo answers"}
        {motion
          ? ` · tilt ${Math.round(motion.pitch)}° · head ${Math.round(motion.headOffset)}° · ${motion.cadence.toFixed(1)} steps/s`
          : !motionAllowed && " · motion sensors off"}
      </p>
    </div>
  );
}

// A soft coral glow around the edges when Echo says "Stop". Keyed by the
// caller so it replays.
export function StopGlow() {
  return <div className="echo-stop-glow pointer-events-none absolute inset-0" aria-hidden />;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
