// A slower reasoning pass that runs beside the per-frame decisions. Every few
// seconds it looks at a short run of frames plus what Echo said and how the
// head moved, and writes a short ambient note: the kind of place, what the
// wearer is doing, and what Echo has already told them. The fast decision
// model is stateless; this note is its memory. It never speaks on its own and
// never gives positions: the image in each decision always wins.
//
// decide() is called on the server only; the phone imports the types.

import type { Recent } from "@/lib/decisions";
import { describeGeometry, type CameraSetup } from "@/lib/geometry";

const MODEL = "gpt-6-luna";
const REASONING_EFFORT = "low";

export type GroundTrend = "level" | "going_up" | "going_down" | "unknown";

export type Narration = {
  // One or two plain sentences: the setting and what has been happening.
  summary: string;
  // Whether the ground ahead or underfoot goes up or down, judged across
  // frames and head pitch rather than from one frame.
  ground: GroundTrend;
};

// One sample of the motion log the phone keeps, oldest first.
export type MotionSample = {
  secondsAgo: number;
  pitch: number;
  headOffset: number;
  walking: boolean;
  turning: boolean;
  cadence: number;
};

export type NarrateInput = {
  // Oldest first.
  frames: { dataUrl: string; secondsAgo: number }[];
  previous: Narration | null;
  recent: Recent[];
  motionLog: MotionSample[];
  camera: CameraSetup | null;
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "ground"],
  properties: {
    summary: {
      type: "string",
      description:
        "One or two plain sentences, at most about 40 words: the kind of place, how busy it is, what the wearer seems to be doing, and what Echo has already told them that still applies. No exact positions or distances.",
    },
    ground: {
      type: "string",
      enum: ["level", "going_up", "going_down", "unknown"],
      description:
        "Whether the ground ahead or underfoot goes up or down (ramp, steps, curb, stairs). Use the frames over time and the camera pitch log. 'unknown' unless the evidence agrees.",
    },
  },
};

const INSTRUCTIONS = [
  "You are the background awareness for Echo, a navigation aid worn as camera glasses by a blind person.",
  "A separate fast model looks at each new frame and decides whether Echo should speak, but it forgets everything between frames. Your note is how it knows where the wearer is and what has been happening.",
  "You'll get a few recent frames (oldest first), how the wearer has been moving, what Echo has said aloud recently, and your previous note.",
  "Write a fresh note that holds what a sighted companion walking alongside would keep in mind: the kind of place, how busy it is, what the wearer seems to be doing, and what Echo has already told them that still applies.",
  "Think it through however you like. The note itself should be one or two plain sentences.",
  "The fast model always trusts the current image over your note, so leave out exact positions and distances, and don't guess at what you can't see. If the place has changed, start fresh rather than carrying old details forward.",
  "Also judge whether the ground ahead or underfoot goes up or down, using the frames over time and the camera pitch; say 'unknown' unless the evidence agrees.",
  "Camera pitch is degrees from level: negative looks down.",
].join(" ");

function describe(input: NarrateInput): string {
  const lines: string[] = [];
  lines.push(
    input.previous
      ? `Your previous note: ${input.previous.summary} (ground: ${input.previous.ground}).`
      : "This is the start of the walk.",
  );
  lines.push(
    input.recent.length
      ? "Echo recently said: " +
          input.recent.map((r) => `'${r.text}' ${Math.round(r.secondsAgo)}s ago`).join("; ") +
          "."
      : "Echo has said nothing recently.",
  );
  if (input.motionLog.length) {
    lines.push(
      "Motion log, oldest first: " +
        input.motionLog
          .map(
            (m) =>
              `${Math.round(m.secondsAgo)}s ago pitch ${m.pitch}° head ${m.headOffset}°${m.walking ? " walking" : " still"}${m.turning ? " turning" : ""}`,
          )
          .join("; ") +
        ".",
    );
  }
  const latest = input.motionLog.at(-1);
  if (latest && input.camera) {
    lines.push(`Newest frame: ${describeGeometry(latest.pitch, input.camera)}`);
    if (latest.cadence > 0) {
      const speed = latest.cadence * input.camera.stepLengthM;
      lines.push(`Walking at about ${speed.toFixed(1)} m/s; one step is about ${input.camera.stepLengthM} m.`);
    }
  }
  lines.push(
    `The ${input.frames.length} frames below are oldest first, taken ` +
      input.frames.map((f) => `${f.secondsAgo.toFixed(1)}s`).join(", ") +
      " ago.",
  );
  return lines.join("\n");
}

type ResponsesOutput = { output?: { content?: { type: string; text?: string }[] }[] };

export async function narrate(input: NarrateInput, apiKey: string): Promise<Narration> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning: { effort: REASONING_EFFORT },
      instructions: INSTRUCTIONS,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: describe(input) },
            ...input.frames.map((f) => ({ type: "input_image", image_url: f.dataUrl, detail: "low" })),
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "narration", strict: true, schema: SCHEMA } },
    }),
  });
  if (!res.ok) throw new Error(`Responses API ${res.status}: ${await res.text()}`);

  const data: ResponsesOutput = await res.json();
  const text = data.output?.flatMap((o) => o.content ?? []).find((c) => c.type === "output_text")?.text;
  if (!text) throw new Error("Narrator returned no text");
  return JSON.parse(text) as Narration;
}
