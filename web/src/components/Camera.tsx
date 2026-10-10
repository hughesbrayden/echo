"use client";

import { useEffect, useRef, useState } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import Announcer from "@/components/Announcer";
import { KEEP_WALKING, commandSegments, toPhrase, toSegments, type Announcement } from "@/lib/announce";
import { announcementKey, urgentWarnings } from "@/lib/decisions";
import { unlockAudio } from "@/lib/audio";
import { preload, stopSpeaking } from "@/lib/speech";
import { MotionTracker, requestMotionPermission, type Motion } from "@/lib/motion";

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
  const historyRef = useRef<{ hazard_close: number; urgency: number; distance: number; at: number }[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const [motionAllowed, setMotionAllowed] = useState(true);
  const [answers, setAnswers] = useState<FrameResponse["answers"] | null>(null);
  // Alarm phrases and commands loading at Start; Echo waits for them.
  const [voiceProgress, setVoiceProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);

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

      void frameLoop(run);
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
    setStatus("idle");
  }

  // Sends the newest frame, waits for the reply, then sends the next one, so
  // there is never a stale frame queued and no idle wait after a slow reply.
  async function frameLoop(loop: number) {
    const startedAt = performance.now();
    await sendFrame();
    if (loop !== loopRef.current) return;
    const wait = Math.max(0, FRAME_INTERVAL_MS - (performance.now() - startedAt));
    timerRef.current = window.setTimeout(() => void frameLoop(loop), wait);
  }

  async function sendFrame() {
    const blob = await captureFrame();
    if (!blob) return;

    const form = new FormData();
    form.append("frame", blob, "frame.jpg");
    const frameMotion = motionRef.current?.take();
    if (frameMotion) {
      form.append("motion", JSON.stringify(frameMotion));
      setMotion(frameMotion);
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
        setAnnouncement(data.announcement);
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
            {motion.yawRate}°/s · accel {motion.accelRms} · pitch {motion.pitch}° · head {motion.headOffset}°
          </p>
        )}
        {running && answers && (
          <p className="font-mono text-sm">
            hazard {answers.hazard_close.toFixed(2)} · say {answers.worth_saying.toFixed(2)} · urgency{" "}
            {answers.urgency.toFixed(1)} · {answers.subject} {answers.direction} · dist{" "}
            {answers.distance.toFixed(1)}
            {answers.same_as_last !== null && ` · same ${answers.same_as_last.toFixed(2)}`}
            {answers.ground_change >= 0.5 && ` · ${answers.ground_kind} ${answers.ground_change.toFixed(2)}`} · api{" "}
            {answers.latencyMs} ms
            {answers.stub && " · stub"}
          </p>
        )}
        {running && !motionAllowed && (
          <p className="text-sm text-yellow-300">Motion sensor unavailable or not allowed.</p>
        )}
        {voiceNote && <p className="text-sm text-yellow-300">{voiceNote}</p>}
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
