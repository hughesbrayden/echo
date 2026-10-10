"use client";

import { useEffect, useRef, useState } from "react";
import { playAlarm } from "@/lib/alarm";
import { MAX_WAIT_MS, SPEECH_STYLE, toPhrase, type Announcement } from "@/lib/announce";
import { preload, speak, stopSpeaking } from "@/lib/speech";

type Props = {
  // Pass a new object each time something should be said.
  announcement: Announcement | null;
  className?: string;
};

// Speaks whatever it is handed and shows it as a caption. Warnings cut off
// descriptions; descriptions are dropped while a warning is still playing.
// Urgent warnings sound the alarm tone first.
export default function Announcer({ announcement, className }: Props) {
  // Id of the warning currently being said, or 0.
  const warningRef = useRef(0);
  const nextIdRef = useRef(1);
  const [caption, setCaption] = useState<string | null>(null);

  useEffect(() => {
    if (!announcement) return;
    const isWarning = announcement.kind === "warning";
    if (!isWarning && warningRef.current) return;
    const id = nextIdRef.current++;

    const phrase = toPhrase(announcement);
    const style = SPEECH_STYLE[announcement.kind];

    async function run() {
      setCaption(phrase);
      if (isWarning) warningRef.current = id;
      if (announcement!.kind === "warning" && announcement!.urgent) {
        stopSpeaking();
        // Fetch the words while the tone plays, unless they are preloaded.
        void preload([{ text: phrase, style }]);
        await playAlarm();
      }
      await speak(phrase, style, MAX_WAIT_MS[announcement!.kind]);
      if (warningRef.current === id) warningRef.current = 0;
    }
    void run();
  }, [announcement]);

  useEffect(() => stopSpeaking, []);

  if (!caption) return null;
  return <p className={className}>“{caption}”</p>;
}
