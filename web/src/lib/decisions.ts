// Server-side only. Asks OpenAI's Decisions API a few questions about the
// newest frame and turns the answers into silence, words, or the alarm.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//
// The questions and thresholds are v0 guesses: tuning them is the main work.

import { toPhrase, type Announcement, type Warning } from "@/lib/announce";
import type { Motion } from "@/lib/motion";

const MODEL = "gpt-6-luna";

const SUBJECTS = ["obstacle", "person", "stairs", "door", "sign", "vehicle", "other"] as const;
const DIRECTIONS = ["left", "ahead", "right"] as const;

export type Answers = {
  // 0..1: something in the path within ~2 m could be walked into or fallen from.
  hazard_close: number;
  // 0..1: something new, compared to what was recently said, worth saying now.
  worth_saying: number;
  // 0..3, probability-weighted: none, notice, caution, stop.
  urgency: number;
  subject: (typeof SUBJECTS)[number];
  direction: (typeof DIRECTIONS)[number];
  // Time spent waiting on the Decisions API.
  latencyMs: number;
  // True when the answers are fake because no API key is set.
  stub: boolean;
};

export type Recent = { text: string; secondsAgo: number };

export const THRESHOLDS = {
  alarmHazard: 0.8,
  alarmUrgency: 2.5,
  words: 0.7,
};

const QUESTIONS = [
  {
    type: "predicate",
    name: "hazard_close",
    instructions:
      "Something in the wearer's walking path within about 2 meters could be walked into, tripped on, or fallen from.",
  },
  {
    type: "predicate",
    name: "worth_saying",
    instructions:
      "Something in view is new compared to what was recently said, and a blind pedestrian would want to know it right now.",
  },
  {
    type: "score",
    name: "urgency",
    instructions: "How soon must the wearer react to what is in front of them?",
    levels: [
      { label: "none", description: "Nothing needs a reaction" },
      { label: "notice", description: "Worth knowing, not in the way" },
      { label: "caution", description: "In or near the path, a few steps away" },
      { label: "stop", description: "Contact within a step or two" },
    ],
  },
  {
    type: "choice",
    name: "subject",
    instructions: "The single most important thing worth mentioning.",
    choices: SUBJECTS.map((value) => ({ value })),
  },
  {
    type: "choice",
    name: "direction",
    instructions: "Where that thing is relative to where the camera faces.",
    choices: DIRECTIONS.map((value) => ({ value })),
  },
];

function contextText(recent: Recent[], motion: Motion | null): string {
  const lines = ["Head-mounted camera worn by a blind pedestrian."];
  if (motion) {
    lines.push(`The wearer is ${motion.walking ? "walking" : "standing still"}${motion.turning ? " and turning their head" : ""}.`);
  }
  lines.push(
    recent.length === 0
      ? "Echo has said nothing recently."
      : "Recently said: " + recent.map((r) => `'${r.text}' ${Math.round(r.secondsAgo)}s ago`).join("; ") + ".",
  );
  return lines.join(" ");
}

type RawAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string }
  | { type: "score"; name: string; score: number }
  | { type: "refusal"; name: string };

export async function decide(
  imageDataUrl: string,
  recent: Recent[],
  motion: Motion | null,
  apiKey: string,
): Promise<Answers> {
  const startedAt = Date.now();
  const res = await fetch("https://api.openai.com/v1/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: contextText(recent, motion) },
            { type: "input_image", image_url: imageDataUrl, detail: "low" },
          ],
        },
      ],
      questions: QUESTIONS,
    }),
  });
  const latencyMs = Date.now() - startedAt;
  if (!res.ok) throw new Error(`Decisions API ${res.status}: ${await res.text()}`);

  const { answers } = (await res.json()) as { answers: RawAnswer[] };
  const byName = new Map(answers.map((a) => [a.name, a]));
  const prob = (name: string) => {
    const a = byName.get(name);
    return a?.type === "predicate" ? a.probability : 0;
  };
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const a = byName.get(name);
    return a?.type === "choice" && allowed.includes(a.choice as T) ? (a.choice as T) : fallback;
  };
  const urgency = byName.get("urgency");

  return {
    hazard_close: prob("hazard_close"),
    worth_saying: prob("worth_saying"),
    urgency: urgency?.type === "score" ? urgency.score : 0,
    subject: pick("subject", SUBJECTS, "other"),
    direction: pick("direction", DIRECTIONS, "ahead"),
    latencyMs,
    stub: false,
  };
}

// Fake answers so the phone side works before the API key does.
export function stubAnswers(): Answers {
  const roll = Math.random();
  const base = { latencyMs: 0, stub: true };
  if (roll < 0.05) return { ...base, hazard_close: 0.92, worth_saying: 0.9, urgency: 2.8, subject: "person", direction: "ahead" };
  if (roll < 0.15) return { ...base, hazard_close: 0.4, worth_saying: 0.8, urgency: 1.6, subject: "obstacle", direction: "right" };
  return { ...base, hazard_close: 0.05, worth_saying: 0.1, urgency: 0.2, subject: "other", direction: "ahead" };
}

const SUBJECT_OBJECTS: Record<Answers["subject"], string> = {
  obstacle: "obstacle",
  person: "person",
  stairs: "stairs",
  door: "door",
  sign: "sign",
  vehicle: "vehicle",
  other: "something",
};

// Routes answers to silence, a warning, or an urgent warning (the alarm).
// Templates, not an LLM.
export function toAnnouncement(a: Answers, recent: Recent[]): Announcement | null {
  const warning: Warning = { kind: "warning", object: SUBJECT_OBJECTS[a.subject], direction: a.direction };
  if (a.hazard_close >= THRESHOLDS.alarmHazard && a.urgency >= THRESHOLDS.alarmUrgency) {
    return { ...warning, urgent: true };
  }
  // Don't repeat the same phrase within 10 s.
  const phrase = toPhrase(warning);
  const repeat = recent.some((r) => r.text === phrase && r.secondsAgo < 10);
  if (a.worth_saying >= THRESHOLDS.words && !repeat) return warning;
  return null;
}
