// What Echo can say. Anything that detects objects or describes a scene hands
// one of these to <Announcer>, which turns it into words and speech.

export type Direction = "left" | "ahead" | "right";
export type Distance = "close" | "near" | "far";

export type Warning = {
  kind: "warning";
  object: string;
  direction?: Direction;
  distance?: Distance;
  // Urgent warnings sound the alarm tone first and say "Stop."
  urgent?: boolean;
};

export type Description = {
  kind: "description";
  text: string;
};

export type Announcement = Warning | Description;

// How each kind should sound, passed to the TTS model as a style hint.
export const SPEECH_STYLE: Record<Announcement["kind"], string> = {
  warning: "urgent, clear and brisk",
  description: "calm, clear and even",
};

// How long to wait for Gemini before the browser voice speaks instead.
// A warning that arrives late is worse than one in a plainer voice. The
// Gemini audio still lands in the cache, so reminders use it.
export const MAX_WAIT_MS: Record<Announcement["kind"], number> = {
  warning: 400,
  description: 4000,
};

const DIRECTION_WORDS: Record<Direction, string> = {
  left: "on your left",
  ahead: "ahead",
  right: "on your right",
};

// Builds the short phrase Echo speaks, e.g. "Chair ahead, close."
export function toPhrase(a: Announcement): string {
  if (a.kind === "description") return a.text;

  const object = a.object.charAt(0).toUpperCase() + a.object.slice(1);
  const phrase = `${object} ${DIRECTION_WORDS[a.direction ?? "ahead"]}`;
  if (a.urgent) return `Stop. ${phrase}.`;
  return a.distance ? `${phrase}, ${a.distance}.` : `${phrase}.`;
}
