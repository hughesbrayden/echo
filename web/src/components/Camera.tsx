"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import type { MotionSample, Narration } from "@/lib/narrator";
import Announcer from "@/components/Announcer";
import { KEEP_WALKING, commandSegments, toPhrase, toSegments, type Advice, type Announcement } from "@/lib/announce";
import { announcementKey, urgentWarnings } from "@/lib/decisions";
import { unlockAudio } from "@/lib/audio";
import { preload, stopSpeaking } from "@/lib/speech";
import { MotionTracker, requestMotionPermission, type Motion } from "@/lib/motion";
import { DEFAULT_EYE_HEIGHT_M, cameraSetup, type CameraSetup } from "@/lib/geometry";

// Sample announcements for the test buttons.
const TESTS: { label: string; announcement: Announcement }[] = [
  {
    label: "Warning",
    announcement: { kind: "warning", advice: "course", object: "chair", direction: "ahead", distance: "near", guidance: "left" },
  },
  {
    label: "Alarm",
    announcement: { kind: "warning", advice: "stop", object: "person", direction: "ahead", urgent: true, guidance: "right" },
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
// A frame from this long before the newest one goes along too, so the model
// sees motion over the same gap every time, whatever the API latency. Frames
// are kept every SNAPSHOT_MS to pick from.
const PREVIOUS_GAP_MS = 500;
const SNAPSHOT_MS = 125;
// How far back the spoken log reaches.
const RECENT_MAX_AGE_MS = 120_000;
// The background narrator runs this long after its previous call finishes,
// on frames about this far apart.
const NARRATE_INTERVAL_MS = 4000;
const NARRATE_FRAME_SPACING_MS = 1500;
const NARRATE_FRAMES = 3;
// How much recent video and motion to keep for it.
const HISTORY_KEEP_MS = 8000;
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
  const saidRef = useRef<
    { text: string; at: number; urgent: boolean; advice?: Advice; key?: string; guided: boolean }[]
  >([]);
  const snapshotsRef = useRef<{ blob: Blob; at: number }[]>([]);
  const snapshotTimerRef = useRef<number | null>(null);
  // The frame from when Echo last spoke about something, to compare against.
  const referenceRef = useRef<{ blob: Blob; text: string; at: number; mentions: number } | null>(null);
  // Recent frames and motion for the narrator, and its last two results.
  const framesRef = useRef<{ blob: Blob; at: number }[]>([]);
  const motionLogRef = useRef<(Omit<MotionSample, "secondsAgo"> & { at: number })[]>([]);
  const narrationsRef = useRef<{ narration: Narration; at: number }[]>([]);
  const historyRef = useRef<{ stop: number; distance: number; gate: number; at: number }[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
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

      snapshotTimerRef.current = window.setInterval(() => void takeSnapshot(), SNAPSHOT_MS);
      void frameLoop(run);
      void narrateLoop(run);
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
    if (snapshotTimerRef.current !== null) window.clearInterval(snapshotTimerRef.current);
    snapshotTimerRef.current = null;
    snapshotsRef.current = [];
    setNarration(null);
    setStatus("idle");
  }

  // Sends the newest frame, waits for the reply, then sends the next one, so
  // there is never a stale frame queued and no idle wait after a slow reply.
  // The slower background pass: every few seconds, a short run of frames
  // plus what was said and how the head moved, summarised by a reasoning
  // model. Its note rides along with every frame as background; it never
  // speaks on its own.
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
    } catch (e) {
      // The narrator is a nice-to-have; the frame loop carries on without it.
      console.warn("Narrator failed", e);
    }
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
          advice: s.advice,
          guided: s.guided,
          key: s.key,
        })),
      ),
    );
    form.append(
      "history",
      JSON.stringify(
        historyRef.current.map((h) => ({
          stop: h.stop,
          distance: h.distance,
          gate: h.gate,
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

    const previous = snapshotNear(now - PREVIOUS_GAP_MS);
    if (previous) {
      form.append("previous", previous.blob, "previous.jpg");
      form.append("previousInfo", JSON.stringify({ secondsAgo: (now - previous.at) / 1000 }));
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
        const { stop, distance, course, footing, orient } = data.answers;
        const gate = Math.max(course, footing, orient);
        historyRef.current = [...historyRef.current, { stop, distance, gate, at: now }].slice(-2);
      }
      if (data.announcement) {
        const text = toPhrase(data.announcement);
        saidRef.current.push({
          text,
          at: Date.now(),
          urgent: data.announcement.kind === "warning" && !!data.announcement.urgent,
          advice: data.announcement.kind === "warning" ? data.announcement.advice : undefined,
          key: announcementKey(data.announcement),
          guided: data.announcement.kind === "warning" && !!data.announcement.guidance,
        });
        // Count repeat mentions of the same thing; a new thing starts over.
        const mentions = data.sameObject && reference ? reference.mentions + 1 : 1;
        referenceRef.current = { blob, text, at: Date.now(), mentions };
        setAnnouncement(data.announcement);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Keeps the last second of frames, so one from half a second ago is ready.
  async function takeSnapshot() {
    const blob = await captureFrame();
    if (!blob) return;
    const now = Date.now();
    snapshotsRef.current = [...snapshotsRef.current, { blob, at: now }].filter((f) => now - f.at <= 1000);
  }

  // The kept frame closest to `at`, if one is within a snapshot interval.
  function snapshotNear(at: number) {
    let best: { blob: Blob; at: number } | null = null;
    for (const f of snapshotsRef.current) {
      if (!best || Math.abs(f.at - at) < Math.abs(best.at - at)) best = f;
    }
    return best && Math.abs(best.at - at) <= SNAPSHOT_MS ? best : null;
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

  return (
    <main className="relative flex min-h-dvh flex-1 flex-col">
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full object-cover"
        playsInline
        muted
        aria-hidden
      />
      <canvas ref={canvasRef} className="hidden" />

      <div
        className="relative mt-auto flex flex-col gap-3 bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        {running && (
          <p className="font-mono text-sm">
            sent {sent} · {latencyMs ?? "–"} ms
          </p>
        )}
        {running && motion && (
          <p className="font-mono text-sm">
            {motion.walking ? "walking" : "still"} · {motion.turning ? "turning" : "steady"} · yaw{" "}
            {motion.yawRate}°/s · accel {motion.accelRms} · pitch {motion.pitch}° · head {motion.headOffset}° ·{" "}
            {motion.cadence} steps/s
          </p>
        )}
        {running && answers && (
          <p className="font-mono text-sm">
            stop {answers.stop.toFixed(2)} · course {answers.course.toFixed(2)} · footing{" "}
            {answers.footing.toFixed(2)} · orient {answers.orient.toFixed(2)} · {answers.subject}{" "}
            {answers.direction} · dist {answers.distance.toFixed(1)}
            {answers.meters !== null && ` · ${answers.meters} m`}
            {answers.new_in_view !== null && ` · new ${answers.new_in_view.toFixed(2)}`} · api{" "}
            {answers.latencyMs} ms
            {answers.stub && " · stub"}
          </p>
        )}
        {running && !motionAllowed && (
          <p className="text-sm text-yellow-300">Motion sensor unavailable or not allowed.</p>
        )}
        {voiceNote && <p className="text-sm text-yellow-300">{voiceNote}</p>}
        {running && narration && (
          <p className="text-sm opacity-80">
            {narration.narration.summary}{" "}
            <span className="font-mono text-xs opacity-70">
              (ground {narration.narration.ground} · {narration.latencyMs} ms)
            </span>
          </p>
        )}
        <Announcer announcement={announcement} className="text-lg" />
        {error && <p className="text-sm text-red-400">{error}</p>}

        <div className="grid grid-cols-3 gap-2">
          {TESTS.map((t) => (
            <button
              key={t.label}
              type="button"
              onClick={() => {
                unlockAudio();
                setAnnouncement({ ...t.announcement });
              }}
              className="h-12 rounded-2xl border border-white/60 text-base"
            >
              Test {t.label.toLowerCase()}
            </button>
          ))}
        </div>
        {status === "idle" || status === "error" ? (
          <label className="flex items-center justify-between text-base">
            Eye height
            <span>
              <input
                type="number"
                inputMode="numeric"
                min={100}
                max={220}
                value={eyeHeightCm}
                onChange={(e) => changeEyeHeight(Number(e.target.value))}
                className="w-20 rounded-lg bg-white/10 px-2 py-1 text-right"
                aria-label="Eye height in centimetres"
              />{" "}
              cm
            </span>
          </label>
        ) : null}
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={status === "starting"}
          className="h-20 w-full rounded-2xl bg-white text-2xl font-semibold text-black disabled:opacity-50"
        >
          {running
            ? "Stop"
            : status === "starting"
              ? voiceProgress
                ? `Loading voice ${voiceProgress.loaded}/${voiceProgress.total}…`
                : "Starting…"
              : "Start Echo"}
        </button>
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
