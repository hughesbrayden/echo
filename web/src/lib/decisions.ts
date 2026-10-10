// Asks OpenAI's Decisions API a few questions about the
// newest frame and turns the answers into silence, words, or the alarm.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//
// The questions and thresholds are v0 guesses: tuning them is the main work.
// decide() runs on the server; the phone imports only the phrase helpers.

import type { Announcement, Distance, Guidance, Warning } from "@/lib/announce";
import type { Motion } from "@/lib/motion";

const MODEL = "gpt-6-luna";

// Specific names so Echo can say "Chair ahead" rather than "Obstacle ahead".
// A wrong label only changes the words: whether Echo speaks comes from the
// predicates. Choice answers can be overconfident and shift with option
// order, so score these on recorded walks.
const SUBJECTS = [
  "person",
  "chair",
  "table",
  "bench",
  "pole",
  "trash_can",
  "stairs",
  "curb",
  "door",
  "wall",
  "bicycle",
  "vehicle",
  "sign",
  "other_obstacle",
  "other",
] as const;
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
  // 0..2, probability-weighted: far (over 3 m), near (1-3 m), close (under 1 m).
  distance: number;
  // 0..1: the main thing now is the one Echo last spoke about. Null when
  // there was no earlier frame to compare against.
  same_as_last: number | null;
  // 0..1: there is room to walk past the main thing on its left / right.
  // Null when the model declined to answer, e.g. no floor in view.
  room_left: number | null;
  room_right: number | null;
  // Time spent waiting on the Decisions API.
  latencyMs: number;
  // True when the answers are fake because no API key is set.
  stub: boolean;
};

export type Recent = {
  text: string;
  secondsAgo: number;
  urgent?: boolean;
  // "object|direction" for warnings, so phrasing changes don't break matching.
  key?: string;
};

// Answers from the frames just before this one, newest last.
export type Past = {
  hazard_close: number;
  urgency: number;
  distance: number;
  worth_saying?: number;
  secondsAgo: number;
};

// The frame from when Echo last spoke about something, and how often it has
// mentioned that thing in a row.
export type Reference = { imageDataUrl: string; text: string; secondsAgo: number; mentions: number };

export const THRESHOLDS = {
  alarmHazard: 0.8,
  alarmUrgency: 2.5,
  words: 0.7,
  // The alarm needs this many of the last 3 frames (this one included) over
  // the line, so one noisy frame can't set it off.
  alarmConfirmFrames: 2,
  // Frames older than this don't count toward confirming.
  alarmConfirmWindowS: 2.5,
  // Any two alarms are at least this far apart.
  alarmGapS: 4,
  // Words wait this long after Echo last spoke, so it never talks over itself.
  wordsGapS: 3,
  // After that, the bar for words starts high and eases back down to
  // `words` over this many seconds. Echo can still speak soon after, but
  // only about something the model is sure of. Alarms skip the bar.
  wordsBarRecent: 0.9,
  wordsBarEaseS: 15,
  // Words need the frame before to agree (worth_saying at least this), so one
  // odd frame can't make Echo talk. Caution-level things skip the wait.
  wordsConfirm: 0.5,
  wordsSkipConfirmUrgency: 2,
  // Below "notice", nothing is worth saying, whatever worth_saying says.
  wordsMinUrgency: 1,
  // Above this, the main thing is the one Echo already spoke about.
  sameObject: 0.7,
  // A hazard or distance score that rises this much over the last few frames
  // means it is getting closer, so the alarm sounds again even for something
  // already mentioned.
  approachRise: 0.15,
  approachDistanceRise: 0.5,
  // Distance score cut-offs for the spoken words.
  distanceClose: 1.5,
  distanceNear: 0.5,
  // Below this on both sides, there is no clear way around.
  roomMin: 0.5,
  // Something still in view gets a spoken reminder after this long, doubling
  // each time up to the max, and only while the wearer is walking.
  reminderFirstS: 15,
  reminderMaxS: 60,
  // A different thing with the exact same phrase still waits this long.
  samePhraseS: 10,
};

