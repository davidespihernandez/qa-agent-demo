# decision-service

A small, deterministic **decision service** for Fabric's `adaptive-model-router` plugin. It decides which model tier a prompt needs with plain rules (length, keywords, a few facts about the request). **No LLM involved: the same prompt always gets the same model.**

It stands in for Jev, the decision service Fabric uses by default. The router accepts any HTTP service that answers in the Jev format, so you can bring your own routing logic (business rules, a classifier, a small LLM) without waiting for Fabric to offer it.

## How it fits together

```
agent ──▶ Fabric route /anthropic-adaptive-rules
              │  adaptive-model-router plugin
              │   1. builds {state, questions} from the request
              │   2. POST /v1/systemone ──▶ decision-service (this repo, on Astro)
              │   3. reads the answers, maps the tier to a model
              ▼   4. rewrites "model" in the request
          Anthropic (Haiku, Sonnet or Opus)
```

The agent never knows which model answered; the gateway changes it in flight. Traces in Fabric show the decision call and the model used.

## What it receives

`POST /v1/systemone`

- `state.request`: the user's request as text.
- `state.context`: facts the plugin computes about it: `prompt_tokens_estimate`, `has_code`, `needs_structured_output`, `is_long_context`, `has_tools`, `tool_names`.
- `questions`: four questions to answer.

| Question | Type | Meaning |
|---|---|---|
| `tier` | choice: `fast`, `balanced`, `advanced`, `reasoning` | which tier the prompt needs |
| `deep_reasoning` | yes/no probability (`noul`, 0 to 1) | does it need deep reasoning |
| `underspecified` | yes/no probability | is the request vague |
| `blast_radius` | score: Low, Medium, High | how costly a mistake would be |

(You can see real requests with `GET /debug/requests`, see below. The example below is simplified.)

## What it returns

`{ model, answers, usage }`, one typed answer per question, with confidence and probabilities. Example (trimmed), run against this service:

```bash
PORT=8080 bun server.ts
curl localhost:8080/v1/systemone -d '{
  "model": "jev-1.13.0",
  "state": {"request": "user: Review these orders and flag the suspicious ones",
            "context": {"has_tools": true, "needs_structured_output": true}},
  "questions": {
    "tier": {"type": "choice", "criteria": {"fast": "", "balanced": "", "advanced": "", "reasoning": ""}},
    "blast_radius": {"type": "score", "criteria": ["Low", "Medium", "High"]}
  }
}'
```

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "tier": {"type": "choice", "choice": "balanced", "confidence": 1,
             "probabilities": {"fast": 0, "balanced": 1, "advanced": 0, "reasoning": 0}},
    "blast_radius": {"type": "score", "score": 1, "confidence": 1,
                     "probabilities": {"0": 0, "1": 1, "2": 0},
                     "legend": {"0": "Low", "1": "Medium", "2": "High"}}
  },
  "usage": {"input_tokens": 0, "output_tokens": 0}
}
```

The format has to be **exactly** the Jev one. With extra top-level fields (`id`, `provider`, `usage.cost`) the plugin rejected the answer ("Jev decision failed" after a 200).

## How it decides

`pickTier` in `server.ts`, in this order:

1. `advanced` if the text is over 8,000 characters, contains reasoning words (`prove`, `step by step`, `trade-off`, ...), or has code, long context or words like `architecture`, `refactor`.
2. `balanced` if the request has tools or structured output, is over 400 characters, or has words like `review`, `fraud`, `orders`, `summarize`.
3. `fast` otherwise.

It never returns `reasoning`: the plugin maps it to a model our Anthropic workspace cannot call. The other answers (`deep_reasoning`, `blast_radius`) follow the tier. Change the rules in `pickTier`, redeploy, and the routing changes.

## How the plugin turns the answers into a model

Observed on 2026-10-27, not a documented contract (the thresholds live inside the plugin and may change):

- `fast` = claude-haiku-5-5, `balanced` = claude-sonnet-5-5, `advanced` = claude-opus-5-5.
- The other answers can move the choice up. From `fast`, `deep_reasoning` 0.8 gives Sonnet and 0.95 gives Opus; `underspecified` 0.95 and `blast_radius` High each go one step up.

## Debugging

- `GET /health` returns `{"ok":true}`.
- `GET /debug/requests` (header `x-debug-key` = `DEBUG_KEY`): the last 50 requests and our replies, to see what the plugin really sends.
- `POST /debug/override` (same key): force answers, for example `{"tier":"fast","deep_reasoning":0.95}`, to see what the router reacts to. `{}` clears it. Resets when the service restarts.

## Limits (worth saying out loud)

- It is a demo stand-in: keyword and length rules, not a real classifier.
- `/v1/systemone` does not check the credential Fabric sends. If the service is public, anyone can call it; do not put anything sensitive behind it.
- Whether customers get access to Jev is unconfirmed.
- The tier-to-model map and the thresholds are observations.

## Run and deploy

Locally: `PORT=8080 bun server.ts`. Deploy on Astro and wire it into Fabric (connection, credential, route, plugin): `docs/FABRIC-SETUP.md`, section 8c.
