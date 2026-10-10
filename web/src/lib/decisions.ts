// Asks OpenAI's Decisions API a few questions about the
// newest frame and turns the answers into silence, words, or the alarm.
// Docs: https://developers.openai.com/api/docs/guides/decisions
//
// The questions and thresholds are v0 guesses: tuning them is the main work.
// decide() runs on the server; the phone imports only the phrase helpers.

import type { Announcement, Distance, Guidance, Warning } from "@/lib/announce";
import { describeGeometry, groundDistanceM, type CameraSetup } from "@/lib/geometry";
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
// Height changes in the walking path. Up vs. down is not asked: from one
// frame it came out unreliable in tests, and a wrong "up" before stairs going
// down is worse than none.
const GROUND_KINDS = ["ramp", "step", "curb", "stairs"] as const;

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
  // 0..1: the ground in the path changes height within a few steps.
  ground_change: number;
  ground_kind: (typeof GROUND_KINDS)[number];
  // 0..2, like distance: how far ahead the height change starts.
  ground_distance: number;
  // 0..5, probability-weighted: where in the frame the main thing meets the
  // ground (0 above the middle ... 4 bottom edge, 5 cut off below the frame),
  // and where the height change starts.
  base_row: number;
  ground_row: number;
  // Metres along the ground from those rows, the camera's height and its
  // tilt. Null when the tilt is unknown or the row is at the horizon.
  meters: number | null;
  ground_meters: number | null;
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
  // The announcement told the wearer which way to go.
  guided?: boolean;
};

// Answers from the frames just before this one, newest last.
export type Past = { hazard_close: number; urgency: number; distance: number; secondsAgo: number };

// The frame from when Echo last spoke about something, and how often it has
// mentioned that thing in a row.
export type Reference = { imageDataUrl: string; text: string; secondsAgo: number; mentions: number };

// The background narrator's latest summary (see narrator.ts), passed along
// so the stateless decision model knows what has been happening.
export type NarrationContext = {
  summary: string;
  secondsAgo: number;
  // Set only when the last two narrations agree the ground goes up or down.
  groundDirection: "up" | "down" | null;
};

// Older summaries are ignored: the scene has likely moved on.
const NARRATION_MAX_AGE_S = 15;

function freshNarration(n: NarrationContext | null): NarrationContext | null {
  return n && n.secondsAgo <= NARRATION_MAX_AGE_S ? n : null;
}

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
  // When metres are known (camera height and tilt), these replace the model's
  // own far/near/close: close is within about two steps or 1.5 s of walking.
  closeM: 1.5,
  nearM: 4,
  closeSeconds: 1.5,
  // Below this on both sides, there is no clear way around.
  roomMin: 0.5,
  // Above this, the ground changes height ahead.
  groundChange: 0.7,
  // The same height change isn't mentioned again for this long.
  groundRepeatS: 30,
  // Camera tilted up past this (degrees): the ground is out of view, so
  // height changes and "Keep walking." can't be judged.
  lookingUpPitch: 10,
  // Head turned further than this from the walking direction (degrees):
  // "ahead" in the frame isn't the way they are walking, so no go-around
  // commands or "Keep walking.".
  lookingAwayDeg: 35,
  // "Keep walking." needs this frame and the one before it this calm.
  clearHazard: 0.2,
  clearUrgency: 1,
  clearGround: 0.3,
  clearWorthSaying: 0.5,
  // Said once the way is clear within this long after a go-around command...
  clearAfterGuidanceS: 15,
  // ...and otherwise after this long of quiet while walking.
  keepWalkingS: 20,
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

// Row answers: top to bottom of the frame. The last means the base is below
// the bottom edge, i.e. closer than the ground the frame shows.
const ROW_LEVELS = [
  { label: "above middle", description: "Meets the ground above the middle of the frame", frac: 0.35 },
  { label: "middle", description: "Meets the ground around the middle of the frame", frac: 0.5 },
  { label: "lower middle", description: "Meets the ground between the middle and the bottom", frac: 0.65 },
  { label: "near bottom", description: "Meets the ground close to the bottom of the frame", frac: 0.8 },
  { label: "bottom edge", description: "Meets the ground right at the bottom edge", frac: 0.95 },
  { label: "below frame", description: "Its base is cut off below the bottom of the frame", frac: 1 },
];

