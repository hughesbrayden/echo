// Phone audio: one alarm tone, then words. Browser speech for now;
// swap speak() for Gemini TTS later and keep the alarm phrase as a pre-made clip.

let ctx: AudioContext | null = null;

/** Must be called from a tap: iOS only plays audio after a user gesture. */
export function unlockAudio() {
  ctx ??= new AudioContext();
  void ctx.resume();
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
}

/** Short, harsh two-pulse alarm. Interrupts any speech. */
export function playAlarm() {
  if (!ctx) return;
  speechSynthesis.cancel();
  const t = ctx.currentTime;
  for (const offset of [0, 0.18]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, t + offset);
    osc.frequency.linearRampToValueAtTime(1320, t + offset + 0.12);
    gain.gain.setValueAtTime(0.4, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + offset);
    osc.stop(t + offset + 0.15);
  }
}

export function speak(text: string, { interrupt = false } = {}) {
  if (interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.15;
  speechSynthesis.speak(u);
}
