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

import type { Advice, Announcement, Direction, Distance, Guidance, Warning } from "@/lib/announce";
import { groundDistanceM, type CameraSetup } from "@/lib/geometry";
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
  // 0..5, probability-weighted: where in the frame the main thing meets the
  // ground (0 above the middle ... 4 bottom edge, 5 cut off below the frame).
  base_row: number;
  // Metres along the ground from that row, the camera's height and its tilt.
  // Null when the tilt is unknown or the row is at the horizon.
  meters: number | null;
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
  // The announcement told the wearer which way to go.
  guided?: boolean;
};

// Answers from the frames just before this one, newest last. `gate` is the
// highest of course, footing and orient.
export type Past = { stop: number; distance: number; gate: number; secondsAgo: number };

// The frame from when Echo last spoke about something, and how often it has
// mentioned that thing in a row.
export type Reference = { imageDataUrl: string; text: string; secondsAgo: number; mentions: number };

// A frame from half a second before this one, so the model can see what is moving.
export type Previous = { imageDataUrl: string; secondsAgo: number };

// The background narrator's latest note (see narrator.ts): the setting and
// what has been happening, never positions. The image always wins over it.
export type NarrationContext = {
  summary: string;
  secondsAgo: number;
  // Set only when the last two narrations agree the ground goes up or down.
  groundDirection: "up" | "down" | null;
};

// Older notes are ignored: the scene has likely moved on.
const NARRATION_MAX_AGE_S = 10;

function freshNarration(n: NarrationContext | null): NarrationContext | null {
  return n && n.secondsAgo <= NARRATION_MAX_AGE_S ? n : null;
}

export const THRESHOLDS = {
  // The alarm.
  stop: 0.8,
  // Course and footing speak above this; orienting needs a bit more, since
  // missing a door costs less than missing a curb. Broad questions like
  // these come back less crisp than concrete ones, so the lines sit lower.
  act: 0.55,
  orient: 0.65,
  // Right after Echo speaks, every bar above is raised by this much, easing
  // back to normal over wordsBarEaseS. Echo can still speak soon after, but
  // only about something the model is sure of. The alarm skips this.
  wordsBarRaise: 0.1,
  wordsBarEaseS: 8,
  // Words wait this long after Echo last spoke, so it never talks over itself.
  wordsGapS: 4,
  // The alarm needs this many of the last 3 frames (this one included) over
  // the line, so one noisy frame can't set it off.
  alarmConfirmFrames: 2,
  // Frames older than this don't count toward confirming.
  alarmConfirmWindowS: 2.5,
  // Any two alarms are at least this far apart.
  alarmGapS: 8,
  // Below this, the main thing is the one Echo already spoke about.
  notNew: 0.3,
  // A stop or distance score that rises this much over the last few frames
  // means it is getting closer, so the alarm sounds again even for something
  // already mentioned.
  approachRise: 0.25,
  approachDistanceRise: 0.5,
  // Distance score cut-offs for the spoken words.
  distanceClose: 1.5,
  distanceNear: 0.5,
  // When metres are known (camera height and tilt), these replace the model's
  // own far/near/close: close is within about two steps or 1.5 s of walking.
  closeM: 1.5,
  nearM: 4,
  closeSeconds: 1.5,
  // Camera tilted up past this (degrees): the ground is out of view, so
  // footing can't be judged.
  lookingUpPitch: 10,
  // Head turned further than this from the walking direction (degrees):
  // left and right in the frame aren't left and right of the path, so no
  // go-around commands.
  lookingAwayDeg: 35,
  // Below this on both sides, there is no clear way around.
  roomMin: 0.5,
  // The same height change isn't mentioned again for this long.
  groundRepeatS: 30,
  // Something still in view gets a spoken reminder after this long, doubling
  // each time up to the max, and only while the wearer is walking.
  reminderFirstS: 15,
  reminderMaxS: 60,
  // The same thing in the same place isn't said again for this long. Without
  // a reference frame, this is what stops repeats.
  samePhraseS: 12,
};

