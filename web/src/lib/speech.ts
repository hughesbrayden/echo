// Speaks text with Gemini TTS via /api/speak, falling back to the browser's
// built-in voice if the call fails. Only one thing plays at a time.

import { audioContext } from "@/lib/audio";

// Canned phrases like "Stop. Person ahead." repeat, so keep their audio.
const MAX_CACHED = 50;
const cache = new Map<string, AudioBuffer>();

let current: AudioBufferSourceNode | null = null;
// Bumped on every request so a slow reply never talks over a newer one.
let generation = 0;

export function stopSpeaking() {
  generation++;
  current?.stop();
  current = null;
  window.speechSynthesis?.cancel();
}

export async function speak(text: string, style?: string): Promise<void> {
  const mine = ++generation;
  try {
    const buffer = await synthesize(text, style);
    if (mine !== generation) return;
    stopSpeaking();
    await play(buffer);
  } catch (e) {
    if (mine !== generation) return;
    console.warn("Gemini TTS failed, using browser voice", e);
    await speakWithBrowser(text);
  }
}

async function synthesize(text: string, style?: string): Promise<AudioBuffer> {
  const key = `${style ?? ""}|${text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const res = await fetch("/api/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, style }),
  });
  if (!res.ok) throw new Error(`/api/speak ${res.status}`);

  const buffer = await audioContext().decodeAudioData(await res.arrayBuffer());
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, buffer);
  return buffer;
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
