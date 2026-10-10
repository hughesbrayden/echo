# echo
Echo: blind navigation hackathon app

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the design and the v1 build plan, including who owns what
- [web/](web/): the Next.js phone client and `/api/frame`, which calls the OpenAI Decisions API (fake answers until `OPENAI_API_KEY` is set)

Check the API key on its own: `OPENAI_API_KEY=sk-... node web/scripts/test-decision.mjs photo.jpg`
