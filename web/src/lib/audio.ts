// One shared AudioContext for the alarm tone and spoken audio.

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  return ctx;
}

// Call from a tap: iOS Safari only lets audio start inside a user gesture.
export function unlockAudio() {
  const audio = audioContext();
  if (audio.state === "suspended") void audio.resume();
}
