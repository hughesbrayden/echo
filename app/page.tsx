"use client";

import { useEffect, useRef, useState } from "react";
import type { DecideRequest, DecideResponse, RecentUtterance } from "@/lib/contract";
import { Router, type Outcome } from "@/lib/router";
import { playAlarm, speak, unlockAudio } from "@/lib/audio";

const GRAB_EVERY_MS = 250;
const FRAME_WIDTH = 640;
const BUFFER_SIZE = 4;

interface LogEntry {
  at: number;
  answers: DecideResponse;
  outcome: Outcome;
  roundTripMs: number;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frames = useRef<string[]>([]);
  const said = useRef<{ text: string; at: number }[]>([]);
  const running = useRef(false);
  const [started, setStarted] = useState(false);
  const [stub, setStub] = useState(false);
  const stubRef = useRef(false);
  stubRef.current = stub;
  const [last, setLast] = useState<LogEntry | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    unlockAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 } },
        audio: false,
      });
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      running.current = true;
      setStarted(true);
      void loop();
    } catch (err) {
      setError(`Camera failed: ${String(err)}. It needs HTTPS (or localhost) and permission.`);
    }
  }

  function stop() {
    running.current = false;
    setStarted(false);
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((t) => t.stop());
  }

  // Grab frames from the live stream into a small rolling buffer.
  useEffect(() => {
    const canvas = document.createElement("canvas");
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!running.current || !video || video.videoWidth === 0) return;
      canvas.width = FRAME_WIDTH;
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * FRAME_WIDTH);
      canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.current = [...frames.current, canvas.toDataURL("image/jpeg", 0.6)].slice(-BUFFER_SIZE);
    }, GRAB_EVERY_MS);
    return () => clearInterval(id);
  }, []);

  // One request in flight: when it returns, send the newest frames again.
  async function loop() {
    const router = new Router();
    while (running.current) {
      const buf = frames.current;
      if (buf.length === 0) {
        await new Promise((r) => setTimeout(r, GRAB_EVERY_MS));
        continue;
      }
      // Newest frame plus one about 0.5 s earlier, for motion.
      const images = buf.length >= 3 ? [buf[buf.length - 3], buf[buf.length - 1]] : [buf[buf.length - 1]];
      const now = Date.now();
      const recent: RecentUtterance[] = said.current
        .filter((s) => now - s.at < 15000)
        .map((s) => ({ text: s.text, secondsAgo: (now - s.at) / 1000 }));
      const request: DecideRequest = { images, recent };

      try {
        const res = await fetch(`/api/decide${stubRef.current ? "?stub=1" : ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
        const answers = (await res.json()) as DecideResponse;
        const roundTripMs = Date.now() - now;
        // Skip stale answers rather than speak late.
        if (roundTripMs > 2500) continue;

        const outcome = router.route(answers);
        if (outcome.kind === "alarm") {
          playAlarm();
          speak(outcome.text);
        } else if (outcome.kind === "words") {
          speak(outcome.text);
        }
        if (outcome.kind !== "silence") said.current.push({ text: outcome.text, at: Date.now() });

        const entry = { at: now, answers, outcome, roundTripMs };
        setLast(entry);
        setLog((l) => [entry, ...l].slice(0, 50));
        setError(null);
      } catch (err) {
        setError(String(err));
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  return (
    <main style={{ fontFamily: "system-ui", padding: 16, maxWidth: 640, margin: "0 auto" }}>
      <h1 style={{ fontSize: 22 }}>Echo</h1>
      <video ref={videoRef} playsInline muted style={{ width: "100%", borderRadius: 8, background: "#111" }} />

      {!started ? (
        <button onClick={start} style={bigButton}>Start</button>
      ) : (
        <button onClick={stop} style={{ ...bigButton, background: "#444" }}>Stop</button>
      )}
      <label style={{ display: "block", margin: "8px 0" }}>
        <input type="checkbox" checked={stub} onChange={(e) => setStub(e.target.checked)} /> Use fake answers (stub)
      </label>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {last && (
        <section style={{ fontSize: 14 }}>
          <p>
            <b>{last.outcome.kind.toUpperCase()}</b>
            {last.outcome.kind !== "silence" && `: ${last.outcome.text}`}
            {" · "}round trip {last.roundTripMs} ms (API {last.answers.latencyMs} ms){last.answers.stub && " · stub"}
          </p>
          <Bar label="hazard_close" value={last.answers.hazard_close} />
          <Bar label="worth_saying" value={last.answers.worth_saying} />
          <Bar label="urgency (0 to 3)" value={last.answers.urgency / 3} />
          <p>subject: {last.answers.subject} · direction: {last.answers.direction}</p>
        </section>
      )}

      <details>
        <summary>Log ({log.length})</summary>
        <ul style={{ fontSize: 12 }}>
          {log.map((e) => (
            <li key={e.at}>
              {new Date(e.at).toLocaleTimeString()} {e.outcome.kind}
              {e.outcome.kind !== "silence" && ` "${e.outcome.text}"`} · hz {e.answers.hazard_close.toFixed(2)} · ws{" "}
              {e.answers.worth_saying.toFixed(2)} · {e.roundTripMs} ms
            </li>
          ))}
        </ul>
      </details>
    </main>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ margin: "4px 0" }}>
      <div>{label}: {value.toFixed(2)}</div>
      <div style={{ height: 8, background: "#ddd", borderRadius: 4 }}>
        <div style={{ height: 8, width: `${Math.min(100, value * 100)}%`, background: value > 0.7 ? "crimson" : "#3b82f6", borderRadius: 4 }} />
      </div>
    </div>
  );
}

const bigButton: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "16px 0",
  margin: "12px 0",
  fontSize: 20,
  border: 0,
  borderRadius: 8,
  background: "#2563eb",
  color: "white",
};
