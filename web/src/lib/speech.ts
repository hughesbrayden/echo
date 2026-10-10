// Speaks text with Gemini TTS via /api/speak, falling back to the browser's
// built-in voice if the call fails. Only one thing plays at a time.

import { audioContext, ensureAudioRunning, sleep } from "@/lib/audio";

// Canned phrases like "Stop. Person ahead." repeat, so keep their audio.
// Requests in flight are shared, so a preload and a speak never both fetch.
// Pinned clips (alarms and commands loaded at Start) are never evicted.
const MAX_CACHED = 150;
const cache = new Map<string, Promise<AudioBuffer>>();
const pinned = new Set<string>();

// A clip request that takes longer than this has failed.
const FETCH_TIMEOUT_MS = 8000;

// Past this wait the words would be late, so the browser voice says them.
const DEFAULT_MAX_WAIT_MS = 1200;

let current: AudioBufferSourceNode | null = null;
// Bumped on every request so a slow reply never talks over a newer one.
let generation = 0;

export function stopSpeaking() {
  generation++;
  stopPlayback();
}

function stopPlayback() {
  current?.stop();
  current = null;
  const synth = window.speechSynthesis;
  if (synth?.speaking || synth?.pending) synth.cancel();
}

// Which voice said it, so the screen can show when sound failed.
export type Voice = "gemini" | "browser" | "none" | "skipped";

export type Part = { text: string; style?: string; maxWaitMs?: number };

export function speak(text: string, style?: string, maxWaitMs = DEFAULT_MAX_WAIT_MS): Promise<Voice> {
  return speakAll([{ text, style, maxWaitMs }]);
}

// Says the parts in order, e.g. "Chair, a few steps ahead." then "Bear left.",
// with Gemini audio. All parts start fetching at once. If a part isn't ready
// in time, the browser voice says it and everything after it as one phrase:
// iOS can mute Web Audio right after the browser voice speaks, so switching
// back mid-announcement would drop the rest.
export async function speakAll(parts: Part[]): Promise<Voice> {
  const mine = ++generation;
  const clips = parts.map((p) => synthesize(p.text, p.style));
  clips.forEach((c) => c.catch(() => {}));

  for (let i = 0; i < parts.length; i++) {
    let buffer: AudioBuffer | null = null;
    try {
      buffer = await withTimeout(clips[i], parts[i].maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
    } catch (e) {
      console.warn("Gemini audio not ready, using browser voice", e);
    }
    if (mine !== generation) return "skipped";
    if (buffer) {
      try {
        stopPlayback();
        await play(buffer);
        if (mine !== generation) return "skipped";
        continue;
      } catch (e) {
        console.warn("Web Audio unavailable, using browser voice", e);
      }
    }
    const rest = parts
      .slice(i)
      .map((p) => p.text)
      .join(" ");
    return (await speakWithBrowser(rest)) ? "browser" : "none";
  }
  return "gemini";
}

// Plays a line written and voiced on the server (base64 WAV), or says it
// with the browser voice if there is no audio or Web Audio can't play it.
export async function speakClip(text: string, wavBase64: string | null): Promise<Voice> {
  const mine = ++generation;
  if (wavBase64) {
    try {
      const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
      const buffer = await audioContext().decodeAudioData(bytes.buffer);
      if (mine !== generation) return "skipped";
      stopPlayback();
      await play(buffer);
      return mine === generation ? "gemini" : "skipped";
    } catch (e) {
      console.warn("Couldn't play the voiced line, using browser voice", e);
    }
  }
  if (mine !== generation) return "skipped";
  stopPlayback();
  return (await speakWithBrowser(text)) ? "browser" : "none";
}

// Fetches audio ahead of time so these phrases play without waiting, a few
// at a time and in the order given. Each clip gets one retry after a short
// pause (Gemini rate-limits bursts). Only after several clips in a row fail
// is Gemini taken to be down (or keyless) and the rest skipped.
// Resolves with how many phrases are not loaded.
const PRELOAD_CONCURRENCY = 3;
const PRELOAD_RETRY_MS = 1000;
const PRELOAD_GIVE_UP_AFTER = 3;

type PreloadOptions = {
  // Keep these clips for the whole session.
  pin?: boolean;
  onProgress?: (loaded: number, total: number) => void;
};

export async function preload(
  phrases: { text: string; style?: string }[],
  { pin = false, onProgress }: PreloadOptions = {},
): Promise<number> {
  const queue = [...phrases];
  let loaded = 0;
  let failedInARow = 0;
  const load = async (text: string, style?: string) => {
    if (pin) pinned.add(cacheKey(text, style));
    try {
      await synthesize(text, style);
    } catch {
      await sleep(PRELOAD_RETRY_MS);
      await synthesize(text, style);
    }
  };
  const worker = async () => {
    while (failedInARow < PRELOAD_GIVE_UP_AFTER && queue.length) {
      const { text, style } = queue.shift()!;
      try {
        await load(text, style);
        loaded++;
        failedInARow = 0;
        onProgress?.(loaded, phrases.length);
      } catch {
        failedInARow++;
      }
    }
  };
  await Promise.all(Array.from({ length: PRELOAD_CONCURRENCY }, worker));
  return phrases.length - loaded;
}

function cacheKey(text: string, style?: string): string {
  return `${style ?? ""}|${text}`;
}

function synthesize(text: string, style?: string): Promise<AudioBuffer> {
  const key = cacheKey(text, style);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = fetchAudio(text, style);
  if (cache.size >= MAX_CACHED) {
    const oldest = [...cache.keys()].find((k) => !pinned.has(k));
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  return pending;
}

async function fetchAudio(text: string, style?: string): Promise<AudioBuffer> {
  const res = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, style }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
