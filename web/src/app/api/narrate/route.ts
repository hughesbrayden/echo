// The background narrator: a short run of frames in, a running summary out.
// The phone calls this every few seconds, separately from /api/frame.

import type { Recent } from "@/lib/decisions";
import { narrate, type MotionSample, type Narration } from "@/lib/narrator";

// Sit close to OpenAI to cut a network hop.
export const preferredRegion = "iad1";
// A reasoning call over several images takes a few seconds.
export const maxDuration = 30;

const MAX_FRAMES = 4;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "OPENAI_API_KEY is not set" }, { status: 500 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data" }, { status: 400 });
  }

  let ages: number[];
  let previous: Narration | null;
  let recent: Recent[];
  let motionLog: MotionSample[];
  try {
    ages = parseJson<number[]>(form, "frameAges", []);
    previous = parseJson<Narration | null>(form, "previous", null);
    recent = parseJson<Recent[]>(form, "recent", []);
    motionLog = parseJson<MotionSample[]>(form, "motionLog", []);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }

  const files = form.getAll("frames").filter((f): f is File => f instanceof File && f.type.startsWith("image/"));
  if (files.length === 0 || files.length > MAX_FRAMES || ages.length !== files.length) {
    return Response.json({ error: `Expected 1-${MAX_FRAMES} frames with matching frameAges` }, { status: 400 });
  }

  const frames = await Promise.all(
    files.map(async (f, i) => ({
      dataUrl: `data:${f.type};base64,${Buffer.from(await f.arrayBuffer()).toString("base64")}`,
      secondsAgo: ages[i],
    })),
  );

  const startedAt = Date.now();
  try {
    const narration = await narrate({ frames, previous, recent, motionLog }, apiKey);
    return Response.json({ narration, latencyMs: Date.now() - startedAt });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

function parseJson<T>(form: FormData, field: string, fallback: T): T {
  const raw = form.get(field);
  if (typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${field} JSON`);
  }
}
