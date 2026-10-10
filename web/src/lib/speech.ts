// Speaks text with Gemini TTS via /api/speak, falling back to the browser's
// built-in voice if the call fails. Only one thing plays at a time.

import { audioContext, ensureAudioRunning, sleep } from "@/lib/audio";

// Canned phrases like "Stop. Person ahead." repeat, so keep their audio.
// Requests in flight are shared, so a preload and a speak never both fetch.
const MAX_CACHED = 150;
const cache = new Map<string, Promise<AudioBuffer>>();

// Past this wait the words would be late, so the browser voice says them.
const DEFAULT_MAX_WAIT_MS = 1200;

let current: AudioBufferSourceNode | null = null;
// Bumped on every request so a slow reply never talks over a newer one.
let generation = 0;

export function stopSpeaking() {
  generation++;
  current?.stop();
  current = null;
  const synth = window.speechSynthesis;
  if (synth?.speaking || synth?.pending) synth.cancel();
}

// Which voice said it, so the screen can show when sound failed.
export type Voice = "gemini" | "browser" | "none" | "skipped";

export async function speak(
  text: string,
  style?: string,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<Voice> {
  const mine = ++generation;
  try {
    const buffer = await withTimeout(synthesize(text, style), maxWaitMs);
    if (mine !== generation) return "skipped";
    stopSpeaking();
    await play(buffer);
    return "gemini";
  } catch (e) {
    if (mine !== generation) return "skipped";
    console.warn("Gemini audio unavailable, using browser voice", e);
    return (await speakWithBrowser(text)) ? "browser" : "none";
  }
}

// Fetches audio ahead of time so these phrases play without waiting, a few
// at a time and in the order given. Stops at the first failure, e.g. when no
// Gemini key is set.
const PRELOAD_CONCURRENCY = 4;

export async function preload(phrases: { text: string; style?: string }[]) {
  const queue = [...phrases];
  let failed = false;
  const worker = async () => {
    while (!failed && queue.length) {
      const { text, style } = queue.shift()!;
      try {
        await synthesize(text, style);
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
}

function synthesize(text: string, style?: string): Promise<AudioBuffer> {
  const key = `${style ?? ""}|${text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = fetchAudio(text, style);
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

async function fetchAudio(text: string, style?: string): Promise<AudioBuffer> {
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, style }),
  });
  if (!res.ok) throw new Error(`/api/speak ${res.status}`);
  return audioContext().decodeAudioData(await res.arrayBuffer());
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Plays decoded audio. Throws if Web Audio can't run, so the caller falls
// back to the browser voice; resolves after the clip even if "ended" never
// fires, so a stalled clip can't freeze what comes after it.
async function play(buffer: AudioBuffer): Promise<void> {
  if (!(await ensureAudioRunning())) throw new Error("audio is paused");
  const audio = audioContext();
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  current = source;
  await Promise.race([
    new Promise<void>((resolve) => (source.onended = () => resolve())),
    sleep(buffer.duration * 1000 + 500),
  ]);
  if (current === source) current = null;
}

// Kept at module level: some browsers drop an utterance that gets garbage
// collected before it finishes, and never fire its end event.
let utterance: SpeechSynthesisUtterance | null = null;

// Resolves true once the browser voice has spoken, false if it never started.
// Never hangs.
async function speakWithBrowser(text: string): Promise<boolean> {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  // Safari silently drops an utterance queued right after cancel().
  if (synth.speaking || synth.pending) {
    synth.cancel();
    await sleep(60);
  }
  const mine = new SpeechSynthesisUtterance(text);
  utterance = mine;
  let started = false;
  const done = new Promise<void>((resolve) => {
    mine.onstart = () => (started = true);
    mine.onend = mine.onerror = () => resolve();
  });
  synth.speak(mine);
  // A rough upper bound on how long the phrase takes to say.
  await Promise.race([done, sleep(Math.min(1500 + text.length * 90, 8000))]);
  if (utterance === mine) utterance = null;
  return started;
}
