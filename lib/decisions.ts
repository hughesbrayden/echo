// Server-side only: calls OpenAI's Decisions API and maps answers to DecideResponse.
// Docs: https://developers.openai.com/api/docs/guides/decisions

import type { DecideRequest, DecideResponse, Direction, Subject } from "./contract";
import { buildContextText, buildQuestions, DIRECTIONS, SUBJECTS } from "./questions";

const MODEL = "gpt-6-luna";

type Answer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string; confidence: number }
  | { type: "score"; name: string; score: number; confidence: number }
  | { type: "refusal"; name: string };

export async function decide(req: DecideRequest, apiKey: string): Promise<DecideResponse> {
  const content = [
    { type: "input_text", text: buildContextText(req.recent, req.userRules) },
    ...req.images.map((image_url) => ({ type: "input_image", image_url, detail: "low" })),
  ];

  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/decisions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: [{ role: "user", content }],
      questions: buildQuestions(),
    }),
  });
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    throw new Error(`Decisions API ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { answers: Answer[] };
  const byName = new Map(body.answers.map((a) => [a.name, a]));

  const prob = (name: string) => {
    const a = byName.get(name);
    return a?.type === "predicate" ? a.probability : 0;
  };
  const choice = <T extends string>(name: string, allowed: T[], fallback: T): T => {
    const a = byName.get(name);
    return a?.type === "choice" && allowed.includes(a.choice as T) ? (a.choice as T) : fallback;
  };
  const urgencyAnswer = byName.get("urgency");

  return {
    hazard_close: prob("hazard_close"),
    worth_saying: prob("worth_saying"),
    urgency: urgencyAnswer?.type === "score" ? urgencyAnswer.score : 0,
    subject: choice<Subject>("subject", SUBJECTS, "other"),
    direction: choice<Direction>("direction", DIRECTIONS, "ahead"),
    latencyMs,
    stub: false,
  };
}

/** Fake answers so the phone page can be built before the real API works. */
export function stubDecide(): DecideResponse {
  const roll = Math.random();
  if (roll < 0.1) {
    return { hazard_close: 0.92, worth_saying: 0.9, urgency: 2.8, subject: "person", direction: "ahead", latencyMs: 0, stub: true };
  }
  if (roll < 0.3) {
    return { hazard_close: 0.4, worth_saying: 0.8, urgency: 1.6, subject: "obstacle", direction: "right", latencyMs: 0, stub: true };
  }
  return { hazard_close: 0.05, worth_saying: 0.1, urgency: 0.2, subject: "other", direction: "ahead", latencyMs: 0, stub: true };
}
