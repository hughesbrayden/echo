// Gemini TTS on the server: text in, WAV audio (24 kHz mono) out. Shared by
// /api/speak (canned phrases) and /api/say (lines written on the fly).

const MODEL = "gemini-3.8-flash-lite-tts";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";

type InteractionResponse = {
  steps?: { type: string; content?: { type: string; data?: string }[] }[];
};

export async function synthesizeWav(text: string, style: string | undefined, apiKey: string): Promise<Buffer> {
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
              annotations: style ? [{ type: "speech_metadata", style }] : [],
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
  if (!res.ok) throw new Error(`Gemini TTS ${res.status}: ${await res.text()}`);

  const data: InteractionResponse = await res.json();
  const audio = data.steps
    ?.filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "audio" && c.data)
    .at(-1)?.data;
  if (!audio) throw new Error("Gemini TTS returned no audio");
  return Buffer.from(audio, "base64");
}
