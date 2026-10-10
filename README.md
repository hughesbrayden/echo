# Echo

Camera glasses for blind people that stay quiet until something matters, then sound an alarm or say a few words. For the hackathon, a phone worn at eye level stands in for the glasses.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the v1 build plan.

## Run it

```
npm install
cp .env.example .env.local   # add OPENAI_API_KEY, or leave empty for fake answers
npm run dev
```

Open http://localhost:3000 on a laptop, or the Vercel URL on a phone (the camera needs HTTPS). Tap **Start**.

Test the key on its own: `OPENAI_API_KEY=sk-... npm run test-decision -- photo.jpg`

## Code map

| File | What it does |
| --- | --- |
| `lib/contract.ts` | The request and response shape both halves agree on |
| `lib/questions.ts` | The Decisions API questions and context text (the part to tune) |
| `lib/decisions.ts` | Calls `POST /v1/decisions`, maps answers; stub answers for offline work |
| `app/api/decide/route.ts` | The Vercel function: holds the key, forwards calls |
| `lib/router.ts` | Thresholds: silence, words or alarm |
| `lib/audio.ts` | Alarm tone (Web Audio) and speech |
| `app/page.tsx` | Camera, frame buffer, request loop, live probabilities and log |
| `scripts/test-decision.mjs` | One-off check that the key can call the Decisions API |

## Deploy

Import the repo in Vercel, set `OPENAI_API_KEY` in project settings, deploy. The function is pinned to `iad1` to sit close to OpenAI.
