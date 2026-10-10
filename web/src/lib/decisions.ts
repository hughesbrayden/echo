// Asks OpenAI's Decisions API a few questions about the
// newest frame and turns the answers into silence, words, or the alarm.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//
// Navigation is the frame for every question. Four gates ask what the wearer
// should do differently (stop, change course, change footing, or orient), and
// a few descriptors supply the words. Anything that changes none of the four
// isn't worth saying.
//
// The questions and thresholds are v0 guesses: tuning them is the main work.
// decide() runs on the server; the phone imports only the phrase helpers.

import type { Advice, Announcement, Distance, Guidance, Warning } from "@/lib/announce";
import type { Motion } from "@/lib/motion";

const MODEL = "gpt-6-luna";

// Specific names so Echo can say "Chair ahead" rather than "Obstacle ahead".
// A wrong label only changes the words: whether Echo speaks comes from the
// gates. Choice answers can be overconfident and shift with option order, so
// score these on recorded walks.
const SUBJECTS = [
  "person",
  "chair",
  "table",
  "bench",
  "pole",
  "trash_can",
  "bicycle",
  "vehicle",
  "other_obstacle",
  "stairs",
  "step",
  "curb",
  "ramp",
  "drop_off",
  "street_edge",
  "door",
  "crosswalk",
  "corner",
  "wall",
  "sign",
  "other",
] as const;
const DIRECTIONS = ["left", "ahead", "right"] as const;

export type Answers = {
  // 0..1 each: what the wearer should do differently right now.
  stop: number;
  course: number;
  footing: number;
  orient: number;
  // 0..1: the thing that matters most is new since the frame from when Echo
  // last spoke, or clearly closer. Null when there was no earlier frame.
  new_in_view: number | null;
  subject: (typeof SUBJECTS)[number];
  direction: (typeof DIRECTIONS)[number];
  // 0..2, probability-weighted: far (over 3 m), near (1-3 m), close (under 1 m).
  distance: number;
  // 0..1: there is room to walk past whatever is in the way on its left /
  // right. Null when the model declined to answer, e.g. no floor in view.
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
  // Which gate the line answered, so the model can tell a footing warning
  // from a course one.
  advice?: Advice;
  // "advice|object|direction" for warnings, so phrasing changes don't break matching.
  key?: string;
};

// Answers from the frames just before this one, newest last. `gate` is the
// highest of course, footing and orient.
export type Past = { stop: number; distance: number; gate: number; secondsAgo: number };

// The frame from when Echo last spoke about something, and how often it has
// mentioned that thing in a row.
export type Reference = { imageDataUrl: string; text: string; secondsAgo: number; mentions: number };

export const THRESHOLDS = {
  // The alarm.
  stop: 0.8,
  // Course and footing speak above this; orienting needs more, since missing
  // a door costs less than missing a curb.
  act: 0.7,
  orient: 0.85,
  // Right after Echo speaks, every bar above is raised by this much, easing
  // back to normal over wordsBarEaseS. Echo can still speak soon after, but
  // only about something the model is sure of. The alarm skips this.
  wordsBarRaise: 0.2,
  wordsBarEaseS: 15,
  // Words wait this long after Echo last spoke, so it never talks over itself.
  wordsGapS: 3,
  // Words need the frame before to agree (its highest gate at least this),
  // so one odd frame can't make Echo talk. Close things skip the wait.
  wordsConfirm: 0.5,
  // The alarm needs this many of the last 3 frames (this one included) over
  // the line, so one noisy frame can't set it off.
  alarmConfirmFrames: 2,
  // Frames older than this don't count toward confirming.
  alarmConfirmWindowS: 2.5,
  // Any two alarms are at least this far apart.
  alarmGapS: 4,
  // Below this, the main thing is the one Echo already spoke about.
  notNew: 0.3,
  // A stop or distance score that rises this much over the last few frames
  // means it is getting closer, so the alarm sounds again even for something
  // already mentioned.
  approachRise: 0.15,
  approachDistanceRise: 0.5,
  // Distance score cut-offs for the spoken words.
  distanceClose: 1.5,
  distanceNear: 0.5,
  // Below this on both sides, there is no clear way around.
  roomMin: 0.5,
  // The same height change isn't mentioned again for this long.
  groundRepeatS: 30,
  // Something still in view gets a spoken reminder after this long, doubling
  // each time up to the max, and only while the wearer is walking.
  reminderFirstS: 15,
  reminderMaxS: 60,
  // A different thing with the exact same phrase still waits this long.
  samePhraseS: 10,
};

