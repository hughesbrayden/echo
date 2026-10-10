"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import type { MotionSample, Narration } from "@/lib/narrator";
import Announcer from "@/components/Announcer";
import {
  AlarmFlash,
  EchoMark,
  MotionPanel,
  NarrationStrip,
  SignalPanel,
  StatusBar,
  TargetMarker,
  Viewfinder,
} from "@/components/Hud";
import { KEEP_WALKING, commandSegments, toPhrase, toSegments, type Announcement } from "@/lib/announce";
import { announcementKey, urgentWarnings } from "@/lib/decisions";
import { unlockAudio } from "@/lib/audio";
import { preload, stopSpeaking } from "@/lib/speech";
import { MotionTracker, requestMotionPermission, type Motion } from "@/lib/motion";
import { DEFAULT_EYE_HEIGHT_M, cameraSetup, type CameraSetup } from "@/lib/geometry";

// Sample announcements for the test buttons.
const TESTS: { label: string; announcement: Announcement }[] = [
  {
    label: "Warning",
    announcement: { kind: "warning", object: "chair", direction: "ahead", distance: "near", guidance: "left" },
  },
  {
    label: "Alarm",
    announcement: { kind: "warning", object: "person", direction: "ahead", urgent: true, guidance: "right" },
  },
  {
    label: "Describe",
    announcement: {
      kind: "description",
      text: "A hallway with a door on the left and a bench against the right wall.",
    },
  },
];

// The shortest gap between frames, and how wide to scale them before upload.
// One frame is in flight at a time; the next goes as soon as the reply lands.
const FRAME_INTERVAL_MS = 500;
const FRAME_MAX_WIDTH = 640;
const JPEG_QUALITY = 0.7;
// Echo forgets what it last spoke about after this long.
const REFERENCE_MAX_AGE_MS = 90_000;
// How far back the spoken log reaches.
const RECENT_MAX_AGE_MS = 120_000;
// The background narrator runs this long after its previous call finishes,
// on frames about this far apart.
const NARRATE_INTERVAL_MS = 4000;
const NARRATE_FRAME_SPACING_MS = 1500;
const NARRATE_FRAMES = 3;
// How much recent video and motion to keep for it.
const HISTORY_KEEP_MS = 8000;
// Its spoken updates wait this long after anything else was said, and this
// long after the previous update.
const UPDATE_AFTER_SPEECH_MS = 3000;
const UPDATE_GAP_MS = 15_000;
// The wearer's eye height is remembered on this device.
const EYE_HEIGHT_KEY = "echo.eyeHeightCm";
const DEFAULT_EYE_HEIGHT_CM = Math.round(DEFAULT_EYE_HEIGHT_M * 100);

