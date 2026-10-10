// Turns a short phrase into speech with Gemini TTS and returns WAV audio
// (24 kHz mono). The phone calls this so the API key stays on the server.

import { synthesizeWav } from "@/lib/tts";

const MAX_TEXT_LENGTH = 500;

type SpeakRequest = { text?: unknown; style?: unknown };

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GEMINI_API_KEY is not set" }, { status: 500 });
  }

  let body: SpeakRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }
  const { text, style } = body;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `text must be 1-${MAX_TEXT_LENGTH} characters` },
      { status: 400 },
    );
  }

  try {
    const wav = await synthesizeWav(text, typeof style === "string" ? style : undefined, apiKey);
    return new Response(new Uint8Array(wav), {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
