// Turns a short phrase into speech with Gemini TTS and returns WAV audio
// (24 kHz mono). The phone calls this so the API key stays on the server.

const MODEL = "gemini-3.8-flash-lite-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_TEXT_LENGTH = 500;

type SpeakRequest = { text?: unknown; style?: unknown };

type InteractionResponse = {
  steps?: { type: string; content?: { type: string; data?: string }[] }[];
};

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

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text,
              annotations:
                typeof style === "string" ? [{ type: "speech_metadata", style }] : [],
            },
          ],
        },
      ],
      response_format: { type: "audio" },
      generation_config: {
        speech_config: [{ voice: process.env.GEMINI_TTS_VOICE ?? "Kore" }],
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return Response.json({ error: `Gemini TTS ${res.status}`, detail }, { status: 502 });
  }

  const data: InteractionResponse = await res.json();
  const audio = data.steps
    ?.filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "audio" && c.data)
    .at(-1)?.data;
  if (!audio) {
    return Response.json({ error: "Gemini TTS returned no audio" }, { status: 502 });
  }

  return new Response(Buffer.from(audio, "base64"), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
  });
}
