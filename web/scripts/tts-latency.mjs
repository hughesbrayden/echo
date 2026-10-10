// Times Gemini TTS (and the line writer) the same way the app calls them.
//   GEMINI_API_KEY=... node scripts/tts-latency.mjs [path/to/frame.jpg]
// Writes each clip to tts-*.wav so you can listen to them.

import { readFileSync, writeFileSync } from "node:fs";

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error("Set GEMINI_API_KEY");
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const TTS_MODEL = "gemini-3.8-flash-lite-tts";
const LINE_MODEL = process.env.ECHO_LINE_MODEL ?? "gemini-3.8-flash-lite";
const STYLE = "calm, firm and direct, like a sighted guide";
const PHRASES = [
  "Bear left.",
  "Wall ahead, the hallway opens to your left.",
  "Curb coming up, step down.",
  "Chair in front, go around on the right.",
  "Door just to your right.",
];

async function post(body) {
  const t = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t), json };
}

async function tts(text) {
  const r = await post({
    model: TTS_MODEL,
    input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: STYLE }] }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice: process.env.GEMINI_TTS_VOICE ?? "Kore" }] },
  });
  const audio = r.json.steps?.filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).find((c) => c.type === "audio")?.data;
  return { ...r, audio };
}

console.log(`TTS ${TTS_MODEL}, run in sequence then 5 at once (like the old preload)\n`);
const times = [];
for (const [i, text] of PHRASES.entries()) {
  const r = await tts(text);
  if (!r.audio) { console.log(`FAIL ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`); continue; }
  const bytes = Buffer.from(r.audio, "base64");
  writeFileSync(`tts-${i}.wav`, bytes);
  times.push(r.ms);
  console.log(`${String(r.ms).padStart(5)} ms  ${(bytes.length / 48000).toFixed(1)} s audio  "${text}"`);
}
const sorted = [...times].sort((a, b) => a - b);
console.log(`median ${sorted[Math.floor(sorted.length / 2)]} ms, worst ${sorted.at(-1)} ms\n`);

const burst = await Promise.all(PHRASES.map((t) => tts(t)));
console.log("burst of 5: " + burst.map((r) => (r.audio ? `${r.ms}ms` : `FAIL ${r.status}`)).join(", ") + "\n");

const frame = process.argv[2];
if (frame) {
  const data = readFileSync(frame).toString("base64");
  const r = await post({
    model: LINE_MODEL,
    input: [{ type: "user_input", content: [
      { type: "text", text: "You are Echo, guiding a blind person walking with camera glasses. In at most 14 words, say the one thing that helps them move right now." },
      { type: "image", data, mime_type: "image/jpeg" },
    ] }],
  });
  const text = r.json.steps?.filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  console.log(r.ok && text ? `line ${LINE_MODEL}: ${r.ms} ms  "${text.trim()}"` : `line FAIL ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
}