function rowQuestion(name: string, what: string) {
  return {
    type: "score",
    name,
    instructions: `How far down the frame ${what} meets the ground.`,
    levels: ROW_LEVELS.map(({ label, description }) => ({ label, description })),
  };
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
  {
    type: "score",
    name: "distance",
    instructions: "How far that thing is from the wearer.",
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
  {
    type: "predicate",
    name: "ground_change",
    instructions:
      "Within a few steps along the walking path, the ground changes height: a ramp or slope, a step, a curb, or stairs.",
  },
  {
    type: "choice",
    name: "ground_kind",
    instructions: "What changes the ground height in the walking path.",
    choices: GROUND_KINDS.map((value) => ({ value })),
  },
  {
    type: "score",
    name: "ground_distance",
    instructions: "How far ahead the height change starts.",
    levels: [
      { label: "far", description: "More than about 3 meters away" },
      { label: "near", description: "About 1 to 3 meters away" },
      { label: "close", description: "Within about 1 meter, a step or two" },
    ],
  },
  rowQuestion("base_row", "the main thing worth mentioning"),
  rowQuestion("ground_row", "the height change in the walking path starts where it"),
];

// A probability-weighted row score (0..5) as a fraction down the frame.
function rowFraction(score: number): number {
  const i = Math.max(0, Math.min(ROW_LEVELS.length - 1, score));
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, ROW_LEVELS.length - 1);
  return ROW_LEVELS[lo].frac + (ROW_LEVELS[hi].frac - ROW_LEVELS[lo].frac) * (i - lo);
}

function contextText(
  recent: Recent[],
  motion: Motion | null,
  narration: NarrationContext | null,
  camera: CameraSetup | null,
): string {
  recent = recent.filter((r) => r.secondsAgo < 30).slice(-5);
  const lines = ["Head-mounted camera worn by a blind pedestrian."];
  if (motion) {
    lines.push(`The wearer is ${motion.walking ? "walking" : "standing still"}${motion.turning ? " and turning their head" : ""}.`);
    if (camera) {
      lines.push(describeGeometry(motion.pitch, camera));
    } else {
      const tilt = Math.abs(motion.pitch);
      lines.push(
        tilt < 5
          ? "The camera points level."
          : `The camera points ${tilt}° ${motion.pitch < 0 ? "down toward the ground" : "up above level"}.`,
      );
    }
    if (camera && motion.cadence > 0) {
      const speed = motion.cadence * camera.stepLengthM;
      lines.push(`Walking at about ${speed.toFixed(1)} m/s (${motion.cadence} steps per second).`);
    }
    if (Math.abs(motion.headOffset) > THRESHOLDS.lookingAwayDeg) {
      const side = motion.headOffset > 0 ? "left" : "right";
      lines.push(`The wearer is looking about ${Math.abs(motion.headOffset)}° to the ${side} of where they are walking.`);
    }
  }
  const fresh = freshNarration(narration);
  if (fresh) lines.push(`What has been happening (${Math.round(fresh.secondsAgo)}s ago): ${fresh.summary}`);
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
  narration: NarrationContext | null = null,
  camera: CameraSetup | null = null,
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
            { type: "input_text", text: contextText(recent, motion, narration, camera) },
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
    ground_change: prob("ground_change"),
    ground_kind: pick("ground_kind", GROUND_KINDS, "step"),
    ground_distance: score("ground_distance"),
    base_row: score("base_row"),
    ground_row: score("ground_row"),
    ...measure(score("base_row"), score("ground_row"), motion, camera),
    latencyMs,
    stub: false,
  };
}

