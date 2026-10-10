// A slower reasoning pass that runs beside the per-frame decisions. Every few
// seconds it looks at a short run of frames plus what Echo said and how the
// head moved, and keeps a running summary of what is going on. The fast
// decision model is stateless; this summary is its memory.
//
// decide() is called on the server only; the phone imports the types.

import type { Recent } from "@/lib/decisions";

const MODEL = "gpt-6-luna";
const REASONING_EFFORT = "low";

export type GroundTrend = "level" | "going_up" | "going_down" | "unknown";

export type Narration = {
  // One or two short sentences, second person: where the wearer is and what
  // is around them.
  summary: string;
  path: "open" | "obstructed" | "unclear";
  // Whether the ground ahead or underfoot goes up or down, judged across
  // frames and head pitch rather than from one frame.
  ground: GroundTrend;
  // A short spoken update the fast warnings wouldn't give, or null.
  say: string | null;
};

// One sample of the motion log the phone keeps, oldest first.
export type MotionSample = {
  secondsAgo: number;
  pitch: number;
  headOffset: number;
  walking: boolean;
  turning: boolean;
};

export type NarrateInput = {
  // Oldest first.
  frames: { dataUrl: string; secondsAgo: number }[];
  previous: Narration | null;
  recent: Recent[];
  motionLog: MotionSample[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "path", "ground", "say"],
  properties: {
    summary: {
      type: "string",
      description:
        "One or two short sentences in second person: where the wearer is and what is around them, carrying forward what is still true from the previous summary.",
    },
    path: {
      type: "string",
      enum: ["open", "obstructed", "unclear"],
      description: "The walking path ahead in the newest frame.",
    },
    ground: {
      type: "string",
      enum: ["level", "going_up", "going_down", "unknown"],
      description:
        "Whether the ground ahead or underfoot goes up or down (ramp, steps, curb, stairs). Use the frames over time and the camera pitch log. 'unknown' unless the evidence agrees.",
    },
    say: {
      type: ["string", "null"],
      description:
        "At most 10 words to say aloud now, only if it adds something useful that Echo has not said: the route turns, a door or crossing is coming up, the setting changed. Otherwise null.",
    },
  },
};

const INSTRUCTIONS = [
  "You keep track of a walk for Echo, a navigation aid for a blind pedestrian wearing a head-mounted camera.",
  "A fast model already warns about obstacles frame by frame. Your job is the bigger picture: where they are, what has changed, and what is coming up.",
  "Never say a path is clear or safe. Keep everything brief. When unsure, say less and use 'unknown' or null.",
  "Left and right are from the camera's view. Camera pitch is degrees from level: negative looks down.",
].join(" ");

function describe(input: NarrateInput): string {
  const lines: string[] = [];
  lines.push(
    input.previous
      ? `Previous summary: ${input.previous.summary} (ground: ${input.previous.ground}).`
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
