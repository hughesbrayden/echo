// One shared AudioContext for the alarm tone and spoken audio, plus the
// unlocking iOS Safari needs before a page may make sound.

let ctx: AudioContext | null = null;
let speechUnlocked = false;

export function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  return ctx;
}

// Call from a tap, before any await: iOS Safari only lets Web Audio and the
// built-in voice start inside a user gesture. Speaking a silent utterance
// here is what unlocks the built-in voice for later warnings.
export function unlockAudio() {
  const audio = audioContext();
  if (audio.state !== "running") void audio.resume();

  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (synth && !speechUnlocked) {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    synth.speak(silent);
    speechUnlocked = true;
  }
}

// iOS pauses Web Audio after interruptions (a notification, another app, the
// screen dimming). Try to resume it; resolves true when it is running.
export async function ensureAudioRunning(timeoutMs = 300): Promise<boolean> {
  const audio = audioContext();
  if (audio.state === "running") return true;
  await Promise.race([
    audio.resume().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return (audio.state as AudioContextState) === "running";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
