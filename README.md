# Interact Studio

Interactive AI character platform at [interactstudio.space](https://interactstudio.space).

Talk to historical figures, animals, and fictional characters in real time — powered by generative media and voice.

## Stack

- **Frontend:** React 18 + TypeScript + Vite
- **Backend:** Express (served as a single Vercel serverless function)
- **AI:** Odyssey ML (avatar streaming), Google Gemini (character intelligence), Smallest AI (voice synthesis)
- **Deployment:** Vercel + custom domain

## Getting started

```bash
cp .env.example .env   # fill in your API keys
npm install
npm run dev            # starts Vite (port 5173) + Express (port 8787) concurrently
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `ODYSSEY_API_KEY` | Avatar video streaming |
| `GEMINI_API_KEY` | Character chat + intelligence |
| `SMALLEST_API_KEY` | Voice synthesis (TTS) |
| `ALLOWED_ORIGINS` | Comma-separated allowed CORS origins in production |

## Deployment

Configured for Vercel. Set env vars in the Vercel dashboard, then:

```bash
vercel --prod
```

The `vercel.json` routes all `/api/*` traffic to a single Express function at `api/server.js`.

## Branch structure

| Branch | Purpose |
|--------|---------|
| `main` | Production — what ships to interactstudio.space |
| `experiments` | Experimental features (gesture control, voice cloning, voice agents) |
