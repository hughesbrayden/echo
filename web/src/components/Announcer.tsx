"use client";

import { useEffect, useRef, useState } from "react";
import { playAlarm } from "@/lib/alarm";
import { toPhrase, toSegments, type Announcement } from "@/lib/announce";
import { preload, speak, stopSpeaking, type Voice } from "@/lib/speech";

type Props = {
  // Pass a new object each time something should be said.
  announcement: Announcement | null;
  className?: string;
};

// Speaks whatever it is handed and shows it as a caption. Warnings cut off
// descriptions; descriptions are dropped while a warning is still playing.
// Urgent warnings sound the alarm tone first. A newer announcement stops an
// older one between its parts, so "Bear left." never follows the wrong object.
export default function Announcer({ announcement, className }: Props) {
  // Id of the warning currently being said, or 0.
  const warningRef = useRef(0);
  const nextIdRef = useRef(1);
  // Id of the newest announcement being said.
  const latestRef = useRef(0);
  const [caption, setCaption] = useState<string | null>(null);
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
      setVoice(null);
      if (isWarning) warningRef.current = id;
      if (urgent) {
        stopSpeaking();
        // Fetch the words while the tone plays, unless they are preloaded.
        void preload(segments);
        await playAlarm();
      } else {
        // Fetch the command while the object is being said.
        void preload(segments.slice(1));
      }
      for (const { text, style, maxWaitMs } of segments) {
        if (latestRef.current !== id) break;
        const used = await speak(text, style, maxWaitMs);
        if (latestRef.current === id && used !== "skipped") {
          setVoice((prev) => (prev === "none" || prev === "browser" ? prev : used));
        }
      }
      if (warningRef.current === id) warningRef.current = 0;
    }
    void run();
  }, [announcement]);

  useEffect(() => stopSpeaking, []);

  if (!caption) return null;
  return (
    <p className={className}>
      “{caption}”
      {voice === "browser" && <span className="ml-2 text-xs opacity-60">phone voice</span>}
      {voice === "none" && <span className="ml-2 text-xs text-red-400">no sound played</span>}
    </p>
  );
}