// Where the main thing meets the ground, top to bottom of the frame. With the
// camera's height and tilt this gives metres. The last level means its base
// is below the bottom edge, i.e. closer than the ground the frame shows.
const ROW_LEVELS = [
  { label: "above middle", description: "Meets the ground above the middle of the frame", frac: 0.35 },
  { label: "middle", description: "Meets the ground around the middle of the frame", frac: 0.5 },
  { label: "lower middle", description: "Meets the ground between the middle and the bottom", frac: 0.65 },
  { label: "near bottom", description: "Meets the ground close to the bottom of the frame", frac: 0.8 },
  { label: "bottom edge", description: "Meets the ground right at the bottom edge", frac: 0.95 },
  { label: "below frame", description: "Its base is cut off below the bottom of the frame", frac: 1 },
];

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
  {
    type: "score",
    name: "base_row",
    instructions: "How far down the frame that thing meets the ground.",
    levels: ROW_LEVELS.map(({ label, description }) => ({ label, description })),
  },
];

// A probability-weighted row score (0..5) as a fraction down the frame.
function rowFraction(score: number): number {
  const i = Math.max(0, Math.min(ROW_LEVELS.length - 1, score));
  const lo = Math.floor(i);
  const hi = Math.min(lo + 1, ROW_LEVELS.length - 1);
  return ROW_LEVELS[lo].frac + (ROW_LEVELS[hi].frac - ROW_LEVELS[lo].frac) * (i - lo);
}

function measure(baseRow: number, motion: Motion | null, camera: CameraSetup | null): number | null {
  if (!motion || !camera) return null;
  const m = groundDistanceM(rowFraction(baseRow), motion.pitch, camera);
  return m === null ? null : Math.round(m * 10) / 10;
}

// Only asked when there is an earlier frame to compare against.
const NEW_IN_VIEW = {
  type: "predicate",
  name: "new_in_view",
  instructions:
    "The thing that matters most for the wearer's navigation in the newest frame was not in the frame from when Echo last spoke, or is clearly closer than it was.",
};

// Comes before the images: how the wearer is moving, plus a ruler for the
// frame (how far ahead the ground at the bottom and middle is) and walking
// speed, so "a step or two" and "the next few steps" mean something. Kept
// lean on purpose; every extra sentence costs time on every call.
function sceneText(motion: Motion | null, camera: CameraSetup | null): string {
  if (!motion) return "Head-mounted camera on a blind pedestrian.";
  const parts = [`Head-mounted camera on a blind pedestrian who is ${motion.walking ? "walking" : "standing still"}.`];
  if (Math.abs(motion.headOffset) > THRESHOLDS.lookingAwayDeg) {
    parts.push(`They are looking ${motion.headOffset > 0 ? "left" : "right"} of where they are walking.`);
  }
  const tilt = roundTo(motion.pitch, 5);
  if (tilt !== 0) parts.push(`Camera tilted about ${Math.abs(tilt)}° ${tilt < 0 ? "down" : "up"}.`);
  if (camera) {
    const bottom = groundDistanceM(1, motion.pitch, camera);
    const middle = groundDistanceM(0.5, motion.pitch, camera);
    if (bottom !== null && middle !== null) {
      parts.push(`The bottom of the image is ground about ${bottom.toFixed(1)} m ahead, the middle about ${Math.round(middle)} m.`);
    } else if (bottom !== null) {
      parts.push(`The bottom of the image is ground about ${bottom.toFixed(1)} m ahead.`);
    }
    if (motion.walking && motion.cadence > 0) {
      parts.push(`Walking about ${(motion.cadence * camera.stepLengthM).toFixed(1)} m/s.`);
    }
  }
  return parts.join(" ");
}

// What Echo said this long ago or less goes in every call.
const TRANSCRIPT_S = 10;
const ADVICE_LABEL: Record<Advice, string> = {
  stop: "Stop (alarm)",
  course: "Course",
  footing: "Footing",
  orient: "Orient",
};

