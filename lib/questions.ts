// v0 question set for the OpenAI Decisions API. Written to be rewritten:
// tuning these is the main work. Keep names in sync with DecideResponse.

import type { Direction, Subject } from "./contract";

export const SUBJECTS: Subject[] = [
  "obstacle",
  "person",
  "stairs",
  "door",
  "sign",
  "vehicle",
  "other",
];

export const DIRECTIONS: Direction[] = ["left", "ahead", "right"];

export function buildQuestions() {
  return [
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
      instructions:
        "Where that thing is relative to where the camera faces.",
      choices: DIRECTIONS.map((value) => ({ value })),
    },
  ];
}

export function buildContextText(
  recent: { text: string; secondsAgo: number }[],
  userRules?: string,
): string {
  const lines = [
    "Head-mounted camera worn by a blind pedestrian who is walking.",
    "Images are in time order, newest last.",
  ];
  if (recent.length === 0) {
    lines.push("Echo has said nothing recently.");
  } else {
    lines.push(
      "Recently said: " +
        recent.map((r) => `'${r.text}' ${Math.round(r.secondsAgo)}s ago`).join("; ") +
        ".",
    );
  }
  if (userRules) lines.push(`The wearer's priorities: ${userRules}`);
  return lines.join(" ");
}
