"use client";

import { useEffect, useRef, useState } from "react";
import { playAlarm } from "@/lib/alarm";
import { toPhrase, toSegments, type Announcement } from "@/lib/announce";
import { preload, speakAll, stopSpeaking, type Voice } from "@/lib/speech";
import { severityOf, type Severity } from "@/components/Hud";

type Props = {
  // Pass a new object each time something should be said.
  announcement: Announcement | null;
  className?: string;
};

// Speaks whatever it is handed and shows it as a caption. Warnings cut off
// descriptions; descriptions are dropped while a warning is still playing.
// Urgent warnings sound the alarm tone first. A newer announcement stops an
// older one, so "Bear left." never follows the wrong object.
export default function Announcer({ announcement, className }: Props) {
  // Id of the warning currently being said, or 0.
  const warningRef = useRef(0);
  const nextIdRef = useRef(1);
  // Id of the newest announcement being said.
  const latestRef = useRef(0);
  const [caption, setCaption] = useState<string | null>(null);
  const [severity, setSeverity] = useState<Severity>("info");
  // Shown under the caption when the nicer voice wasn't used or nothing played.
  const [voice, setVoice] = useState<Voice | null>(null);

  useEffect(() => {
    if (!announcement) return;
    const isWarning = announcement.kind === "warning";
    if (!isWarning && warningRef.current) return;
    const id = nextIdRef.current++;
    latestRef.current = id;

    const segments = toSegments(announcement);
    const urgent = announcement.kind === "warning" && !!announcement.urgent;

    async function run() {
      setCaption(toPhrase(announcement!));
      setSeverity(severityOf(announcement!));
      setVoice(null);
      if (isWarning) warningRef.current = id;
      if (urgent) {
        stopSpeaking();
        // Fetch the words while the tone plays, unless they are preloaded.
        void preload(segments);
        await playAlarm();
      }
      if (latestRef.current === id) {
        const used = await speakAll(segments);
        if (latestRef.current === id && used !== "skipped") setVoice(used);
      }
      // A reminder about this thing often follows; have its words ready.
      const a = announcement!;
      if (a.kind === "warning" && !a.urgent && !a.reminder) {
        void preload([toSegments({ ...a, reminder: true })[0]]);
      }
      if (warningRef.current === id) warningRef.current = 0;
    }
    void run();
  }, [announcement]);

  useEffect(() => stopSpeaking, []);

  if (!caption) return null;
  return (
    <div key={caption} className={`hud-caption hud-caption-${severity} ${className ?? ""}`} aria-live="polite">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[9px] font-semibold tracking-[0.25em] uppercase opacity-80">
          {CAPTION_LABEL[severity]}
        </span>
        {voice === "browser" && <span className="font-mono text-[9px] tracking-wider opacity-60">PHONE VOICE</span>}
        {voice === "none" && (
          <span className="font-mono text-[9px] tracking-wider text-[var(--hud-alarm)]">NO SOUND</span>
        )}
      </div>
      <p className="mt-1 text-lg leading-snug font-semibold text-white">“{caption}”</p>
    </div>
  );
}

const CAPTION_LABEL: Record<Severity, string> = {
  alarm: "▲ Alarm",
  warning: "● Warning",
  info: "◆ Echo",
  clear: "✓ Path clear",
};
