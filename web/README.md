# Echo web

Phone client and thin API for the demo described in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

- `src/components/Camera.tsx` captures JPEG frames from the rear camera every 500 ms and posts them, with head motion, to `/api/frame`. It speaks replies and sounds the alarm.
- `src/app/api/frame/route.ts` receives frames and calls the decision step. Without `OPENAI_API_KEY` it returns fake answers.
- `src/lib/decisions.ts` holds the Decisions API questions, context text, thresholds and phrase templates: the part to tune.
- `scripts/test-decision.mjs` checks the API key on its own: `OPENAI_API_KEY=sk-... node scripts/test-decision.mjs photo.jpg`.
- `src/lib/alarm.ts` is the Web Audio alarm tone; `src/lib/motion.ts` summarises walking and turning.

## Run

```bash
npm install
npm run dev        # desktop, http://localhost:3000
npm run dev:phone  # HTTPS on your LAN so a phone can use the camera
```

## Deploy

Import the repo in Vercel and set **Root Directory** to `web`. Add `OPENAI_API_KEY` in project settings.
