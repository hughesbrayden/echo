// Turns a short phrase into speech with Gemini TTS and returns WAV audio
// (24 kHz mono). The phone calls this so the API key stays on the server.
//
// The same phrase always sounds the same, so clips are cached: GET responses
// are marked immutable for the CDN and the phone's own HTTP cache, and each
// server instance keeps recent clips in memory. Gemini takes about 2 s per
// phrase; a cached clip comes back in well under that.

const MODEL = "gemini-3.8-flash-lite-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_TEXT_LENGTH = 500;
// About 100 KB a clip.
const MAX_MEMORY_CLIPS = 300;
const memory = new Map<string, ArrayBuffer>();

// A year on the CDN, a week on the phone. The phone adds a version to the
// URL, so a voice change only needs that bumped.
const CACHED = "public, max-age=604800, s-maxage=31536000, immutable";

type SpeakRequest = { text?: unknown; style?: unknown };

type InteractionResponse = {
  steps?: { type: string; content?: { type: string; data?: string }[] }[];
};

// GET /api/speak?text=...&style=... : cacheable, what the phone uses.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return speak(params.get("text"), params.get("style") ?? undefined);
}

// POST { text, style }: the same, never cached on the way back.
export async function POST(request: Request) {
  let body: SpeakRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }
  const res = await speak(body.text, body.style);
  if (res.ok) res.headers.set("Cache-Control", "no-store");
  return res;
}

async function speak(text: unknown, style: unknown): Promise<Response> {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    return Response.json(
      { error: `text must be 1-${MAX_TEXT_LENGTH} characters` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const voice = process.env.GEMINI_TTS_VOICE ?? "Kore";
  const key = `${voice}|${typeof style === "string" ? style : ""}|${text}`;
  const hit = memory.get(key);
  if (hit) return wav(hit, "memory");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "GEMINI_API_KEY is not set" }, { status: 500, headers: { "Cache-Control": "no-store" } });
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
        speech_config: [{ voice }],
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    return Response.json(
      { error: `Gemini TTS ${res.status}`, detail },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const data: InteractionResponse = await res.json();
  const audio = data.steps
    ?.filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "audio" && c.data)
    .at(-1)?.data;
  if (!audio) {
    return Response.json(
      { error: "Gemini TTS returned no audio" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const bytes = Buffer.from(audio, "base64");
  const clip = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (memory.size >= MAX_MEMORY_CLIPS) memory.delete(memory.keys().next().value!);
  memory.set(key, clip);
  return wav(clip, "miss");
}

// X-Echo-Cache says where the clip came from, for checking the cache works.
function wav(clip: ArrayBuffer, source: "memory" | "miss"): Response {
  return new Response(clip.slice(0), {
    headers: { "Content-Type": "audio/wav", "Cache-Control": CACHED, "X-Echo-Cache": source },
  });
}
