// One shared <audio> element for the alarm tone and spoken clips, plus the
// unlocking iOS Safari needs before a page may make sound.
//
// Not Web Audio: on iOS it can go silent while still reporting it is
// playing, e.g. after the built-in voice speaks or with the ring switch on
// silent. A media element that was started inside a tap keeps working for
// later clips, and plays as media.

let player: HTMLAudioElement | null = null;
let speechUnlocked = false;

function audioElement(): HTMLAudioElement {
  if (!player) {
    player = new Audio();
    player.preload = "auto";
  }
  return player;
}

// Call from a tap, before any await: iOS Safari only lets audio and the
// built-in voice start inside a user gesture. Playing a moment of silence
// unlocks the element for every later clip; speaking a silent utterance
// does the same for the built-in voice.
export function unlockAudio() {
  // Play as media, not as a sound effect the ring switch can mute.
  // Safari 16.4+; older versions keep the default.
  const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  if (session && session.type !== "playback") session.type = "playback";

  const audio = audioElement();
  if (audio.paused) {
    audio.src = silenceUrl();
    audio.play().catch(() => {});
  }

  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (synth && !speechUnlocked) {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    synth.speak(silent);
    speechUnlocked = true;
  }
}

// Plays a clip and resolves when it ends or is stopped. Throws if it can't
// start, so the caller can fall back to the built-in voice. Never hangs: a
// clip that never reports its end resolves after its length.
export async function playUrl(url: string): Promise<void> {
  const audio = audioElement();
  audio.pause();
  audio.src = url;
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      for (const e of END_EVENTS) audio.removeEventListener(e, finish);
      resolve();
    };
    for (const e of END_EVENTS) audio.addEventListener(e, finish);
  });
  await audio.play();
  const lengthMs = Number.isFinite(audio.duration) ? audio.duration * 1000 : MAX_CLIP_MS;
  await Promise.race([done, sleep(Math.min(lengthMs, MAX_CLIP_MS) + 500)]);
}

export function stopAudio() {
  player?.pause();
}

const END_EVENTS = ["ended", "pause", "emptied", "error"] as const;
const MAX_CLIP_MS = 10_000;

// Mono 16-bit WAV from samples in -1..1, as a blob URL.
export function wavUrl(samples: Float32Array, sampleRate: number): string {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  data.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 1, true); // mono
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return URL.createObjectURL(new Blob([data.buffer], { type: "audio/wav" }));
}

let silence: string | null = null;
function silenceUrl(): string {
  silence ??= wavUrl(new Float32Array(2400), 24000); // 0.1 s
  return silence;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
