// The one tone Echo has, and it means stop now. Computed in code so there
// are no sound files to load, and played like any other clip.

import { playUrl, wavUrl } from "@/lib/audio";

// Two quick falling chimes: urgent enough to cut through, soft enough not to
// grate. Sine waves with a fast attack and gentle decay, no hard edges.
const NOTES = [
  { freq: 1046.5, at: 0 }, // C6
  { freq: 784, at: 0.16 }, // G5
];
const NOTE_SEC = 0.22;
const VOLUME = 0.3;
const SAMPLE_RATE = 24000;
const ATTACK_SEC = 0.01;

let tone: string | null = null;

function toneUrl(): string {
  if (tone) return tone;
  const total = NOTES[NOTES.length - 1].at + NOTE_SEC;
  const samples = new Float32Array(Math.ceil(total * SAMPLE_RATE));
  for (const { freq, at } of NOTES) {
    const start = Math.floor(at * SAMPLE_RATE);
    const length = Math.floor(NOTE_SEC * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      // Linear attack, then an exponential fall to 0.001 by the note's end.
      const env = t < ATTACK_SEC ? t / ATTACK_SEC : Math.pow(0.001, (t - ATTACK_SEC) / (NOTE_SEC - ATTACK_SEC));
      samples[start + i] += VOLUME * env * Math.sin(2 * Math.PI * freq * t);
    }
  }
  tone = wavUrl(samples, SAMPLE_RATE);
  return tone;
}

// Plays the alarm and resolves when it ends. If audio can't play, it resolves
// at once so the spoken words still follow; it never hangs.
export async function playAlarm(): Promise<void> {
  try {
    await playUrl(toneUrl());
  } catch (e) {
    console.warn("Alarm tone couldn't play", e);
  }
}
