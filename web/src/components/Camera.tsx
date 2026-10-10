"use client";

import { useEffect, useRef, useState } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import Announcer from "@/components/Announcer";
import { SPEECH_STYLE, toPhrase, type Announcement } from "@/lib/announce";
import { urgentWarnings } from "@/lib/decisions";
import { unlockAudio } from "@/lib/audio";
import { preload, stopSpeaking } from "@/lib/speech";
import { MotionTracker, requestMotionPermission, type Motion } from "@/lib/motion";

// Sample announcements for the test buttons.
const TESTS: { label: string; announcement: Announcement }[] = [
  { label: "Warning", announcement: { kind: "warning", object: "chair", direction: "ahead", distance: "close" } },
  { label: "Alarm", announcement: { kind: "warning", object: "person", direction: "ahead", urgent: true } },
  {
    label: "Describe",
    announcement: {
      kind: "description",
      text: "A hallway with a door on the left and a bench against the right wall.",
    },
  },
];

// How often to send a frame, and how wide to scale it before upload.
const FRAME_INTERVAL_MS = 500;
const FRAME_MAX_WIDTH = 640;
const JPEG_QUALITY = 0.7;

type Status = "idle" | "starting" | "running" | "error";

export default function Camera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const motionRef = useRef<MotionTracker | null>(null);
  const saidRef = useRef<{ text: string; at: number; urgent: boolean }[]>([]);
  const historyRef = useRef<{ hazard_close: number; urgency: number; at: number }[]>([]);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const [motionAllowed, setMotionAllowed] = useState(true);
  const [answers, setAnswers] = useState<FrameResponse["answers"] | null>(null);

  useEffect(() => stop, []);

  async function start() {
    setError(null);
    setStatus("starting");

    // Both must start inside the tap, before any other await, for iOS Safari.
    unlockAudio();
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

      setAnnouncement({ kind: "description", text: "Echo on" });
      // Alarm phrases are pre-made clips so the words follow the tone at once.
      void preload(
        urgentWarnings().map((w) => ({ text: toPhrase(w), style: SPEECH_STYLE.warning })),
      );

      if (motionGranted) {
        motionRef.current = new MotionTracker();
        motionRef.current.start();
      }

      timerRef.current = window.setInterval(sendFrame, FRAME_INTERVAL_MS);
      setStatus("running");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function stop() {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    motionRef.current?.stop();
    motionRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    stopSpeaking();
    setStatus("idle");
  }

  async function sendFrame() {
    // A late answer is worse than none, so drop frames while a call is pending.
    if (inFlightRef.current) {
      setSkipped((n) => n + 1);
      return;
    }
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
    saidRef.current = saidRef.current.filter((s) => now - s.at < 15000);
    form.append(
      "recent",
      JSON.stringify(
        saidRef.current.map((s) => ({ text: s.text, secondsAgo: (now - s.at) / 1000, urgent: s.urgent })),
      ),
    );
    form.append(
      "history",
      JSON.stringify(
        historyRef.current.map((h) => ({
          hazard_close: h.hazard_close,
          urgency: h.urgency,
          secondsAgo: (now - h.at) / 1000,
        })),
      ),
    );

    inFlightRef.current = true;
    const startedAt = performance.now();
    try {
      const res = await fetch("/api/frame", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FrameResponse = await res.json();
      setLatencyMs(Math.round(performance.now() - startedAt));
      setSent((n) => n + 1);
      setAnswers(data.answers ?? null);
      if (data.answers) {
        const { hazard_close, urgency } = data.answers;
        historyRef.current = [...historyRef.current, { hazard_close, urgency, at: now }].slice(-2);
      }
      if (data.announcement) {
        saidRef.current.push({
          text: toPhrase(data.announcement),
          at: Date.now(),
          urgent: data.announcement.kind === "warning" && !!data.announcement.urgent,
        });
        setAnnouncement(data.announcement);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
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
            sent {sent} · skipped {skipped} · {latencyMs ?? "–"} ms
          </p>
        )}
        {running && motion && (
          <p className="font-mono text-sm">
            {motion.walking ? "walking" : "still"} · {motion.turning ? "turning" : "steady"} · yaw{" "}
            {motion.yawRate}°/s · accel {motion.accelRms}
          </p>
        )}
        {running && answers && (
          <p className="font-mono text-sm">
            hazard {answers.hazard_close.toFixed(2)} · say {answers.worth_saying.toFixed(2)} · urgency{" "}
            {answers.urgency.toFixed(1)} · {answers.subject} {answers.direction} · api {answers.latencyMs} ms
            {answers.stub && " · stub"}
          </p>
        )}
        {running && !motionAllowed && (
          <p className="text-sm text-yellow-300">Motion sensor unavailable or not allowed.</p>
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
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={status === "starting"}
          className="h-20 w-full rounded-2xl bg-white text-2xl font-semibold text-black disabled:opacity-50"
        >
          {running ? "Stop" : status === "starting" ? "Starting…" : "Start Echo"}
        </button>
      </div>
    </main>
  );
}
