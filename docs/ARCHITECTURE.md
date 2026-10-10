# Echo: Navigation Assistant Architecture

Oct 9, 2026 · Brayden Hughes

## TL;DR

Echo is a pair of camera glasses for blind people that stays quiet until something matters, then sounds an alarm or says a few words, like "Chair, ahead, close."

- A fast decision model (OpenAI's Decisions API) looks at the latest frames and decides whether to speak.
- An emergency gets one alarm tone and a canned phrase. Anything else gets a few words. Most of the time Echo says nothing.
- The real work is designing what the decision model sees and asks, and testing it against recorded walks.
- For the demo, a phone worn at eye level stands in for the glasses, and a small Vercel backend calls the APIs.

## How it works

The pipeline has four stages: capture, decide, respond, tune.

1. **Capture:** the glasses send the latest frames and whether the wearer is walking or turning.
2. **Decide:** the context builder adds what Echo said recently, and the Decisions API returns probabilities for a few questions.
3. **Respond:** the signal tracker smooths those over time and picks silence, a few words, or the alarm.
4. **Tune:** every frame and answer is logged, and the replay harness scores each prompt version so you can improve it.

## The decision model

The [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`, model `gpt-6-luna`) takes text plus images and answers your questions with probabilities. It is in public beta, charges only for input ($0.10 per 1M tokens), and remembers nothing between calls, so each request must say what Echo recently said.

**The question set.** Navigation is the frame: four gates ask what the wearer should do differently, and the rest supply the words. No gate, no words.

| Name | Type | Asks |
| --- | --- | --- |
| `stop` | predicate | Will they walk into something, be hit, or step off an edge within a step or two? |
| `course` | predicate | Should they change direction (something in the way, heading for the street or the edge of the path)? |
| `footing` | predicate | Should they change pace or how they step (curb, step, stairs, ramp, uneven ground, crowd)? |
| `orient` | predicate | Is there something that helps them know where they are or choose where to go (door, corner, crossing, stairs or a ramp to the side)? |
| `subject` | choice | The one thing that matters most for navigation: person, chair, ..., stairs, step, curb, ramp, drop-off, street edge, door, crosswalk, corner, other |
| `direction` | choice | left, ahead, right |
| `distance` | score | far, near, close. Replaced by metres when the camera tilt is known. |
| `base_row` | score | Where that thing meets the ground in the frame; with eye height and tilt this gives metres. |
| `room_left`, `room_right` | predicate | Is there walkable ground to get past what's in the way on that side? |
| `new_in_view` | predicate | Is the thing that matters most new since the frame from when Echo last spoke? Only asked if that frame is sent, which it currently isn't, to keep calls to two images. |

**Context**, kept lean for speed: one line on how the wearer is moving (walking or standing, looking away from the path, camera tilt), the frame from half a second ago, the newest frame, then what Echo said in the last 10 s (up to 3 lines, labelled by gate). The narrator's note is not sent to the decision model; only its up or down call on the ground is used.

**Routing:** `stop` confirmed across two frames sounds the alarm. Otherwise footing wins for height changes, course for things in the way, and orient only above a higher bar. Right after Echo speaks the bar is raised and eases back over 15 s, and words need the previous frame to agree unless the thing is close.

**Spoken lines lead with the action:** "Stop. Person in front. Step left." / "Bear left. Chair ahead." / "Slow down. Curb ahead." / "Door on your right."

## The background narrator

The decision model is fast but remembers nothing. Beside it, every 4 s the phone sends a short run of frames (about 1.5 s apart), what Echo said, and a motion log (camera pitch, head direction, walking, turning) to a slower reasoning call: `gpt-6-luna` on the Responses API with low reasoning effort, about 3 to 10 s per call. It returns a short ambient note (the kind of place, what the wearer is doing, what Echo already told them; no positions or distances) and whether the ground goes up or down. It never speaks on its own. Code: [`web/src/lib/narrator.ts`](../web/src/lib/narrator.ts), `POST /api/narrate`.

- The note is kept off the per-frame call for now to keep it fast; only the up or down call reaches the warnings.
- Up or down is only added to ground warnings ("Stairs going down, just ahead.") when the last two narrations agree; one frame got it wrong in tests.
- If it fails or is slow, the frame loop carries on without it.

## Head motion

The phone reports camera pitch (from gravity) and head direction relative to the walking direction (gyro yaw, re-centred while walking straight). While the camera looks up, ground warnings are skipped; while the head is turned more than 35° from the walking direction, go-around commands are skipped.

## Distance from geometry

The camera sits at the wearer's eye height (set on the start screen, default 160 cm) and the motion sensor gives its tilt, so a point on the ground at a known row of the frame is at a known distance: `eye height / tan(angle below level)`. Two score questions, `base_row` and `ground_row`, ask where the main thing and the height change meet the ground (from "above middle" to "below frame"); [`web/src/lib/geometry.ts`](../web/src/lib/geometry.ts) turns that into metres. Step counting from acceleration peaks gives cadence, and cadence × step length (about 0.45 × eye height) gives walking speed.

- Close is within 1.5 m or 1.5 s of walking; near is within 4 m. When metres aren't available (no tilt, row at the horizon), the model's own far/near/close is used.
- Near things are said in steps: "Chair, about 4 steps ahead. Bear left."
- Both models get the geometry in words ("tilted 20° down; the bottom edge of the frame shows ground about 1.2 m ahead, the middle about 4.4 m") and the walking speed.
- With the head level, the bottom of the frame is about 2.5 m ahead, so anything closer has its base cut off; "below frame" covers that.

## What to test

Record walks, label 100 to 200 frames as "should speak" or "stay quiet", and replay them through each prompt version. Score every version on hazards caught, false alarms, and time to first sound.

| Area | Hypothesis to test |
| --- | --- |
| Context | Two frames 0.5 s apart, cropped to the walking path, beat one full frame |
| Memory | Listing what Echo already said cuts repeats without missing hazards |
| Trends | A rising hazard probability across calls signals something approaching; 2 of 3 calls above threshold cuts false alarms |
| Cheap check first | A tiny "anything here?" call before the full questions saves time and money without missing hazards |
| Words | Phrases built from the decision answers are as good as an LLM, and faster |
| Personal rules | Users can write what matters to them ("doors and stairs always, people only if in my way") and it changes what Echo says |

Run context and trends first, since they decide most of the quality. Personal rules make the best demo moment.

## Sound

Echo has one tone, and it means stop now. A short two-note falling chime (soft sine tones, so it cuts through without grating) plays the moment the decision answers cross the emergency threshold, cuts off anything else, and is followed by a canned phrase like "Stop. Person ahead." Everything non-urgent is a few spoken words with no tone.

The alarm only works if people trust it, so keep false alarms rare. Build it in the browser with the Web Audio API: no sound files, about 10 lines of code.

## Glasses now, phone for the demo

Design for glasses that only capture and speak, with a companion device doing the thinking. For the demo, swap in stand-ins that keep the same interfaces.

| Part | On glasses | In the demo |
| --- | --- | --- |
| Camera and motion sensor | Built into the glasses | Phone strapped at eye level, in the browser |
| Audio | Open-ear speakers | Phone speaker or open-ear headphones |
| Thinking | Companion phone app | Phone browser runs the logic; a thin Vercel function holds the API key and forwards calls |

Because the camera is on the head, directions follow where the wearer is looking, and head turns should not re-trigger things already mentioned. Keep the ears open: blind users rely on ambient sound.

## Why it is new

Today's tools either talk only when asked, or warn on their own with beeps instead of words. Describers like Be My AI, Meta AI on Ray-Ban Meta and ChatGPT live video only speak when asked, and a [study of ChatGPT live video](https://a11y-paradise.onrender.com/reviews/69aae83647290b50c8cfdd16) found it gave no unprompted updates. Obstacle wearables like the [biped harness](https://ophthalmologytimes.com/view/biped-unveils-smart-harness-to-help-visually-impaired-people-avoid-obstacles-while-walking) warn with sounds, not words. The closest research, [WalkVLM](https://arxiv.org/abs/2412.20903v4), is a custom-trained model, not a product.

Echo's angle is a gate on everyday glasses that you can tune, test and personalize: thresholds you set from data, and attention rules written in plain English.

## v1 build plan (hackathon day)

The finish line is one recorded walk: Echo stays quiet, says "Obstacle ahead" before the chair, and sounds the alarm when someone steps in front. Everything else waits until that works end to end.

### The contract both halves build against

The phone posts each frame to `POST /api/frame` (multipart) and the server replies with what to do. Defined in [`web/src/app/api/frame/route.ts`](../web/src/app/api/frame/route.ts).

```
in:  frame (JPEG), motion (JSON: walking, turning, yaw, pitch, headOffset, cadence), camera (JSON: eyeHeightM, vfovDeg, stepLengthM), narration (JSON: summary, secondsAgo, groundDirection), recent (JSON: [{ text, secondsAgo, urgent, advice, guided, key }]),
     history (JSON: last 2 frames' stop, distance, gate), previous (JPEG from half a second ago) + previousInfo (JSON: secondsAgo), reference (JPEG from when Echo last spoke) + referenceInfo (JSON: text, secondsAgo, mentions)
out: { announcement: { kind: "warning", advice, object, direction, distance, guidance?, urgent?, reminder?, ground? } | null, sameObject, answers: { stop, course, footing, orient, new_in_view, subject, direction, distance, base_row, meters, room_left, room_right, latencyMs, stub } }
```

With no `OPENAI_API_KEY` set, the route returns fake answers, so the phone side never waits on the API side.

### Who does what

| Brayden: decisions | Teammate: phone and hosting |
| --- | --- |
| Get the key calling the Decisions API: `node web/scripts/test-decision.mjs photo.jpg` | Deploy to Vercel with Root Directory `web`, set `OPENAI_API_KEY` |
| Own the questions, context text and thresholds in [`web/src/lib/decisions.ts`](../web/src/lib/decisions.ts) | Own [`web/src/components/Camera.tsx`](../web/src/components/Camera.tsx), audio and motion |
| Tune thresholds on recorded walks | Gemini TTS for words, recording and the `/demo` page |

Merge point: set `OPENAI_API_KEY` in Vercel. The on-screen debug line drops "stub" and shows real probabilities. That is the first end-to-end run.

### Milestones

- [x] **M0, scaffold:** camera page, motion, alarm tone, browser speech, `/api/frame` calling the Decisions API with stub fallback
- [ ] **M1, camera to probabilities:** deployed on Vercel, real answers on screen from the phone
- [ ] **M2, end-to-end loop:** continuous frames, routing, alarm and words on the phone
- [ ] **M3, better voice and context:** Gemini TTS for words, alarm phrase as a pre-made clip, recent speech in every request
- [ ] **M4, recorded demo:** record a walk, store it, play it back on `/demo` with the decisions overlaid

Cut until M2 works: a speaking LLM, the cheap pre-check, motion sensors, and the replay harness.

### Streaming

The Decisions API takes images, not video. The camera streams live in the browser and the page sends a 640px JPEG as soon as the previous reply lands (at most every 500 ms), so one call is in flight at a time and it always sends the newest view. Sending two frames for motion is a hypothesis to test.

### Recorded demo (M4)

While walking, record the camera with `MediaRecorder` and keep the decision log the page already builds (time, probabilities, outcome). Upload the video straight from the browser to Vercel Blob or Supabase Storage, not through the function, which caps request bodies at about 4.5 MB. A `/demo` page plays the video with the log synced on top: captions for words, a red flash and the tone for the alarm, live probability bars. Letting the pipeline read a video file instead of the camera means the same walk can be rerun through a new prompt version for a before-and-after.

### Check first

- The OpenAI key can call the Decisions API (it is in public beta).
- iOS plays sound only after a tap, so the page starts with a big Start button.
- The phone camera needs HTTPS: use the Vercel URL, not a local IP.

## Risks and the pitch

- **Latency:** each decision call takes roughly 0.3 to 1 s, mostly network. Echo is an early heads-up, not collision avoidance, and it supplements a cane, never replaces one.
- **Venue wifi:** run on a phone hotspot and keep a backup video.
- **Beta API:** if a call is slow or fails, skip that frame rather than speak late.
- **Made-up objects:** never say a path is clear or safe.

**Pitch:** play ten seconds of an assistant that narrates everything, then show a blindfolded walk where Echo stays quiet, names the chair, and sounds the alarm when someone steps in front. Close on the dashboard showing how much it chose not to say, and how each prompt version scored.
