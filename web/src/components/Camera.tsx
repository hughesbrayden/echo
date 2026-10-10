"use client";

import { useEffect, useRef, useState } from "react";
import type { FrameResponse } from "@/app/api/frame/route";
import { playAlarm, unlockAudio } from "@/lib/alarm";
import { MotionTracker, requestMotionPermission, type Motion } from "@/lib/motion";

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

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastSaid, setLastSaid] = useState<string | null>(null);
  const [motion, setMotion] = useState<Motion | null>(null);
  const [motionAllowed, setMotionAllowed] = useState(true);

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

      // Speaking once inside the tap unlocks speech on iOS Safari.
      speak("Echo on");

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
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
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

    inFlightRef.current = true;
    const startedAt = performance.now();
    try {
      const res = await fetch("/api/frame", { method: "POST", body: form });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FrameResponse = await res.json();
      setLatencyMs(Math.round(performance.now() - startedAt));
      setSent((n) => n + 1);
      if (data.alarm) {
        void alarm(data.say ?? "Stop.");
      } else if (data.say) {
        setLastSaid(data.say);
        speak(data.say);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
    }
  }

  // The alarm cuts off anything being said, then speaks the canned phrase.
  async function alarm(phrase: string) {
    window.speechSynthesis?.cancel();
    setLastSaid(phrase);
    await playAlarm();
    speak(phrase);
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
        aria-live="polite"
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
        {running && !motionAllowed && (
          <p className="text-sm text-yellow-300">Motion sensor unavailable or not allowed.</p>
        )}
        {lastSaid && <p className="text-lg">“{lastSaid}”</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        {running && (
          <button
            type="button"
            onClick={() => alarm("Stop. Test alarm.")}
            className="h-12 w-full rounded-2xl border border-white/60 text-lg"
          >
            Test alarm
          </button>
        )}
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

function speak(text: string) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.cancel();
  synth.speak(new SpeechSynthesisUtterance(text));
}
