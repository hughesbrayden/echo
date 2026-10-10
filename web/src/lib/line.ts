// Writes what Echo says. The decision questions settle *when* to speak and
// what it's about; this looks at the same frame and words it the way a
// sighted friend walking alongside would, instead of a fixed template.
//
// Server only. Tries a fast Gemini model first and falls back to the OpenAI
// model the narrator uses. Either can answer "(nothing)" to stay quiet when
// the image doesn't back up the hint.

import type { Advice, Warning } from "@/lib/announce";

const GEMINI_MODEL = process.env.ECHO_LINE_MODEL ?? "gemini-3.8-flash-lite";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const OPENAI_MODEL = "gpt-6-luna";
const MAX_WORDS = 14;
const NOTHING = "(nothing)";

// If Gemini turns the request down (bad model name, no access), stop trying
// it on this server instance rather than paying for that on every line.
let geminiBroken = false;

export type LineInput = {
  imageDataUrl: string;
  warning: Warning;
  // How the wearer is moving and how far the frame reaches, in plain words.
  scene: string;
  recent: { text: string; secondsAgo: number }[];
};

export type Line = { text: string; writer: "gemini" | "openai" };

const INSTRUCTIONS = [
  "You are Echo, the voice in the ear of a blind person walking with camera glasses.",
  "Your job is to help them get where they're going safely, like a calm sighted friend walking beside them.",
  "Echo's quick checks flagged something in this frame worth speaking about; the hint below says what.",
  "Look at the image and say the one thing that helps them move right now. Usually that's what to do, then what's there.",
  "For example: 'Wall ahead, the hallway opens to your left.' 'Curb coming up, step down.' 'Chair in front, go around on the right.' 'Door just to your right.'",
  `At most ${MAX_WORDS} words. Left and right are the wearer's. No 'I see' or 'there is'.`,
  "Don't say the way is clear unless you can see that it is. Trust the image over the hint.",
  "Don't repeat what Echo just said unless something changed.",
  `If nothing in the image is actually worth saying, reply with exactly ${NOTHING}`,
].join(" ");

const ADVICE_HINT: Record<Advice, string> = {
  stop: "is about to be in their way",
  course: "is in or near their path, so they may need to change course",
  footing: "is a change in the ground's height or surface, so they may need to slow down or watch their step",
  orient: "is a landmark that helps them know where they are or where to go",
};

const DISTANCE_HINT = { close: "a step or two away", near: "a few steps away", far: "further off" };

const WAY_HINT: Record<string, string> = {
  left: "The side with more room looks like their left.",
  right: "The side with more room looks like their right.",
  keep_left: "They should keep away from it, to the left.",
  keep_right: "They should keep away from it, to the right.",
  wait: "There may be no room to get past.",
  slow: "",
};

function describe(input: LineInput): string {
  const w = input.warning;
  const where = w.direction === "ahead" || !w.direction ? "ahead" : `on their ${w.direction}`;
  const lines = [
    input.scene,
    `Hint: a ${w.object} ${where}${w.distance ? `, ${DISTANCE_HINT[w.distance]}` : ""}, ${ADVICE_HINT[w.advice ?? "course"]}.`,
  ];
  if (w.guidance && WAY_HINT[w.guidance]) lines.push(WAY_HINT[w.guidance]);
  if (w.reminder) lines.push("Echo already mentioned this; a short reminder is fine if it still matters.");
  const recent = input.recent.filter((r) => r.secondsAgo < 30).slice(-3);
  lines.push(
    recent.length
      ? "Echo recently said: " + recent.map((r) => `'${r.text}' ${Math.round(r.secondsAgo)}s ago`).join("; ") + "."
      : "Echo hasn't said anything recently.",
  );
  return lines.join("\n");
}

// The line to say, "" to stay quiet. Throws if neither model answered.
export async function writeLine(input: LineInput, keys: { gemini?: string; openai?: string }): Promise<Line> {
  const prompt = describe(input);
  let lastError: unknown = new Error("No API key for writing lines");
  if (keys.gemini && !geminiBroken) {
    try {
      return { text: clean(await withGemini(prompt, input.imageDataUrl, keys.gemini)), writer: "gemini" };
    } catch (e) {
      if (/Gemini 4(?!29)\d\d/.test(String(e))) geminiBroken = true;
      lastError = e;
      console.warn("Gemini line writer failed; trying OpenAI", e);
    }
  }
  if (keys.openai) {
    try {
      return { text: clean(await withOpenAI(prompt, input.imageDataUrl, keys.openai)), writer: "openai" };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function clean(raw: string): string {
  const text = raw.trim().replace(/^["'“]+|["'”]+$/g, "").replace(/\s+/g, " ");
  if (!text || text.toLowerCase().includes(NOTHING)) return "";
  // Hard cap in case the model rambles: keep the first sentence or two.
  const words = text.split(" ");
  return words.length > MAX_WORDS + 4 ? words.slice(0, MAX_WORDS).join(" ").replace(/[,;]$/, "") + "." : text;
}

type GeminiResponse = { steps?: { type: string; content?: { type: string; text?: string }[] }[] };

async function withGemini(prompt: string, imageDataUrl: string, apiKey: string): Promise<string> {
  const [, mimeType, data] = imageDataUrl.match(/^data:([^;]+);base64,(.*)$/) ?? [];
  const res = await fetch(GEMINI_ENDPOINT, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      input: [
        {
          type: "user_input",
          content: [
            { type: "text", text: `${INSTRUCTIONS}\n\n${prompt}` },
            { type: "image", data, mime_type: mimeType },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json: GeminiResponse = await res.json();
  const text = json.steps
    ?.filter((s) => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join(" ");
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

type ResponsesOutput = { output?: { content?: { type: string; text?: string }[] }[] };

async function withOpenAI(prompt: string, imageDataUrl: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      reasoning: { effort: "low" },
      instructions: INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl, detail: "low" },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Responses API ${res.status}: ${await res.text()}`);
  const data: ResponsesOutput = await res.json();
  const text = data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text;
  if (!text) throw new Error("OpenAI returned no text");
  return text;
}