// Fake answers so the phone side works before the API key does.
export function stubAnswers(hasReference: boolean): Answers {
  const roll = Math.random();
  const same_as_last = hasReference ? (Math.random() < 0.7 ? 0.9 : 0.1) : null;
  const base = {
    same_as_last,
    room_left: 0.8,
    room_right: 0.3,
    ground_change: roll > 0.95 ? 0.9 : 0.05,
    ground_kind: "curb" as const,
    ground_distance: 1.2,
    base_row: 3,
    ground_row: 3,
    meters: null,
    ground_meters: null,
    latencyMs: 0,
    stub: true,
  };
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

// Metres to the main thing and to the height change, from where they meet
// the ground in the frame.
function measure(
  baseRow: number,
  groundRow: number,
  motion: Motion | null,
  camera: CameraSetup | null,
): Pick<Answers, "meters" | "ground_meters"> {
  if (!motion || !camera) return { meters: null, ground_meters: null };
  const round = (m: number | null) => (m === null ? null : Math.round(m * 10) / 10);
  return {
    meters: round(groundDistanceM(rowFraction(baseRow), motion.pitch, camera)),
    ground_meters: round(groundDistanceM(rowFraction(groundRow), motion.pitch, camera)),
  };
}

// Far, near or close: from metres and walking speed when known (close within
// about two steps or 1.5 s of walking), else from the model's own score.
function toDistance(score: number, meters: number | null = null, speed = 0): Distance {
  if (meters !== null) {
    const seconds = speed > 0 ? meters / speed : Infinity;
    if (meters <= THRESHOLDS.closeM || seconds <= THRESHOLDS.closeSeconds) return "close";
    return meters <= THRESHOLDS.nearM ? "near" : "far";
  }
  if (score >= THRESHOLDS.distanceClose) return "close";
  if (score >= THRESHOLDS.distanceNear) return "near";
  return "far";
}

// "About 4 steps" for near things, when metres and step length are known.
function toSteps(distance: Distance, meters: number | null, camera: CameraSetup | null): number | undefined {
  if (distance !== "near" || meters === null || !camera) return undefined;
  const steps = Math.round(meters / camera.stepLengthM);
  return steps >= 2 && steps <= 8 ? steps : undefined;
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
  if (a.kind === "clear") return "clear";
  if (a.kind !== "warning") return undefined;
  // Ground changes are keyed by distance too, so "close" can follow "near".
  if (a.ground) return `ground|${a.object}|${a.distance}`;
  return `${a.object}|${a.direction ?? "ahead"}`;
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

// Things that move out of the way, so waiting helps. For a pole or a table
// with no clear way past, Echo names it and says nothing more.
const MOVES = new Set<Answers["subject"]>(["person", "bicycle", "vehicle"]);

// Which way to go. Only for something in the path that is near or close, or
// something beside the wearer that is close enough to brush. Never claims the
// way is clear: it points to the side with more room.
function toGuidance(
  a: Answers,
  distance: Distance,
  urgent: boolean,
  lookingAway: boolean,
): Guidance | undefined {
  // Left and right in the frame aren't left and right of the walking path.
  if (lookingAway || !GO_AROUND.has(a.subject)) return undefined;
  const close = urgent || distance === "close";
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

// A ramp, step, curb or stairs in the path, said once when it is near ("Curb,
// just ahead. Slow down.") and once more when it is close. Far ones wait: by
// the time the wearer reaches them the warning would be forgotten. Steps,
// curbs and stairs get "Slow down." since the cane needs to find the edge;
// ramps just get named.
// Up or down only comes from the narrator, which judges it across frames and
// head pitch; one frame got it wrong in tests.
const GROUND_OBJECT: Record<Answers["ground_kind"], Record<"up" | "down", string>> = {
  ramp: { up: "ramp going up", down: "ramp going down" },
  step: { up: "a step up", down: "a step down" },
  curb: { up: "a step up at the curb", down: "a step down at the curb" },
  stairs: { up: "stairs going up", down: "stairs going down" },
};

function toGroundWarning(
  a: Answers,
  direction: "up" | "down" | null,
  speed: number,
  camera: CameraSetup | null,
): Warning | null {
  if (a.ground_change < THRESHOLDS.groundChange) return null;
  const distance = toDistance(a.ground_distance, a.ground_meters, speed);
  if (distance === "far") return null;
  const object = direction
    ? GROUND_OBJECT[a.ground_kind][direction]
    : a.ground_kind === "step"
      ? "a step"
      : a.ground_kind;
  const slow = a.ground_kind !== "ramp";
  return {
    kind: "warning",
    ground: true,
    object,
    direction: "ahead",
    distance,
    steps: toSteps(distance, a.ground_meters, camera),
    guidance: slow ? "slow" : undefined,
  };
}

export function isSameObject(a: Answers): boolean {
  return a.same_as_last !== null && a.same_as_last >= THRESHOLDS.sameObject;
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
  narration: NarrationContext | null = null,
  camera: CameraSetup | null = null,
): Announcement | null {
  const lookingUp = !!motion && motion.pitch > THRESHOLDS.lookingUpPitch;
  const lookingAway = !!motion && Math.abs(motion.headOffset) > THRESHOLDS.lookingAwayDeg;
  const speed = motion && camera ? motion.cadence * camera.stepLengthM : 0;
  const distance = toDistance(a.distance, a.meters, speed);
  const warning: Warning = {
    kind: "warning",
    object: SUBJECT_OBJECTS[a.subject],
    direction: a.direction,
    distance,
    steps: toSteps(distance, a.meters, camera),
    guidance: toGuidance(a, distance, false, lookingAway),
  };
  const alarm: Warning = { ...warning, urgent: true, guidance: toGuidance(a, distance, true, lookingAway) };
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

  // Height changes come next: they matter while walking whatever else is in
  // view, and stay quiet for a while once said.
  const ground = lookingUp ? null : toGroundWarning(a, freshNarration(narration)?.groundDirection ?? null, speed, camera);
  if (ground) {
    const key = announcementKey(ground);
    const said = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.groundRepeatS);
    if (!said && lastSpokeS >= THRESHOLDS.wordsGapS) return ground;
  }
  // Stairs and curbs are left to the height-change warning.
  const groundSubject = a.subject === "stairs" || a.subject === "curb";
  if (groundSubject && a.ground_change >= THRESHOLDS.groundChange) return null;

  const words = (): Announcement | null => {
    if (a.worth_saying < THRESHOLDS.words || lastSpokeS < THRESHOLDS.wordsGapS) return null;
    // Head turns sweep things through view; let them settle before speaking.
    if (motion?.turning) return null;
    if (same) return reminderDue() ? reminder : null;

    const key = announcementKey(warning);
    const samePhrase = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.samePhraseS);
    return samePhrase ? null : warning;
  };

  // "Keep walking." when nothing is in the way: once just after going around
  // something, and as a quiet check-in on long calm stretches, which also
  // tells the wearer Echo is still working. It needs two calm frames in a
  // row, the wearer walking and facing where they walk, and the ground in
  // view. It never says the path is clear or safe.
  const keepWalking = (): Announcement | null => {
    if (!motion?.walking || motion.turning || lookingUp || lookingAway) return null;
    const calm =
      a.hazard_close < THRESHOLDS.clearHazard &&
      a.urgency < THRESHOLDS.clearUrgency &&
      a.ground_change < THRESHOLDS.clearGround &&
      a.worth_saying < THRESHOLDS.clearWorthSaying;
    const previous = window.at(-1);
    if (!calm || !previous || previous.hazard_close >= THRESHOLDS.clearHazard) return null;
    if (lastSpokeS < THRESHOLDS.wordsGapS) return null;

    const lastClearS = Math.min(Infinity, ...recent.filter((r) => r.key === "clear").map((r) => r.secondsAgo));
    const lastGuidedS = Math.min(Infinity, ...recent.filter((r) => r.guided).map((r) => r.secondsAgo));
    const justWentAround = lastGuidedS < THRESHOLDS.clearAfterGuidanceS && lastClearS > lastGuidedS;
    return justWentAround || lastSpokeS >= THRESHOLDS.keepWalkingS ? { kind: "clear" } : null;
  };

  return words() ?? keepWalking();
}
