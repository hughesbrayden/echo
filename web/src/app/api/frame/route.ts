// Receives one JPEG frame plus head motion from the phone and returns what
// Echo should say. This is the thin server hop from docs/ARCHITECTURE.md: it
// holds the API key so the phone never sees it.

import type { Motion } from "@/lib/motion";
import { decide, stubAnswers, toReply, type Answers, type Recent } from "@/lib/decisions";

// Sit close to OpenAI to cut a network hop.
export const preferredRegion = "iad1";

export type FrameResponse = {
  // Words to speak, or null to stay quiet.
  say: string | null;
  // True when the reply is an emergency and should sound the alarm first.
  alarm: boolean;
  bytes: number;
  // Raw decision answers, for the on-screen debug line and the demo log.
  answers?: Answers;
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

  let motion: Motion | null = null;
  const rawMotion = form.get("motion");
  if (typeof rawMotion === "string") {
    try {
      motion = JSON.parse(rawMotion);
    } catch {
      return Response.json({ error: "Invalid motion JSON" }, { status: 400 });
    }
  }

  // What Echo said recently, so the stateless decision model can judge what is new.
  let recent: Recent[] = [];
  const rawRecent = form.get("recent");
  if (typeof rawRecent === "string") {
    try {
      recent = JSON.parse(rawRecent);
    } catch {
      return Response.json({ error: "Invalid recent JSON" }, { status: 400 });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  let answers: Answers;
  try {
    if (!apiKey || process.env.ECHO_STUB === "1") {
      answers = stubAnswers();
    } else {
      const base64 = Buffer.from(await frame.arrayBuffer()).toString("base64");
      answers = await decide(`data:${frame.type};base64,${base64}`, recent, motion, apiKey);
    }
  } catch (e) {
    // The phone skips this frame rather than speaking late.
    return Response.json({ error: String(e) }, { status: 502 });
  }

  const body: FrameResponse = { ...toReply(answers, recent), bytes: frame.size, answers };
  return Response.json(body);
}
