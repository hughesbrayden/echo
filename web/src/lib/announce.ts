// What Echo can say. Anything that detects objects or describes a scene hands
// one of these to <Announcer>, which turns it into words and speech.

export type Direction = "left" | "ahead" | "right";
export type Distance = "close" | "near" | "far";
// Which way to go: around an object on that side, keep away from something
// beside the wearer, or wait for a person or vehicle with no clear way around.
export type Guidance = "left" | "right" | "keep_left" | "keep_right" | "wait" | "slow";

// Which question a warning answers: stop now, change course, change pace or
// footing, or something that helps the wearer orient.
export type Advice = "stop" | "course" | "footing" | "orient";

export type Warning = {
  kind: "warning";
  advice?: Advice;
  object: string;
  direction?: Direction;
  distance?: Distance;
  guidance?: Guidance;
  // Urgent warnings sound the alarm tone first and say "Stop."
  urgent?: boolean;
  // A repeat about something already mentioned: "Chair still ahead."
  reminder?: boolean;
  // A height change in the ground (ramp, step, curb, stairs), not an object.
  ground?: boolean;
};

export type Description = {
  kind: "description";
  text: string;
};

export type Announcement = Warning | Description;

// One spoken piece. Warnings are said as the action, then the thing, each
// cached on its own so the short commands are always ready.
export type Segment = { text: string; style: string; maxWaitMs: number };

// Style hints for the TTS model, and how long to wait for Gemini before the
// browser voice speaks instead. Alarms can't wait: they are all loaded at
// Start, and if one somehow isn't, the browser voice says it at once.
// Warnings and commands wait long enough for an uncached clip (about 2 s);
// most come from the caches warmed at Start and play right away.
const VOICE = {
  alarm: { style: "sharp and urgent, like calling out to stop someone", maxWaitMs: 400 },
  warning: { style: "calm, firm and direct, like a sighted guide", maxWaitMs: 3000 },
  command: { style: "firm and clear, a short instruction", maxWaitMs: 3000 },
  description: { style: "calm, clear and even", maxWaitMs: 4000 },
};


// Where the thing is, in as few words as a guide would use. How close it is
// already shows in "Step" versus "Bear", so there are only two distances.
function place(direction: Direction, close: boolean): string {
  if (direction === "ahead") return close ? "in front" : "ahead";
  return `on your ${direction}`;
}

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
      return "Wait.";
    case "slow":
      return "Slow down.";
  }
}

// Every command Echo can give, so the phone can preload them.
export function commandSegments(): Segment[] {
  const texts = new Set<string>();
  for (const g of ["left", "right", "keep_left", "keep_right", "wait", "slow"] as const) {
    texts.add(command(g, true));
    texts.add(command(g, false));
  }
  return [...texts].map((text) => ({ text, ...VOICE.command }));
}

// Splits an announcement into what to say, in order. The action comes
// first, so the wearer can act on the first word, then the reason:
// ["Bear left.", "Chair ahead."], ["Slow down.", "Curb ahead."],
// ["Stop. Person in front.", "Step right."], ["Door on your right."].
// The alarm keeps "Stop." first and the way out last.
export function toSegments(a: Announcement): Segment[] {
  if (a.kind === "description") return [{ text: a.text, ...VOICE.description }];

  const object = a.object.charAt(0).toUpperCase() + a.object.slice(1);
  const direction = a.direction ?? "ahead";
  const close = !!a.urgent || a.distance === "close";
  const where = place(direction, close);

  if (a.urgent) {
    const segments: Segment[] = [{ text: `Stop. ${object} ${where}.`, ...VOICE.alarm }];
    if (a.guidance) segments.push({ text: command(a.guidance, true), ...VOICE.command });
    return segments;
  }

  const what = a.reminder ? `${object} still ${where}.` : `${object} ${where}.`;
  const segments: Segment[] = [];
  if (a.guidance && !a.reminder) segments.push({ text: command(a.guidance, close), ...VOICE.command });
  segments.push({ text: what, ...(a.advice === "orient" ? VOICE.description : VOICE.warning) });
  return segments;
}

// The whole thing as one line, for captions and the log.
export function toPhrase(a: Announcement): string {
  return toSegments(a)
    .map((s) => s.text)
    .join(" ");
}