// Comes after the image, as background: Echo's own recent words, labelled by
// the gate each answered.
function transcriptText(recent: Recent[]): string {
  recent = recent.filter((r) => r.secondsAgo < TRANSCRIPT_S).slice(-3);
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
  previous: Previous | null = null,
  camera: CameraSetup | null = null,
): Promise<Answers> {
  // Oldest first, each labelled, so the newest frame is last and clearly the
  // one the questions are about.
  const image = (url: string) => ({ type: "input_image", image_url: url, detail: "low" });
  const images = [
    ...(reference
      ? [
          {
            type: "input_text",
            text: `The frame from when Echo said '${reference.text}', ${Math.round(reference.secondsAgo)}s ago:`,
          },
          image(reference.imageDataUrl),
        ]
      : []),
    ...(previous
      ? [
          { type: "input_text", text: `The previous frame, ${previous.secondsAgo.toFixed(1)}s ago:` },
          image(previous.imageDataUrl),
        ]
      : []),
    ...(reference || previous
      ? [{ type: "input_text", text: "The newest frame. Every question is about this one:" }]
      : []),
    image(imageDataUrl),
  ];

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
            { type: "input_text", text: sceneText(motion, camera) },
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
    base_row: score("base_row"),
    meters: measure(score("base_row"), motion, camera),
    latencyMs,
    stub: false,
  };
}

