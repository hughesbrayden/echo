// The one tone Echo has, and it means stop now. Built with Web Audio so there
// are no sound files to load.

import { audioContext, unlockAudio } from "@/lib/audio";

// Plays a short, harsh two-pitch alarm and resolves when it ends.
export function playAlarm(): Promise<void> {
  unlockAudio();
  const audio = audioContext();
  const beeps = 4;
  const beepSec = 0.12;
  const t0 = audio.currentTime + 0.01;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  gain.gain.setValueAtTime(0, t0);
  for (let i = 0; i < beeps; i++) {
    const t = t0 + i * beepSec;
    osc.frequency.setValueAtTime(i % 2 ? 880 : 1320, t);
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.setValueAtTime(0, t + beepSec * 0.85);
  }
  osc.connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + beeps * beepSec);

  return new Promise((resolve) => (osc.onended = () => resolve()));
}
