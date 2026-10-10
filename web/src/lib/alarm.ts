// The one tone Echo has, and it means stop now. Built with Web Audio so there
// are no sound files to load.

import { audioContext, unlockAudio } from "@/lib/audio";

// Two quick falling chimes: urgent enough to cut through, soft enough not to
// grate. Sine waves with a fast attack and gentle decay, no hard edges.
const NOTES = [
  { freq: 1046.5, at: 0 }, // C6
  { freq: 784, at: 0.16 }, // G5
];
const NOTE_SEC = 0.22;
const VOLUME = 0.3;

// Plays the alarm and resolves when it ends.
export function playAlarm(): Promise<void> {
  unlockAudio();
  const audio = audioContext();
  const t0 = audio.currentTime + 0.01;

  const out = audio.createGain();
  out.gain.value = VOLUME;
  out.connect(audio.destination);

  let last: OscillatorNode | null = null;
  for (const { freq, at } of NOTES) {
    const t = t0 + at;
    const osc = audio.createOscillator();
    const env = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, t + NOTE_SEC);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + NOTE_SEC);
    last = osc;
  }

  return new Promise((resolve) => (last!.onended = () => resolve()));
}
