// Asks OpenAI's Decisions API a few questions about the
// newest frame and turns the answers into silence, words, or the alarm.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//
// The questions and thresholds are v0 guesses: tuning them is the main work.
// decide() runs on the server; the phone imports only the phrase helpers.

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

export type Recent = { text: string; secondsAgo: number; urgent?: boolean };

// Answers from the frames just before this one, newest last.
export type Past = { hazard_close: number; urgency: number; secondsAgo: number };

export const THRESHOLDS = {
  alarmHazard: 0.8,
  alarmUrgency: 2.5,
  words: 0.7,
  // The alarm needs this many of the last 3 frames (this one included) over
  // the line, so one noisy frame can't set it off.
  alarmConfirmFrames: 2,
  // Frames older than this don't count toward confirming.
  alarmConfirmWindowS: 2.5,
  // The same alarm phrase stays quiet this long after it was said.
  alarmRepeatS: 10,
  // Any two alarms are at least this far apart.
  alarmGapS: 4,
  wordsRepeatS: 10,
};

function overAlarmLine(a: { hazard_close: number; urgency: number }): boolean {
  return a.hazard_close >= THRESHOLDS.alarmHazard && a.urgency >= THRESHOLDS.alarmUrgency;
}

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

// Every alarm Echo can sound, so the phone can preload their audio.
export function urgentWarnings(): Warning[] {
  return SUBJECTS.flatMap((subject) =>
    DIRECTIONS.map((direction) => ({
      kind: "warning" as const,
      object: SUBJECT_OBJECTS[subject],
      direction,
      urgent: true,
    })),
  );
}

// Routes answers to silence, a warning, or an urgent warning (the alarm).
// Templates, not an LLM.
export function toAnnouncement(a: Answers, recent: Recent[], history: Past[] = []): Announcement | null {
  const warning: Warning = { kind: "warning", object: SUBJECT_OBJECTS[a.subject], direction: a.direction };

  if (overAlarmLine(a)) {
    const confirming = history
      .filter((h) => h.secondsAgo <= THRESHOLDS.alarmConfirmWindowS)
      .slice(-2)
      .filter(overAlarmLine).length;
    const confirmed = 1 + confirming >= THRESHOLDS.alarmConfirmFrames;

    const alarm: Warning = { ...warning, urgent: true };
    const phrase = toPhrase(alarm);
    const tooSoon = recent.some(
      (r) =>
        (r.urgent && r.secondsAgo < THRESHOLDS.alarmGapS) ||
        (r.text === phrase && r.secondsAgo < THRESHOLDS.alarmRepeatS),
    );
    // While an alarm waits for confirmation or cools down, stay quiet rather
    // than saying the same hazard as words.
    return confirmed && !tooSoon ? alarm : null;
  }

  const phrase = toPhrase(warning);
  const repeat = recent.some((r) => r.text === phrase && r.secondsAgo < THRESHOLDS.wordsRepeatS);
  if (a.worth_saying >= THRESHOLDS.words && !repeat) return warning;
  return null;
}
