# Echo web

Phone client and thin API for the demo described in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

- `src/components/Camera.tsx` captures JPEG frames from the rear camera every 500 ms and posts them, with head motion, to `/api/frame`. Test buttons play a sample warning, alarm and description.
- `src/app/api/frame/route.ts` receives frames, calls the decision step and returns an `Announcement` or null. Without `OPENAI_API_KEY` it returns fake answers.
- `src/lib/decisions.ts` holds the Decisions API questions, context text, thresholds and phrase templates: the part to tune.
- `scripts/test-decision.mjs` checks the API key on its own: `OPENAI_API_KEY=sk-... node scripts/test-decision.mjs photo.jpg`.
- `src/components/Announcer.tsx` speaks any `Announcement` passed to it (see `src/lib/announce.ts`): a warning (`object`, `direction`, `distance`, `urgent`) or a description (`text`). Urgent warnings play the alarm tone first.
- `src/app/api/speak/route.ts` turns text into speech with `gemini-3.8-flash-lite-tts`. If it fails, the phone falls back to the browser voice.
- `src/lib/alarm.ts` is the Web Audio alarm tone; `src/lib/motion.ts` summarises walking and turning.

## Run

```bash
npm install
npm run dev        # desktop, http://localhost:3000
npm run dev:phone  # HTTPS on your LAN so a phone can use the camera
```

## Deploy

Import the repo in Vercel and set **Root Directory** to `web`. Add `OPENAI_API_KEY` and `GEMINI_API_KEY` (optionally `GEMINI_TTS_VOICE`, default `Kore`) in project settings. For local runs, put them in `.env.local`.