type Status = "idle" | "starting" | "running" | "error";

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  // Bumped on every start and stop so a loop from an earlier run ends.
  const loopRef = useRef(0);
  const motionRef = useRef<MotionTracker | null>(null);
  const saidRef = useRef<{ text: string; at: number; urgent: boolean; key?: string; guided: boolean }[]>([]);
  // The frame from when Echo last spoke about something, to compare against.
  const referenceRef = useRef<{ blob: Blob; text: string; at: number; mentions: number } | null>(null);
  // Recent frames and motion for the narrator, and its last two results.
  const framesRef = useRef<{ blob: Blob; at: number }[]>([]);
  const motionLogRef = useRef<(Omit<MotionSample, "secondsAgo"> & { at: number })[]>([]);
  const narrationsRef = useRef<{ narration: Narration; at: number }[]>([]);
  const historyRef = useRef<{ hazard_close: number; urgency: number; distance: number; at: number }[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  // Bumped on every urgent warning so the red flash replays.
  const [alarms, setAlarms] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [hudOn, setHudOn] = useState(true);
  const [motion, setMotion] = useState<Motion | null>(null);
  const [motionAllowed, setMotionAllowed] = useState(true);
  const [answers, setAnswers] = useState<FrameResponse["answers"] | null>(null);
  const [narration, setNarration] = useState<{ narration: Narration; latencyMs: number } | null>(null);
  // Alarm phrases and commands loading at Start; Echo waits for them.
  const [voiceProgress, setVoiceProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  // Camera height above the ground, for distances. Set before Start and
  // remembered on this device; edits win when storage is blocked.
  const savedEyeHeightCm = useSyncExternalStore(noSubscribe, readEyeHeightCm, () => DEFAULT_EYE_HEIGHT_CM);
  const [editedEyeHeightCm, setEditedEyeHeightCm] = useState<number | null>(null);
  const eyeHeightCm = editedEyeHeightCm ?? savedEyeHeightCm;
  const cameraRef = useRef<CameraSetup | null>(null);

  function changeEyeHeight(cm: number) {
    setEditedEyeHeightCm(cm);
    try {
      localStorage.setItem(EYE_HEIGHT_KEY, String(cm));
    } catch {
      // Storage blocked: it just won't be remembered.
    }
  }

  useEffect(() => stop, []);

  function announce(a: Announcement) {
    setAnnouncement(a);
    if (a.kind === "warning" && a.urgent) setAlarms((n) => n + 1);
  }

  async function start() {
    setError(null);
    setVoiceNote(null);
    setStatus("starting");
    const run = ++loopRef.current;

    // Both must start inside the tap, before any other await, for iOS Safari.
    unlockAudio();

    // Every alarm phrase and command must be ready before Echo starts
    // watching, so a warning never waits on the network. Loads while the
    // camera starts.
    const phrases = [KEEP_WALKING, ...commandSegments(), ...urgentWarnings().map((w) => toSegments(w)[0])];
    setVoiceProgress({ loaded: 0, total: phrases.length });
    const voiceReady = preload(phrases, {
      pin: true,
      onProgress: (loaded, total) => setVoiceProgress({ loaded, total }),
    });

    const motionGranted = await requestMotionPermission();
    setMotionAllowed(motionGranted);

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setError("Camera needs HTTPS (or localhost) and a supported browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();

      const missing = await voiceReady;
      if (run !== loopRef.current) return; // Stopped while loading.
      setVoiceProgress(null);
      if (missing > 0) {
        setVoiceNote(`${missing} of ${phrases.length} warning phrases didn't load and will use the phone voice.`);
      }

      setAnnouncement({ kind: "description", text: "Echo on" });

      if (motionGranted) {
        motionRef.current = new MotionTracker();
        motionRef.current.start();
      }

      void frameLoop(run);
      void narrateLoop(run);
      setStartedAt(Date.now());
      setStatus("running");
    } catch (e) {
      setVoiceProgress(null);
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function stop() {
    loopRef.current++;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    motionRef.current?.stop();
    motionRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    stopSpeaking();
    saidRef.current = [];
    historyRef.current = [];
    referenceRef.current = null;
    framesRef.current = [];
    motionLogRef.current = [];
    narrationsRef.current = [];
    setNarration(null);
    setAnswers(null);
    setMotion(null);
    setSent(0);
    setLatencyMs(null);
    setStartedAt(null);
    setStatus("idle");
  }

  // Sends the newest frame, waits for the reply, then sends the next one, so
  // there is never a stale frame queued and no idle wait after a slow reply.
  // The slower background pass: every few seconds, a short run of frames
  // plus what was said and how the head moved, summarised by a reasoning
  // model. Its summary rides along with every frame; its rare spoken updates
  // only play when nothing else has been said recently.
  async function narrateLoop(loop: number) {
    await sleep(NARRATE_INTERVAL_MS);
    while (loop === loopRef.current) {
      await narrateOnce();
      await sleep(NARRATE_INTERVAL_MS);
    }
  }

  async function narrateOnce() {
    const now = Date.now();
    const frames = pickSpaced(framesRef.current, now);
    if (frames.length === 0) return;

    const form = new FormData();
    frames.forEach((f, i) => form.append("frames", f.blob, `frame${i}.jpg`));
    form.append("frameAges", JSON.stringify(frames.map((f) => (now - f.at) / 1000)));
    if (cameraRef.current) form.append("camera", JSON.stringify(cameraRef.current));
    const previous = narrationsRef.current.at(-1)?.narration;
    if (previous) form.append("previous", JSON.stringify(previous));
    form.append(
      "recent",
      JSON.stringify(
        saidRef.current
          .filter((s) => now - s.at < 30_000)
          .map((s) => ({ text: s.text, secondsAgo: (now - s.at) / 1000 })),
      ),
    );
    form.append(
      "motionLog",
      JSON.stringify(motionLogRef.current.map(({ at, ...m }) => ({ ...m, secondsAgo: (now - at) / 1000 }))),
    );

    try {
      const res = await fetch("/api/narrate", { method: "POST", body: form });
      if (!res.ok) throw new Error(`narrate HTTP ${res.status}`);
      const data: { narration: Narration; latencyMs: number } = await res.json();
      narrationsRef.current = [...narrationsRef.current, { narration: data.narration, at: Date.now() }].slice(-2);
      setNarration(data);
      maybeSayUpdate(data.narration.say);
    } catch (e) {
      // The narrator is a nice-to-have; the frame loop carries on without it.
      console.warn("Narrator failed", e);
    }
  }

  function maybeSayUpdate(say: string | null) {
    if (!say) return;
    const now = Date.now();
    const said = saidRef.current;
    const lastSpoke = Math.max(-Infinity, ...said.map((s) => s.at));
    const lastUpdate = Math.max(-Infinity, ...said.filter((s) => s.key === "update").map((s) => s.at));
    const lastAlarm = Math.max(-Infinity, ...said.filter((s) => s.urgent).map((s) => s.at));
    if (now - lastSpoke < UPDATE_AFTER_SPEECH_MS || now - lastUpdate < UPDATE_GAP_MS) return;
    if (now - lastAlarm < UPDATE_GAP_MS || motionLogRef.current.at(-1)?.turning) return;
    said.push({ text: say, at: now, urgent: false, key: "update", guided: false });
    announce({ kind: "description", text: say });
  }

  async function frameLoop(loop: number) {
    const startedAt = performance.now();
    await sendFrame();
    if (loop !== loopRef.current) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - startedAt));
    timerRef.current = window.setTimeout(() => void frameLoop(loop), wait);
  }

  async function sendFrame() {
    const blob = await captureFrame();
    if (blob) keepRecent(framesRef, { blob, at: Date.now() });
    if (!blob) return;

    const form = new FormData();
    form.append("frame", blob, "frame.jpg");
    if (cameraRef.current) form.append("camera", JSON.stringify(cameraRef.current));
    const frameMotion = motionRef.current?.take();
    if (frameMotion) {
      form.append("motion", JSON.stringify(frameMotion));
      setMotion(frameMotion);
      const { pitch, headOffset, walking, turning, cadence } = frameMotion;
      keepRecent(motionLogRef, { pitch, headOffset, walking, turning, cadence, at: Date.now() });
    }

    const now = Date.now();
    saidRef.current = saidRef.current.filter((s) => now - s.at < RECENT_MAX_AGE_MS);
    form.append(
      "recent",
      JSON.stringify(
        saidRef.current.map((s) => ({
          text: s.text,
          secondsAgo: (now - s.at) / 1000,
          urgent: s.urgent,
          guided: s.guided,
          key: s.key,
        })),
      ),
    );
    form.append(
      "history",
      JSON.stringify(
        historyRef.current.map((h) => ({
          hazard_close: h.hazard_close,
          urgency: h.urgency,
          distance: h.distance,
          secondsAgo: (now - h.at) / 1000,
        })),
      ),
    );

    const latest = narrationsRef.current.at(-1);
    if (latest) {
      form.append(
        "narration",
        JSON.stringify({
          summary: latest.narration.summary,
          secondsAgo: (now - latest.at) / 1000,
          groundDirection: groundDirection(narrationsRef.current.map((n) => n.narration)),
        }),
      );
    }

    const reference = referenceRef.current;
    if (reference && now - reference.at < REFERENCE_MAX_AGE_MS) {
      form.append("reference", reference.blob, "reference.jpg");
      form.append(
        "referenceInfo",
        JSON.stringify({
          text: reference.text,
          secondsAgo: (now - reference.at) / 1000,
          mentions: reference.mentions,
        }),
      );
    }

    const startedAt = performance.now();
    try {
      const res = await fetch("/api/frame", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FrameResponse = await res.json();
      setLatencyMs(Math.round(performance.now() - startedAt));
      setSent((n) => n + 1);
      setAnswers(data.answers ?? null);
      if (data.answers) {
        const { hazard_close, urgency, distance } = data.answers;
        historyRef.current = [...historyRef.current, { hazard_close, urgency, distance, at: now }].slice(-2);
      }
      if (data.announcement) {
        const text = toPhrase(data.announcement);
        saidRef.current.push({
          text,
          at: Date.now(),
          urgent: data.announcement.kind === "warning" && !!data.announcement.urgent,
          key: announcementKey(data.announcement),
          guided: data.announcement.kind === "warning" && !!data.announcement.guidance,
        });
        // Count repeat mentions of the same thing; a new thing starts over.
        const mentions = data.sameObject && reference ? reference.mentions + 1 : 1;
        referenceRef.current = { blob, text, at: Date.now(), mentions };
        announce(data.announcement);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function captureFrame(): Promise<Blob | null> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0) return Promise.resolve(null);

    const scale = Math.min(1, FRAME_MAX_WIDTH / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    cameraRef.current = cameraSetup(eyeHeightCm / 100, canvas.width, canvas.height);
    canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  }

  const running = status === "running";

  const voicePct = voiceProgress ? Math.round((voiceProgress.loaded / Math.max(1, voiceProgress.total)) * 100) : 0;

  const tests = (
    <div className="flex items-center gap-1.5">
      <span className="mr-1 font-mono text-[9px] tracking-[0.25em] text-white/40 uppercase">Simulate</span>
      {TESTS.map((t) => (
        <button
          key={t.label}
          type="button"
          onClick={() => {
            unlockAudio();
            announce({ ...t.announcement });
          }}
          className="h-8 flex-1 rounded-full border border-white/15 bg-white/5 px-3 text-xs font-medium text-white/80 transition active:scale-95 active:bg-white/15"
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  return (
    <main className="relative flex h-dvh flex-1 flex-col overflow-hidden bg-black select-none">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        aria-hidden
      />
      <canvas ref={canvasRef} className="hidden" />

      {/* Darken the edges so the HUD reads on any scene. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-black/90 via-black/50 to-transparent" />

      {running && hudOn && (
        <>
          <Viewfinder pitch={motion?.pitch ?? null} headOffset={motion?.headOffset ?? null} />
          <TargetMarker answers={answers} />
        </>
      )}
      {alarms > 0 && <AlarmFlash key={alarms} />}

      <div className="relative z-10 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <StatusBar
          live={running}
          startedAt={startedAt}
          sent={sent}
          latencyMs={latencyMs}
          stub={!!answers?.stub}
        />
        {running && hudOn && (
          <div className="mt-8 flex items-start justify-between gap-2">
            <MotionPanel motion={motion} allowed={motionAllowed} />
            <SignalPanel answers={answers} />
          </div>
        )}
      </div>

      {!running && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="relative flex h-40 w-40 items-center justify-center">
            <div className="absolute inset-0 rounded-full border border-white/10" />
            <div className="absolute inset-5 rounded-full border border-white/10" />
            <div className="absolute inset-10 rounded-full border border-white/10" />
            <div className="hud-sweep absolute inset-0 rounded-full" />
            <EchoMark className="relative h-12 w-12 text-[var(--hud-accent)]" />
          </div>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight">Echo</h1>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-white/60">
            Sees the path ahead. Speaks only when it matters.
          </p>
        </div>
      )}

      <div className="relative z-10 mt-auto flex flex-col gap-2 px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {running && hudOn && <NarrationStrip narration={narration} />}
        <Announcer announcement={announcement} />

        {voiceNote && (
          <p className="truncate px-1 font-mono text-[10px] text-[var(--hud-warn)]/80" title={voiceNote}>
            ⚠ {voiceNote}
          </p>
        )}
        {error && (
          <p className="rounded-xl bg-[var(--hud-alarm)]/10 px-3 py-2 text-xs text-[var(--hud-alarm)]">{error}</p>
        )}

        <div className="hud-glass flex flex-col gap-3 rounded-3xl p-3">
          {tests}

          {(status === "idle" || status === "error") && (
            <label className="flex items-center justify-between px-1 text-sm text-white/80">
              <span>
                Eye height
                <span className="ml-2 font-mono text-[10px] text-white/40">for distance</span>
              </span>
              <span className="flex items-center gap-1.5 font-mono">
                <input
                  type="number"
                  inputMode="numeric"
                  min={100}
                  max={220}
                  value={eyeHeightCm}
                  onChange={(e) => changeEyeHeight(Number(e.target.value))}
                  className="w-16 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-right tabular-nums outline-none focus:border-[var(--hud-accent)]"
                  aria-label="Eye height in centimetres"
                />
                <span className="text-xs text-white/50">cm</span>
              </span>
            </label>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={running ? stop : start}
              disabled={status === "starting"}
              className={`relative h-14 flex-1 overflow-hidden rounded-2xl text-lg font-semibold tracking-wide transition active:scale-[0.98] disabled:opacity-90 ${
                running
                  ? "border border-[var(--hud-alarm)]/50 bg-[var(--hud-alarm)]/15 text-[var(--hud-alarm)]"
                  : "bg-[var(--hud-accent)] text-black shadow-[0_0_32px_rgb(94_230_255/0.35)]"
              }`}
            >
              {status === "starting" && voiceProgress && (
                <span
                  className="absolute inset-y-0 left-0 bg-black/15 transition-[width] duration-200"
                  style={{ width: `${voicePct}%` }}
                />
              )}
              <span className="relative">
                {running
                  ? "Stop"
                  : status === "starting"
                    ? voiceProgress
                      ? `Loading voice · ${voiceProgress.loaded}/${voiceProgress.total}`
                      : "Starting…"
                    : "Start Echo"}
              </span>
            </button>
            {running && (
              <button
                type="button"
                onClick={() => setHudOn((v) => !v)}
                aria-pressed={hudOn}
                className={`h-14 w-14 rounded-2xl border font-mono text-[10px] font-semibold tracking-widest transition active:scale-95 ${
                  hudOn ? "border-[var(--hud-accent)]/40 text-[var(--hud-accent)]" : "border-white/15 text-white/50"
                }`}
              >
                HUD
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Appends an item and drops ones older than HISTORY_KEEP_MS.
function keepRecent<T extends { at: number }>(ref: { current: T[] }, item: T) {
  const cutoff = item.at - HISTORY_KEEP_MS;
  ref.current = [...ref.current.filter((x) => x.at >= cutoff), item];
}

// The newest frame plus ones about NARRATE_FRAME_SPACING_MS apart before it,
// oldest first.
function pickSpaced<T extends { at: number }>(frames: T[], now: number): T[] {
  const picked: T[] = [];
  for (let i = 0; i < NARRATE_FRAMES; i++) {
    const target = now - i * NARRATE_FRAME_SPACING_MS;
    const best = frames
      .filter((f) => !picked.includes(f))
      .reduce<T | null>((b, f) => (!b || Math.abs(f.at - target) < Math.abs(b.at - target) ? f : b), null);
    if (best) picked.push(best);
  }
  return picked.sort((a, b) => a.at - b.at);
}

// "up" or "down" only when the last two narrations agree.
function groundDirection(narrations: Narration[]): "up" | "down" | null {
  if (narrations.length < 2) return null;
  const [a, b] = narrations.slice(-2).map((n) => n.ground);
  if (a !== b) return null;
  return a === "going_up" ? "up" : a === "going_down" ? "down" : null;
}

function readEyeHeightCm(): number {
  try {
    const saved = Number(localStorage.getItem(EYE_HEIGHT_KEY));
    if (saved >= 100 && saved <= 220) return saved;
  } catch {
    // Storage blocked: use the default.
  }
  return DEFAULT_EYE_HEIGHT_CM;
}

// The saved height only changes through this page, which tracks edits itself.
function noSubscribe(): () => void {
  return () => {};
}