// Fake answers so the phone side works before the API key does.
export function stubAnswers(hasReference: boolean): Answers {
  const roll = Math.random();
  const new_in_view = hasReference ? (Math.random() < 0.7 ? 0.1 : 0.9) : null;
  const quiet = { stop: 0.02, course: 0.1, footing: 0.05, orient: 0.1 };
  const base = { new_in_view, room_left: 0.8, room_right: 0.3, base_row: 3, meters: null, latencyMs: 0, stub: true };
  if (roll < 0.01) return { ...base, ...quiet, stop: 0.92, course: 0.9, subject: "person", direction: "ahead", distance: 1.9 };
  if (roll < 0.05) return { ...base, ...quiet, course: 0.85, subject: "chair", direction: "ahead", distance: 1.1 };
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

// Up or down only comes from the narrator, which judges it across frames and
// head pitch, and only when its last two notes agree.
const GROUND_UP_DOWN: Partial<Record<Answers["subject"], Record<"up" | "down", string>>> = {
  ramp: { up: "ramp going up", down: "ramp going down" },
  step: { up: "a step up", down: "a step down" },
  curb: { up: "a step up at the curb", down: "a step down at the curb" },
  stairs: { up: "stairs going up", down: "stairs going down" },
};

// Edges to stay away from rather than walk around.
const EDGES = new Set<Answers["subject"]>(["drop_off", "street_edge"]);

// The everyday warnings, most likely first, so the phone can warm their audio
// after Start: things in the way, height changes and edges, landmarks, then
// reminders. No commands here; those are loaded with the alarms.
export function commonWarnings(): Warning[] {
  const sides: { direction: Direction; distance: Distance }[] = [
    { direction: "ahead", distance: "near" },
    { direction: "ahead", distance: "close" },
    { direction: "left", distance: "near" },
    { direction: "right", distance: "near" },
  ];
  const inTheWay = [...new Set([...GO_AROUND].map((s) => SUBJECT_OBJECTS[s]).concat("obstacle"))];
  const ground = [...GROUND].flatMap((s) => [
    SUBJECT_OBJECTS[s],
    ...Object.values(GROUND_UP_DOWN[s] ?? {}),
  ]).concat("uneven ground");
  const edges = [...EDGES].map((s) => SUBJECT_OBJECTS[s]);
  const landmarks = (["door", "crosswalk", "corner", "wall", "sign"] as const).map((s) => SUBJECT_OBJECTS[s]);

  const warn = (advice: Advice, object: string, at: (typeof sides)[number], extra: Partial<Warning> = {}): Warning => ({
    kind: "warning",
    advice,
    object,
    ...at,
    ...extra,
  });
  return [
    ...inTheWay.flatMap((o) => sides.map((at) => warn("course", o, at))),
    ...ground.flatMap((o) => sides.slice(0, 2).map((at) => warn("footing", o, at, { ground: true }))),
    ...edges.flatMap((o) => sides.map((at) => warn("course", o, at))),
    ...landmarks.flatMap((o) => sides.map((at) => warn("orient", o, at))),
    ...inTheWay.flatMap((o) => sides.slice(0, 2).map((at) => warn("course", o, at, { reminder: true }))),
  ];
}

// Which way to go when changing course. Only for something in the path that
// is near or close, or something beside the wearer that is close enough to
// brush. Never claims the way is clear: it points to the side with more room.
function toGuidance(a: Answers, distance: Distance, urgent: boolean, lookingAway: boolean): Guidance | undefined {
  // Left and right in the frame aren't left and right of the walking path.
  if (lookingAway) return undefined;
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
  narration: NarrationContext | null = null,
  camera: CameraSetup | null = null,
): Announcement | null {
  const lookingUp = !!motion && motion.pitch > THRESHOLDS.lookingUpPitch;
  const lookingAway = !!motion && Math.abs(motion.headOffset) > THRESHOLDS.lookingAwayDeg;
  const speed = motion && camera ? motion.cadence * camera.stepLengthM : 0;
  const distance = toDistance(a.distance, a.meters, speed);
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

  const stopConfirmed =
    a.stop >= THRESHOLDS.stop &&
    1 + window.filter((h) => h.stop >= THRESHOLDS.stop).length >= THRESHOLDS.alarmConfirmFrames;

  // Only things that move get the alarm tone: a person, bike or vehicle can
  // step into the path faster than words. Something that stays put gets firm
  // words instead, and only when the wearer is walking into it.
  if (a.stop >= THRESHOLDS.stop && !MOVES.has(a.subject)) {
    if (!stopConfirmed || !motion?.walking || a.direction !== "ahead" || lookingAway) return null;
    if (lastSpokeS < THRESHOLDS.wordsGapS) return null;
    const close: Warning = {
      kind: "warning",
      advice: "course",
      object: a.subject === "other" ? "obstacle" : object,
      direction: a.direction,
      distance: "close",
      guidance: toGuidance(a, "close", false, lookingAway),
    };
    const key = announcementKey(close);
    return recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.samePhraseS) ? null : close;
  }

  if (a.stop >= THRESHOLDS.stop) {
    if (!stopConfirmed || lastAlarmS < THRESHOLDS.alarmGapS) return null;

    const alarm: Warning = {
      kind: "warning",
      advice: "stop",
      object,
      direction: a.direction,
      distance,
      urgent: true,
      guidance: toGuidance(a, distance, true, lookingAway),
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

  const words = (): Announcement | null => {
    const advice = pickAdvice(a, lastSpokeS);
    if (!advice) return null;
    // Nothing nameable is only worth a landmark line if it's named.
    if (a.subject === "other" && advice === "orient") return null;

    if (advice === "footing") {
      // The ground has to be in view, and far height changes wait: by the
      // time the wearer reaches them the warning would be forgotten.
      if (lookingUp || distance === "far") return null;
      const ground = GROUND.has(a.subject);
      const upDown = freshNarration(narration)?.groundDirection;
      const groundObject = upDown ? (GROUND_UP_DOWN[a.subject]?.[upDown] ?? object) : object;
      const warning: Warning = {
        kind: "warning",
        advice,
        object: ground ? groundObject : a.subject === "other" ? "uneven ground" : object,
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

    const warning: Warning = {
      kind: "warning",
      advice,
      object: a.subject === "other" ? "obstacle" : object,
      direction: a.direction,
      distance,
      guidance: advice === "course" ? toGuidance(a, distance, false, lookingAway) : undefined,
    };
    if (same) {
      // Landmarks are said once; things in the way get the occasional reminder.
      return advice === "course" && reminderDue() ? { ...warning, reminder: true } : null;
    }
    const key = announcementKey(warning);
    const samePhrase = recent.some((r) => r.key === key && r.secondsAgo < THRESHOLDS.samePhraseS);
    return samePhrase ? null : warning;
  };

  return words();
}
