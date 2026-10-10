// Turns decision answers into silence, words or the alarm. Runs on the phone.
// Thresholds are starting guesses: tune them on recorded walks.

import type { DecideResponse } from "./contract";

export const THRESHOLDS = {
  alarmHazard: 0.8,
  alarmUrgency: 2.5,
  /** Alarm needs this many of the last 3 answers above threshold. */
  alarmVotes: 2,
  words: 0.7,
  /** Minimum gap between non-urgent phrases. */
  wordsCooldownMs: 3000,
};

export type Outcome =
  | { kind: "silence" }
  | { kind: "words"; text: string }
  | { kind: "alarm"; text: string };

const SUBJECT_WORDS: Record<DecideResponse["subject"], string> = {
  obstacle: "Obstacle",
  person: "Person",
  stairs: "Stairs",
  door: "Door",
  sign: "Sign",
  vehicle: "Vehicle",
  other: "Something",
};

const DIRECTION_WORDS: Record<DecideResponse["direction"], string> = {
  left: "on your left",
  ahead: "ahead",
  right: "on your right",
};

export function phrase(a: DecideResponse): string {
  return `${SUBJECT_WORDS[a.subject]} ${DIRECTION_WORDS[a.direction]}`;
}

export class Router {
  private alarmHistory: boolean[] = [];
  private lastWordsAt = 0;
  private lastPhrase = "";

  route(a: DecideResponse, now = Date.now()): Outcome {
    const alarmish = a.hazard_close >= THRESHOLDS.alarmHazard && a.urgency >= THRESHOLDS.alarmUrgency;
    this.alarmHistory = [...this.alarmHistory, alarmish].slice(-3);
    if (alarmish && this.alarmHistory.filter(Boolean).length >= THRESHOLDS.alarmVotes) {
      this.alarmHistory = [];
      return { kind: "alarm", text: `Stop. ${phrase(a)}.` };
    }

    if (a.worth_saying >= THRESHOLDS.words && now - this.lastWordsAt >= THRESHOLDS.wordsCooldownMs) {
      const text = phrase(a);
      if (text !== this.lastPhrase || now - this.lastWordsAt > 10000) {
        this.lastWordsAt = now;
        this.lastPhrase = text;
        return { kind: "words", text };
      }
    }
    return { kind: "silence" };
  }
}