const QUESTIONS = [
  {
    type: "predicate",
    name: "stop",
    instructions:
      "If the wearer keeps moving as they are, within the next step or two they will walk into something, be hit by something, or step off an edge. They need to stop now.",
  },
  {
    type: "predicate",
    name: "course",
    instructions:
      "The wearer should change direction in the next few steps: something is in their way, or they are heading toward an edge they should not cross, such as the street or the side of the path.",
  },
  {
    type: "predicate",
    name: "footing",
    instructions:
      "The wearer should change their pace or how they step in the next few steps: the ground ahead of them changes height or surface (a curb, step, stairs, ramp, or uneven or slippery ground), or the space ahead gets crowded.",
  },
  {
    type: "predicate",
    name: "orient",
    instructions:
      "Something in view would help the wearer know where they are or choose where to go, even though they don't need to react to it: a door or entrance, a corner, a crossing, or stairs or a ramp off to the side.",
  },
  {
    type: "choice",
    name: "subject",
    instructions:
      "What is the one thing that matters most for the wearer's navigation right now: what they would stop for, steer around, step carefully at, or use to find their way?",
    choices: SUBJECTS.map((value) => ({ value })),
  },
  {
    type: "choice",
    name: "direction",
    instructions: "Where is that thing, relative to the center of the image?",
    choices: DIRECTIONS.map((value) => ({ value })),
  },
  {
    type: "score",
    name: "distance",
    instructions: "How far is that thing from the wearer?",
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
      "There is open walkable ground to the left of whatever is in the wearer's way, wide enough to walk past it on that side.",
  },
  {
    type: "predicate",
    name: "room_right",
    instructions:
      "There is open walkable ground to the right of whatever is in the wearer's way, wide enough to walk past it on that side.",
  },
];

// Only asked when there is an earlier frame to compare against.
const NEW_IN_VIEW = {
  type: "predicate",
  name: "new_in_view",
  instructions:
    "The thing that matters most for the wearer's navigation in image 2 was not in image 1, or is clearly closer than it was.",
};

// Comes before the image: who is wearing the camera and how they are moving.
// Sensor readings go in rounded, with what they mean for the image, so the
// model can reason with them rather than decode raw numbers.
function sceneText(motion: Motion | null): string {
  const lines = [
    "Camera worn at eye level by a blind pedestrian. The center of the image is where their head points.",
  ];
  if (!motion) return lines.join(" ");

  if (motion.walking) {
    lines.push(
      motion.stepsPerSecond > 0
        ? `They are walking, about ${motion.stepsPerSecond.toFixed(1)} steps per second.`
        : "They are walking.",
    );
  } else {
    lines.push("They are standing still.");
  }
  if (motion.turning) {
    const side = motion.yawDeg > 0 ? "left" : "right";
    lines.push(
      `Their head just turned about ${roundTo(Math.abs(motion.yawDeg), 5)}° to the ${side}, so they may not be walking toward the center of the image.`,
    );
  }
  if (motion.tiltDeg !== null) {
    const tilt = roundTo(motion.tiltDeg, 5);
    lines.push(
      tilt === 0
        ? "The camera points about level."
        : `The camera points about ${Math.abs(tilt)}° ${tilt > 0 ? "below" : "above"} level.`,
    );
  }
  return lines.join(" ");
}

// What Echo said this long ago or less goes in every call.
const TRANSCRIPT_S = 15;
const ADVICE_LABEL: Record<Advice, string> = {
  stop: "Stop (alarm)",
  course: "Course",
  footing: "Footing",
  orient: "Orient",
};

// Comes after the image, as background: Echo's own recent words, labelled by
// the gate each answered.
function transcriptText(recent: Recent[]): string {
  recent = recent.filter((r) => r.secondsAgo < TRANSCRIPT_S).slice(-5);
  if (recent.length === 0) return "Echo has said nothing in the last few seconds.";
  const said = recent.map((r) => {
    const label = r.advice ? `${ADVICE_LABEL[r.advice]}: ` : r.urgent ? "Stop (alarm): " : "";
    return `${label}'${r.text}' ${Math.round(r.secondsAgo)}s ago`;
  });
  return "What Echo said recently: " + said.join("; ") + ".";
}