function overAlarmLine(a: { hazard_close: number; urgency: number }): boolean {
  return a.hazard_close >= THRESHOLDS.alarmHazard && a.urgency >= THRESHOLDS.alarmUrgency;
}

// Every question after the first three is about the same thing, so the
// subject, direction, distance and way around always describe one object.
const TARGET =
  "the main thing: whatever the wearer is most likely to walk into, trip on or step off next, or failing that the most useful landmark nearby (a door, stairs, a curb)";

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
      "Something in or near the walking path, or a door, stairs or curb the wearer is heading toward, is worth calling out to a blind pedestrian right now. Things already in 'Recently said' only count if they are now clearly closer or in the way. Background objects, things far off to the side, and people walking away do not count.",
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
    instructions: `What is ${TARGET}?`,
    choices: SUBJECTS.map((value) => ({ value })),
  },
  {
    type: "choice",
    name: "direction",
    instructions: `Where is ${TARGET}, relative to the center of the image?`,
    choices: DIRECTIONS.map((value) => ({ value })),
  },
  {
    type: "score",
    name: "distance",
    instructions: `How far is ${TARGET} from the wearer?`,
    levels: [
      { label: "far", description: "More than about 3 meters away" },
      { label: "near", description: "About 1 to 3 meters away" },
      { label: "close", description: "Within about 1 meter, a step or two" },
    ],
  },
  {
    type: "predicate",
    name: "room_left",
    instructions:
      "There is open floor to the left of the main thing in the walking path, wide enough for the wearer to walk past it on that side.",
  },
  {
    type: "predicate",
    name: "room_right",
    instructions:
      "There is open floor to the right of the main thing in the walking path, wide enough for the wearer to walk past it on that side.",
  },
];

function contextText(recent: Recent[], motion: Motion | null): string {
  recent = recent.filter((r) => r.secondsAgo < 30).slice(-5);
  const lines = [
    "Head-mounted camera worn by a blind pedestrian.",
    "The image center is where they face; the walking path is the floor in the lower middle of the image.",
  ];
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

// Only asked when there is an earlier frame to compare against.
const SAME_AS_LAST = {
  type: "predicate",
  name: "same_as_last",
  instructions:
    "The main thing in image 2 is the same object Echo already spoke about in image 1, even if the camera has moved.",
};

export async function decide(
  imageDataUrl: string,
  recent: Recent[],
  motion: Motion | null,
  apiKey: string,
  reference: Reference | null = null,
): Promise<Answers> {
  const images = reference
    ? [
        {
          type: "input_text",
          text: `Image 1: the frame when Echo said '${reference.text}', ${Math.round(reference.secondsAgo)}s ago.`,
        },
        { type: "input_image", image_url: reference.imageDataUrl, detail: "low" },
        { type: "input_text", text: "Image 2: the newest frame. All other questions are about image 2." },
        { type: "input_image", image_url: imageDataUrl, detail: "low" },
      ]
    : [{ type: "input_image", image_url: imageDataUrl, detail: "low" }];

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
            ...images,
          ],
        },
      ],
      questions: reference ? [...QUESTIONS, SAME_AS_LAST] : QUESTIONS,
    }),
  });
  const latencyMs = Date.now() - startedAt;
  if (!res.ok) throw new Error(`Decisions API ${res.status}: ${await res.text()}`);

  const { answers } = (await res.json()) as { answers: RawAnswer[] };
  const byName = new Map(answers.map((a) => [a.name, a]));
  const probOrNull = (name: string) => {
    const a = byName.get(name);
    return a?.type === "predicate" ? a.probability : null;
  };
  const prob = (name: string) => probOrNull(name) ?? 0;
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const a = byName.get(name);
    return a?.type === "choice" && allowed.includes(a.choice as T) ? (a.choice as T) : fallback;
  };
  const score = (name: string) => {
    const a = byName.get(name);
    return a?.type === "score" ? a.score : 0;
  };

  return {
    hazard_close: prob("hazard_close"),
    worth_saying: prob("worth_saying"),
    urgency: score("urgency"),
    subject: pick("subject", SUBJECTS, "other"),
    direction: pick("direction", DIRECTIONS, "ahead"),
    distance: score("distance"),
    same_as_last: reference ? prob("same_as_last") : null,
    room_left: probOrNull("room_left"),
    room_right: probOrNull("room_right"),
    latencyMs,
    stub: false,
  };
}

