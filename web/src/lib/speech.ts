// Speaks text with Gemini TTS via /api/speak, falling back to the browser's
// built-in voice if the call fails. Only one thing plays at a time.

import { audioContext } from "@/lib/audio";

// Canned phrases like "Stop. Person ahead." repeat, so keep their audio.
// Requests in flight are shared, so a preload and a speak never both fetch.
const MAX_CACHED = 100;
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
  window.speechSynthesis?.cancel();
}

export async function speak(
  text: string,
  style?: string,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): Promise<void> {
  const mine = ++generation;
  try {
    const buffer = await withTimeout(synthesize(text, style), maxWaitMs);
    if (mine !== generation) return;
    stopSpeaking();
    await play(buffer);
  } catch (e) {
    if (mine !== generation) return;
    console.warn("Gemini TTS failed or was too slow, using browser voice", e);
    await speakWithBrowser(text);
  }
}

// Fetches audio ahead of time so these phrases play without waiting.
// Stops at the first failure, e.g. when no Gemini key is set.
export async function preload(phrases: { text: string; style?: string }[]) {
  for (const { text, style } of phrases) {
    try {
      await synthesize(text, style);
    } catch {
      return;
    }
  }
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

function play(buffer: AudioBuffer): Promise<void> {
  const audio = audioContext();
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  current = source;
  return new Promise((resolve) => {
    source.onended = () => {
      if (current === source) current = null;
      resolve();
    };
    source.start();
  });
}

function speakWithBrowser(text: string): Promise<void> {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve();
  synth.cancel();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = utterance.onerror = () => resolve();
    synth.speak(utterance);
  });
}