function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
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
            { type: "input_text", text: sceneText(motion) },
            ...images,
            { type: "input_text", text: transcriptText(recent) },
          ],
        },
      ],
      questions: reference ? [...QUESTIONS, NEW_IN_VIEW] : QUESTIONS,
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
    stop: prob("stop"),
    course: prob("course"),
    footing: prob("footing"),
    orient: prob("orient"),
    new_in_view: reference ? prob("new_in_view") : null,
    subject: pick("subject", SUBJECTS, "other"),
    direction: pick("direction", DIRECTIONS, "ahead"),
    distance: score("distance"),
    room_left: probOrNull("room_left"),
    room_right: probOrNull("room_right"),
    latencyMs,
    stub: false,
  };
}

// Fake answers so the phone side works before the API key does.
export function stubAnswers(hasReference: boolean): Answers {
  const roll = Math.random();
  const new_in_view = hasReference ? (Math.random() < 0.7 ? 0.1 : 0.9) : null;
  const quiet = { stop: 0.02, course: 0.1, footing: 0.05, orient: 0.1 };
  const base = { new_in_view, room_left: 0.8, room_right: 0.3, latencyMs: 0, stub: true };
  if (roll < 0.05) return { ...base, ...quiet, stop: 0.92, course: 0.9, subject: "person", direction: "ahead", distance: 1.9 };
  if (roll < 0.15) return { ...base, ...quiet, course: 0.85, subject: "chair", direction: "ahead", distance: 1.1 };
  if (roll < 0.2) return { ...base, ...quiet, footing: 0.9, subject: "curb", direction: "ahead", distance: 1.0 };
  if (roll < 0.25) return { ...base, ...quiet, orient: 0.92, subject: "door", direction: "right", distance: 1.0 };
  return { ...base, ...quiet, subject: "other", direction: "ahead", distance: 0.2 };
}

const SUBJECT_OBJECTS: Record<Answers["subject"], string> = {
  person: "person",
  chair: "chair",
  table: "table",
  bench: "bench",
  pole: "pole",
  trash_can: "trash can",
  bicycle: "bike",
  vehicle: "vehicle",
  other_obstacle: "obstacle",
  stairs: "stairs",
  step: "a step",
  curb: "curb",
  ramp: "ramp",
  drop_off: "drop-off",
  street_edge: "street edge",
  door: "door",
  crosswalk: "crosswalk",
  corner: "corner",
  wall: "wall",
  sign: "sign",
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
  if (a.kind !== "warning") return undefined;
  const advice = a.advice ?? (a.urgent ? "stop" : "course");
  // Height changes are keyed by distance too, so "close" can follow "near".
  if (a.ground) return `${advice}|${a.object}|${a.distance}`;
  return `${advice}|${a.object}|${a.direction ?? "ahead"}`;
}

// Things to walk around.
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

// Things that move out of the way, so waiting helps. For a pole or a table
// with no clear way past, Echo names it and says nothing more.
const MOVES = new Set<Answers["subject"]>(["person", "bicycle", "vehicle"]);

// Height changes in the ground. Up vs. down is not asked: from one frame it
// came out unreliable in tests, and a wrong "up" before stairs going down is
// worse than none.
const GROUND = new Set<Answers["subject"]>(["stairs", "step", "curb", "ramp"]);

// Edges to stay away from rather than walk around.
const EDGES = new Set<Answers["subject"]>(["drop_off", "street_edge"]);

// Which way to go when changing course. Only for something in the path that
// is near or close, or something beside the wearer that is close enough to
// brush. Never claims the way is clear: it points to the side with more room.
function toGuidance(a: Answers, distance: Distance, urgent: boolean): Guidance | undefined {
  const close = urgent || distance === "close";
  if (EDGES.has(a.subject)) {
    if (a.direction === "left") return "keep_right";
    if (a.direction === "right") return "keep_left";
    return undefined;
  }
  if (!GO_AROUND.has(a.subject)) return undefined;
  if (a.direction !== "ahead") {
    if (!close) return undefined;
    return a.direction === "left" ? "keep_right" : "keep_left";
  }
  if (distance === "far" && !urgent) return undefined;
  if (a.room_left === null || a.room_right === null) return undefined;
  if (Math.max(a.room_left, a.room_right) < THRESHOLDS.roomMin) {
    return close && MOVES.has(a.subject) ? "wait" : undefined;
  }
  return a.room_left >= a.room_right ? "left" : "right";
}

