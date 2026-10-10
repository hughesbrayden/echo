// Writes and voices one line about a frame: the phone sends the frame and
// the warning the decision answers picked, and gets back the words plus WAV
// audio in one hop. The frame loop keeps running while this works.

import type { Warning } from "@/lib/announce";
import { sceneText } from "@/lib/decisions";
import type { CameraSetup } from "@/lib/geometry";
import { writeLine } from "@/lib/line";
import type { Motion } from "@/lib/motion";
import { synthesizeWav } from "@/lib/tts";

export const preferredRegion = "iad1";
export const maxDuration = 15;

const STYLE: Record<string, string> = {
  course: "calm, firm and direct, like a sighted guide",
  footing: "calm, firm and direct, like a sighted guide",
  orient: "calm, clear and even",
};

export type SayResponse = {
  // What to say; "" means the writer decided nothing was worth saying.
  text: string;
  // Base64 WAV, or null if the voice failed (the phone voice says it).
  audio: string | null;
  writer: string;
  lineMs: number;
  ttsMs: number;
  error?: string;
};

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }
  const frame = form.get("frame");
  if (!(frame instanceof File) || !frame.type.startsWith("image/")) {
    return Response.json({ error: "Expected an image in the frame field" }, { status: 415 });
  }
  let warning: Warning;
  let motion: Motion | null;
  let camera: CameraSetup | null;
  let recent: { text: string; secondsAgo: number }[];
  try {
    warning = JSON.parse(String(form.get("warning")));
    motion = JSON.parse(String(form.get("motion") ?? "null"));
    camera = JSON.parse(String(form.get("camera") ?? "null"));
    recent = JSON.parse(String(form.get("recent") ?? "[]"));
  } catch (e) {
    return Response.json({ error: `Bad JSON: ${e}` }, { status: 400 });
  }

  const gemini = process.env.GEMINI_API_KEY;
  const openai = process.env.OPENAI_API_KEY;
  const imageDataUrl = `data:${frame.type};base64,${Buffer.from(await frame.arrayBuffer()).toString("base64")}`;

  const lineStart = Date.now();
  let line;
  try {
    line = await writeLine({ imageDataUrl, warning, scene: sceneText(motion, camera), recent }, { gemini, openai });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
  const lineMs = Date.now() - lineStart;

  const body: SayResponse = { text: line.text, audio: null, writer: line.writer, lineMs, ttsMs: 0 };
  if (line.text && gemini) {
    const ttsStart = Date.now();
    try {
      const wav = await synthesizeWav(line.text, STYLE[warning.advice ?? "course"], gemini);
      body.audio = wav.toString("base64");
    } catch (e) {
      body.error = String(e);
    }
    body.ttsMs = Date.now() - ttsStart;
  }
  return Response.json(body);
}
