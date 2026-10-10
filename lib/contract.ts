// The one shape both halves of Echo agree on.
// Phone page -> POST /api/decide -> DecideResponse.
// Change it here first, then on both sides.

export type Direction = "left" | "ahead" | "right";

export type Subject =
  | "obstacle"
  | "person"
  | "stairs"
  | "door"
  | "sign"
  | "vehicle"
  | "other";

export interface RecentUtterance {
  text: string;
  secondsAgo: number;
}

export interface DecideRequest {
  /** Newest last. JPEG data URLs (data:image/jpeg;base64,...), 1 to 3 frames. */
  images: string[];
  /** What Echo said recently, so the stateless model can judge what is new. */
  recent: RecentUtterance[];
  /** Optional plain-language attention rules from the user ("doors and stairs always"). */
  userRules?: string;
}

export interface DecideResponse {
  /** 0..1: something in the path within ~2 m could be walked into or fallen from. */
  hazard_close: number;
  /** 0..1: something new and worth saying right now. */
  worth_saying: number;
  /** 0..3, weighted: 0 none, 1 notice, 2 caution, 3 stop. */
  urgency: number;
  subject: Subject;
  direction: Direction;
  /** Server-side time spent waiting on the Decisions API. */
  latencyMs: number;
  /** True when the answers are fake (stub mode). */
  stub: boolean;
}
