// What Echo can say. Anything that detects objects or describes a scene hands
// one of these to <Announcer>, which turns it into words and speech.

export type Direction = "left" | "ahead" | "right";
export type Distance = "close" | "near" | "far";
// Which way to go: around an object on that side, keep away from something
// beside the wearer, or wait when there is no clear way around.
export type Guidance = "left" | "right" | "keep_left" | "keep_right" | "wait";

export type Warning = {
  kind: "warning";
  object: string;
  direction?: Direction;
  distance?: Distance;
  guidance?: Guidance;
  // Urgent warnings sound the alarm tone first and say "Stop."
  urgent?: boolean;
  // A repeat about something already mentioned: "Chair still ahead."
  reminder?: boolean;
};

export type Description = {
  kind: "description";
  text: string;
};

export type Announcement = Warning | Description;

// One spoken piece. Warnings are said as the object, then the direction to
// take, each cached on its own so the short commands are always ready.
export type Segment = { text: string; style: string; maxWaitMs: number };

// Style hints for the TTS model, and how long to wait for Gemini before the
// browser voice speaks instead. A late warning is worse than a plainer voice;
// the Gemini audio still lands in the cache for next time.
const VOICE = {
  alarm: { style: "sharp and urgent, like calling out to stop someone", maxWaitMs: 400 },
  warning: { style: "calm, firm and direct, like a sighted guide", maxWaitMs: 400 },
  command: { style: "firm and clear, a short instruction", maxWaitMs: 400 },
  description: { style: "calm, clear and even", maxWaitMs: 4000 },
};

// Where the thing is, in the words a guide would use.
const PLACE: Record<Direction, Record<Distance, string>> = {
  ahead: { close: "right in front of you", near: "a few steps ahead", far: "up ahead" },
  left: { close: "just to your left", near: "on your left", far: "off to your left" },
  right: { close: "just to your right", near: "on your right", far: "off to your right" },
};

// Firm, short instructions. Close or urgent things get "step", the rest "bear".
function command(g: Guidance, close: boolean): string {
  switch (g) {
    case "left":
      return close ? "Step left." : "Bear left.";
    case "right":
      return close ? "Step right." : "Bear right.";
    case "keep_left":
      return "Keep left.";
    case "keep_right":
      return "Keep right.";
    case "wait":
      return "No clear way around. Wait.";
  }
}

// Every command Echo can give, so the phone can preload them.
export function commandSegments(): Segment[] {
  const texts = new Set<string>();
  for (const g of ["left", "right", "keep_left", "keep_right", "wait"] as const) {
    texts.add(command(g, true));
    texts.add(command(g, false));
  }
  return [...texts].map((text) => ({ text, ...VOICE.command }));
}

// Splits an announcement into what to say, in order, e.g.
// ["Chair, a few steps ahead.", "Bear left."] or
// ["Stop. Person right in front of you.", "Step right."].
export function toSegments(a: Announcement): Segment[] {
  if (a.kind === "description") return [{ text: a.text, ...VOICE.description }];

  const object = a.object.charAt(0).toUpperCase() + a.object.slice(1);
  const direction = a.direction ?? "ahead";
  const segments: Segment[] = [];

  if (a.urgent) {
    segments.push({ text: `Stop. ${object} ${PLACE[direction].close}.`, ...VOICE.alarm });
  } else {
    const place = PLACE[direction][a.distance ?? "near"];
    const text = a.reminder ? `${object} still ${place}.` : `${object}, ${place}.`;
    segments.push({ text, ...VOICE.warning });
  }

  if (a.guidance) {
    const close = !!a.urgent || a.distance === "close";
    segments.push({ text: command(a.guidance, close), ...VOICE.command });
  }
  return segments;
}

// The whole thing as one line, for captions and the log.
export function toPhrase(a: Announcement): string {
  return toSegments(a)
    .map((s) => s.text)
    .join(" ");
}