// Fake answers so the phone side works before the API key does.
export function stubAnswers(hasReference: boolean): Answers {
  const roll = Math.random();
  const same_as_last = hasReference ? (Math.random() < 0.7 ? 0.9 : 0.1) : null;
  const base = { same_as_last, room_left: 0.8, room_right: 0.3, latencyMs: 0, stub: true };
  if (roll < 0.05) return { ...base, hazard_close: 0.92, worth_saying: 0.9, urgency: 2.8, subject: "person", direction: "ahead", distance: 1.9 };
  if (roll < 0.15) return { ...base, hazard_close: 0.4, worth_saying: 0.8, urgency: 1.6, subject: "chair", direction: "right", distance: 1.1 };
  return { ...base, hazard_close: 0.05, worth_saying: 0.1, urgency: 0.2, subject: "other", direction: "ahead", distance: 0.2 };
}

const SUBJECT_OBJECTS: Record<Answers["subject"], string> = {
  person: "person",
  chair: "chair",
  table: "table",
  bench: "bench",
  pole: "pole",
  trash_can: "trash can",
  stairs: "stairs",
  curb: "curb",
  door: "door",
  wall: "wall",
  bicycle: "bike",
  vehicle: "vehicle",
  sign: "sign",
  other_obstacle: "obstacle",
  other: "something",
};

function toDistance(score: number): Distance {
  if (score >= THRESHOLDS.distanceClose) return "close";
  if (score >= THRESHOLDS.distanceNear) return "near";
  return "far";
}

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

// Identifies a warning by what and where, ignoring wording and urgency.
export function announcementKey(a: Announcement): string | undefined {
  return a.kind === "warning" ? `${a.object}|${a.direction ?? "ahead"}` : undefined;
}

// Things to walk around. Stairs, curbs, doors, walls and signs are named but
// get no "go around" command.
const GO_AROUND = new Set<Answers["subject"]>([
  "person",
  "chair",
  "table",
  "bench",
  "pole",
  "trash_can",
  "bicycle",
  "vehicle",
  "other_obstacle",
]);

const DROPS = new Set<Answers["subject"]>(["stairs", "curb"]);

// Which way to go. Only for something in the path that is near or close, or
// something beside the wearer that is close enough to brush. Never claims the
// way is clear: it points to the side with more room.
function toGuidance(a: Answers, distance: Distance, urgent: boolean): Guidance | undefined {
  // Stairs and curbs can't be walked around; the useful word is to slow down.
  if (DROPS.has(a.subject)) return !urgent && a.direction === "ahead" && distance !== "far" ? "slow" : undefined;
  if (!GO_AROUND.has(a.subject)) return undefined;
  const close = urgent || distance === "close";
  if (a.direction !== "ahead") {
    if (!close) return undefined;
    return a.direction === "left" ? "keep_right" : "keep_left";
  }
  if (distance === "far" && !urgent) return undefined;
  if (a.room_left === null || a.room_right === null) return undefined;
  if (Math.max(a.room_left, a.room_right) < THRESHOLDS.roomMin) return close ? "wait" : undefined;
  return a.room_left >= a.room_right ? "left" : "right";
}

export function isSameObject(a: Answers): boolean {
  return a.same_as_last !== null && a.same_as_last >= THRESHOLDS.sameObject;
}

