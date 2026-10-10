# Echo web

Phone client and thin API for the demo described in [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

- `src/components/Camera.tsx` captures JPEG frames from the rear camera every 500 ms and posts them, with head motion, to `/api/frame`. It speaks replies and sounds the alarm.
- `src/app/api/frame/route.ts` receives frames. The decision API call is still a TODO; it currently always stays quiet.
- `src/lib/alarm.ts` is the Web Audio alarm tone; `src/lib/motion.ts` summarises walking and turning.

## Run

```bash
npm install
npm run dev        # desktop, http://localhost:3000
npm run dev:phone  # HTTPS on your LAN so a phone can use the camera
```

## Deploy

Import the repo in Vercel and set **Root Directory** to `web`. Add `OPENAI_API_KEY` once the route calls the API.
