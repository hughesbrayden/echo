// Brayden's first step: prove the key can call the Decisions API.
// Usage: OPENAI_API_KEY=sk-... node scripts/test-decision.mjs path/to/photo.jpg [more.jpg]
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (!process.env.OPENAI_API_KEY || files.length === 0) {
  console.error("Usage: OPENAI_API_KEY=sk-... node scripts/test-decision.mjs photo.jpg [photo2.jpg]");
  process.exit(1);
}

const images = files.map((f) => ({
  type: "input_image",
  image_url: `data:image/jpeg;base64,${readFileSync(f).toString("base64")}`,
  detail: "low",
}));

const started = Date.now();
const res = await fetch("https://api.openai.com/v1/decisions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gpt-6-luna",
    input: [{ role: "user", content: [{ type: "input_text", text: "Head-mounted camera worn by a blind pedestrian who is walking. Echo has said nothing recently." }, ...images] }],
    questions: [
      { type: "predicate", name: "hazard_close", instructions: "Something in the wearer's walking path within about 2 meters could be walked into, tripped on, or fallen from." },
      { type: "predicate", name: "worth_saying", instructions: "Something in view is new and a blind pedestrian would want to know it right now." },
      { type: "choice", name: "subject", instructions: "The single most important thing worth mentioning.", choices: ["obstacle", "person", "stairs", "door", "sign", "vehicle", "other"].map((value) => ({ value })) },
    ],
  }),
});

console.log(`HTTP ${res.status} in ${Date.now() - started} ms`);
console.log(JSON.stringify(await res.json(), null, 2));
