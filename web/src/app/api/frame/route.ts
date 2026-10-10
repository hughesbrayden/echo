// Receives one JPEG frame plus head motion from the phone and returns what
// Echo should say. This is the thin server hop from docs/ARCHITECTURE.md: it
// holds the API key so the phone never sees it.

import type { Announcement } from "@/lib/announce";
import type { Motion } from "@/lib/motion";
import {
  decide,
  isSameObject,
  stubAnswers,
  toAnnouncement,
  type Answers,
  type Past,
  type Recent,
  type NarrationContext,
  type Reference,
} from "@/lib/decisions";

// Sit close to OpenAI to cut a network hop.
export const preferredRegion = "iad1";

export type FrameResponse = {
  // What to say, or null to stay quiet.
  announcement: Announcement | null;
  // True when the announcement is about the thing Echo last spoke about.
  sameObject: boolean;
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

  let motion: Motion | null;
  // What Echo said recently, so the stateless decision model can judge what is new.
  let recent: Recent[];
  // Answers for the previous frames, so the alarm can wait for confirmation.
  let history: Past[];
  // When Echo last spoke about something, and how many times in a row.
  let referenceInfo: Omit<Reference, "imageDataUrl"> | null;
  // The background narrator's latest summary.
  let narration: NarrationContext | null;
  try {
    motion = parseJson<Motion | null>(form, "motion", null);
    recent = parseJson<Recent[]>(form, "recent", []);
    history = parseJson<Past[]>(form, "history", []);
    referenceInfo = parseJson<Omit<Reference, "imageDataUrl"> | null>(form, "referenceInfo", null);
    narration = parseJson<NarrationContext | null>(form, "narration", null);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }

  // The frame Echo last spoke about, to tell a new thing from one already said.
  const referenceFrame = form.get("reference");
  const reference: Reference | null =
    referenceInfo && referenceFrame instanceof File && referenceFrame.type.startsWith("image/")
      ? { ...referenceInfo, imageDataUrl: await toDataUrl(referenceFrame) }
      : null;

  const apiKey = process.env.OPENAI_API_KEY;
  let answers: Answers;
  try {
    if (!apiKey || process.env.ECHO_STUB === "1") {
      answers = stubAnswers(reference !== null);
    } else {
      answers = await decide(await toDataUrl(frame), recent, motion, apiKey, reference, narration);
    }
  } catch (e) {
    // The phone skips this frame rather than speaking late.
    return Response.json({ error: String(e) }, { status: 502 });
  }

  const body: FrameResponse = {
    announcement: toAnnouncement(answers, recent, history, motion, referenceInfo, narration),
    sameObject: isSameObject(answers),
    bytes: frame.size,
    answers,
  };
  return Response.json(body);
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

async function toDataUrl(file: File): Promise<string> {
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  return `data:${file.type};base64,${base64}`;
}
