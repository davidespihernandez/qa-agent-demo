# decision-service

A deterministic stand-in for Jev. Fabric's `adaptive-model-router` plugin sends it a prompt and four questions
(`tier`, `deep_reasoning`, `underspecified`, `blast_radius`) at `POST /v1/systemone`; it answers with plain rules in the
Jev response format, so the same prompt always gets the same model. No LLM involved.

- Rules: `pickTier` in `server.ts` (length, keywords, the facts the router sends about the prompt).
- `GET /health`, and `GET /debug/requests` (needs the `x-debug-key` header = `DEBUG_KEY`) shows the last 50 requests and our replies.
- Deploy on Astro and wire it into Fabric: `docs/FABRIC-SETUP.md`, section 8c.

```bash
PORT=8080 bun server.ts
curl localhost:8080/v1/systemone -d '{"state":{"request":"user: Say hi","context":{}},"questions":{"tier":{"type":"choice","criteria":{"fast":"","balanced":"","advanced":"","reasoning":""}}}}'
```
