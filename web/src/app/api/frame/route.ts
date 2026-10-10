// Receives one JPEG frame plus head motion from the phone and returns what
// Echo should say. This is the thin server hop from docs/ARCHITECTURE.md: it
// holds the API key so the phone never sees it.

import type { Motion } from "@/lib/motion";

export type FrameResponse = {
  // Words to speak, or null to stay quiet.
  say: string | null;
  // True when the reply is an emergency and should sound the alarm first.
  alarm: boolean;
  bytes: number;
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

  // TODO: forward the frame and motion to the decision API
  // (process.env.OPENAI_API_KEY) and route its answers to silence, words, or
  // the alarm. Motion can suppress repeats while the wearer is turning.
  void motion;
  const body: FrameResponse = { say: null, alarm: false, bytes: frame.size };
  return Response.json(body);
}
