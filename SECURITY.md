# Security Notes (API Keys & Prompts)

This document summarizes the security decisions and constraints discussed for this repo.

## Key Rule

- Server env secrets are safe **only if they are never sent to the browser**.
- Anything returned to the browser (JSON responses, JS bundles, network calls) is public to end users.

## Current Exposure

- `ODYSSEY_API_KEY` is **exposed** to the client via `/api/odyssey/token` in `server/index.js`.
- This means any visitor can read the key in DevTools → Network → `/api/odyssey/token` → Response.
- Vercel secrets **do not protect** values that your API returns to the client.

## Prompt Secrecy (Reality Check)

- Prompts are stored server-side and are not directly sent to the browser.
- However, **prompt injection can still coerce a model to reveal system prompts**.
- Mitigation exists, but **no prompt secrecy can be guaranteed** with current LLM behavior.

## Mitigations Added

- Prompt-leak input screening on `/api/character/chat`.
- System prompt includes explicit refusal to reveal internal instructions.
- Output sanitization if a reply appears to contain instruction-leak content.
- CORS hardened: in production, if `ALLOWED_ORIGINS` is empty, all origins are rejected.

Files touched:
- `server/index.js`

## How To Verify Exposure

Browser:
1. Open the site.
2. DevTools → Network.
3. Click `/api/odyssey/token`.
4. If response contains `apiKey`, it is exposed.

Terminal:
```bash
curl https://your-domain.com/api/odyssey/token
```
If the response contains `"apiKey"`, it is exposed.

## Options To Prevent Odyssey Key Exposure

1. **Disable Odyssey in production**  
   Remove `/api/odyssey/token` and avoid initializing Odyssey on the client.

2. **Auth-gate the token**  
   Only authenticated users can fetch it. This reduces exposure but does not eliminate it.

3. **Server-side relay / ephemeral token flow**  
   Best option if Odyssey supports it. Browser never sees the key.

## Current Decision

- For now, the key exposure is accepted and documented.