// How sure the model must be before Echo speaks words: high right after it
// last spoke, easing down to the base line. A soft cooldown, not a hard one.
function wordsBar(lastSpokeS: number): number {
  const t = (lastSpokeS - THRESHOLDS.wordsGapS) / (THRESHOLDS.wordsBarEaseS - THRESHOLDS.wordsGapS);
  if (!(t < 1)) return THRESHOLDS.words;
  return THRESHOLDS.wordsBarRecent - (THRESHOLDS.wordsBarRecent - THRESHOLDS.words) * Math.max(0, t);
}

// Routes answers to silence, words, or the alarm. Templates, not an LLM.
//
// Echo speaks up about new things right away and then lets them be: the same
// thing gets the alarm again only if it is getting closer, and otherwise an
// occasional spoken reminder while the wearer walks, further apart each time.
export function toAnnouncement(
  a: Answers,
  recent: Recent[],
  history: Past[],
  motion: Motion | null,
  reference: Pick<Reference, "secondsAgo" | "mentions"> | null,
): Announcement | null {
  const distance = toDistance(a.distance);
  const warning: Warning = {
    kind: "warning",
    object: SUBJECT_OBJECTS[a.subject],
    direction: a.direction,
    distance,
    guidance: toGuidance(a, distance, false),
  };
  const alarm: Warning = { ...warning, urgent: true, guidance: toGuidance(a, distance, true) };
  const reminder: Warning = { ...warning, reminder: true };
  const lastSpokeS = Math.min(Infinity, ...recent.map((r) => r.secondsAgo));
  const lastAlarmS = Math.min(Infinity, ...recent.filter((r) => r.urgent).map((r) => r.secondsAgo));
  const same = isSameObject(a);
  const window = history.filter((h) => h.secondsAgo <= THRESHOLDS.alarmConfirmWindowS).slice(-2);

  // A reminder about the same thing, spaced 15 s, 30 s, 60 s, 60 s... apart.
  const reminderDue = () => {
    if (!reference || motion?.walking === false) return false;
    const wait = Math.min(
      THRESHOLDS.reminderFirstS * 2 ** (reference.mentions - 1),
      THRESHOLDS.reminderMaxS,
    );
    return reference.secondsAgo >= wait;
  };

  if (overAlarmLine(a)) {
    const confirmed = 1 + window.filter(overAlarmLine).length >= THRESHOLDS.alarmConfirmFrames;
    if (!confirmed || lastAlarmS < THRESHOLDS.alarmGapS) return null;

    const approaching =
      window.length > 0 &&
      (a.hazard_close - window[0].hazard_close >= THRESHOLDS.approachRise ||
        a.distance - window[0].distance >= THRESHOLDS.approachDistanceRise);
    if (!same || approaching) return alarm;
    // The same hazard, holding still: a reminder in words, not the tone.
    return reminderDue() ? reminder : null;
  }

  if (lastSpokeS < THRESHOLDS.wordsGapS) return null;
  if (a.worth_saying < wordsBar(lastSpokeS)) return null;
  // Nothing nameable, nothing pressing, or far off to the side: not worth words.
  if (a.urgency < THRESHOLDS.wordsMinUrgency) return null;
  if (a.subject === "other" && a.hazard_close < THRESHOLDS.alarmHazard) return null;
  if (distance === "far" && a.direction !== "ahead") return null;
  // One frame isn't enough unless it is already at caution.
  const prev = history[history.length - 1];
  const confirmed =
    a.urgency >= THRESHOLDS.wordsSkipConfirmUrgency ||
    (prev?.worth_saying !== undefined && prev.worth_saying >= THRESHOLDS.wordsConfirm);
  if (!confirmed) return null;
  // Head turns sweep things through view; let them settle before speaking.
  if (motion?.turning) return null;
  if (same) return reminderDue() ? reminder : null;

  const key = announcementKey(warning);
  const samePhrase = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.samePhraseS);
  return samePhrase ? null : warning;
}