export function isSameObject(a: Answers): boolean {
  return a.new_in_view !== null && a.new_in_view < THRESHOLDS.notNew;
}

// How sure the model must be before Echo speaks words: raised right after it
// last spoke, easing back to `base`. A soft cooldown, not a hard one.
function wordsBar(base: number, lastSpokeS: number): number {
  const t = (lastSpokeS - THRESHOLDS.wordsGapS) / (THRESHOLDS.wordsBarEaseS - THRESHOLDS.wordsGapS);
  if (!(t < 1)) return base;
  return base + THRESHOLDS.wordsBarRaise * (1 - Math.max(0, t));
}

// Which gate to answer. Footing wins for height changes, course for things
// in the way, and orient only when nothing needs a reaction.
function pickAdvice(a: Answers, lastSpokeS: number): Exclude<Advice, "stop"> | null {
  const act = wordsBar(THRESHOLDS.act, lastSpokeS);
  const course = a.course >= act;
  const footing = a.footing >= act;
  const orient = a.orient >= wordsBar(THRESHOLDS.orient, lastSpokeS);
  if (footing && (GROUND.has(a.subject) || !course)) return "footing";
  if (course) return "course";
  if (orient) return "orient";
  return null;
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
  const object = SUBJECT_OBJECTS[a.subject];
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

  if (a.stop >= THRESHOLDS.stop) {
    const confirmed =
      1 + window.filter((h) => h.stop >= THRESHOLDS.stop).length >= THRESHOLDS.alarmConfirmFrames;
    if (!confirmed || lastAlarmS < THRESHOLDS.alarmGapS) return null;

    const alarm: Warning = {
      kind: "warning",
      advice: "stop",
      object,
      direction: a.direction,
      distance,
      urgent: true,
      guidance: toGuidance(a, distance, true),
    };
    const approaching =
      window.length > 0 &&
      (a.stop - window[0].stop >= THRESHOLDS.approachRise ||
        a.distance - window[0].distance >= THRESHOLDS.approachDistanceRise);
    if (!same || approaching) return alarm;
    // The same hazard, holding still: a reminder in words, not the tone.
    return reminderDue() ? { ...alarm, urgent: false, reminder: true } : null;
  }

  if (lastSpokeS < THRESHOLDS.wordsGapS) return null;
  // Head turns sweep things through view; let them settle before speaking.
  if (motion?.turning) return null;

  const advice = pickAdvice(a, lastSpokeS);
  if (!advice) return null;
  // Nothing nameable: not worth words.
  if (a.subject === "other" && advice !== "footing") return null;
  // One frame isn't enough unless the thing is already close.
  const prev = history[history.length - 1];
  const confirmed = distance === "close" || (prev !== undefined && prev.gate >= THRESHOLDS.wordsConfirm);
  if (!confirmed) return null;

  let warning: Warning;
  if (advice === "footing") {
    // Far height changes wait: by the time the wearer reaches them the
    // warning would be forgotten. Ramps are named; the rest get "Slow down."
    if (distance === "far") return null;
    const ground = GROUND.has(a.subject);
    warning = {
      kind: "warning",
      advice,
      object: ground ? object : a.subject === "other" ? "uneven ground" : object,
      direction: ground ? "ahead" : a.direction,
      distance,
      ground,
      guidance: a.subject === "ramp" ? undefined : "slow",
    };
    // Height changes are said once near and once close, keyed by distance.
    const key = announcementKey(warning);
    const said = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.groundRepeatS);
    return said ? null : warning;
  }

  warning = {
    kind: "warning",
    advice,
    object,
    direction: a.direction,
    distance,
    guidance: advice === "course" ? toGuidance(a, distance, false) : undefined,
  };
  if (same) {
    // Landmarks are said once; things in the way get the occasional reminder.
    return advice === "course" && reminderDue() ? { ...warning, reminder: true } : null;
  }
  const key = announcementKey(warning);
  const samePhrase = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.samePhraseS);
  return samePhrase ? null : warning;
}
