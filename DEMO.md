# Demo script: a governed fraud agent (about 50 minutes)

One agent, one story: **build it on Astro, put Fabric in front, watch and control it.**
Token savings are the last act ("what comes next"), not the main claim.

The agent reviews orders from the Orders/Users/Payments APIs and reports suspicious ones
(over $10,000, unknown customer, 3 or more identical orders) to a Postman Flow webhook.

## Before you start

- Orders API reachable (`GET /health`), Flow webhook URL in `FRAUD_WEBHOOK_URL`, Fabric key in `.env`.
- Run `D1. Orders - RESET` in the Postman collection so the data is two clean orders.
- Have a recorded run and screenshots ready as a fallback (agent runs are non-deterministic).

## Act 1: Astro, build and run the agent (15 min)

Slides: *Astro turns an agent into a service*, *Anatomy of the agent*.

1. **Brain, hands, instructions.** Open `agent/agent/fraud-agent.ts`:
   - **Brain:** the model. `astropods.yml` declares `models: anthropic`; `QA_MODEL` picks the model;
     `LLM_BASE_URL` decides whether it goes direct or through Fabric. Nothing else in the code changes.
   - **Hands:** the tools. API tools are generated from the OpenAPI spec (`specs/demo-apis.json`),
     read-only. `report_fraud` is the one write: it POSTs to the Flow webhook with an Idempotency-Key.
   - **Instructions:** `fraud-policy.md`, plain English. Change the policy, change the behaviour.
2. **Run it locally:** `ast dev`, open the playground, ask for a review. Show the steps (read orders,
   look up each customer once, report each finding).
3. **Change and redeploy:** edit the policy (for example raise the limit to $20,000), `ast blueprint push`,
   run again, see a different result. Policy version is part of the alert key, so a new policy means new alerts.
4. **Use it from outside:** Postman `POST /review` (arm, `live`, `wait`). The same agent answers chat and HTTP.

## Act 2: Fabric, the front door (15 min)

Slides: *Fabric in four building blocks*, *Following one request*, *What we set up in Fabric*.

1. **Concepts in 2 minutes:** service (where traffic ends up), route (the address on the gateway),
   plugin (a rule on a route), credential (a secret in the vault).
2. **What we set up** (show the console, same names as the slide):
   - `/agent`: our agent on Astro, so Postman calls it through Fabric.
   - `/api`: the Orders API, so the agent reads data through Fabric.
   - `/anthropic`: Anthropic, so the agent calls the LLM through Fabric.
   - `/anthropic-select`: Anthropic, but the service only allows Haiku 4.5 and Sonnet 4.5.
3. **Simplified authentication.** Compare arm A and arm F (`POST /review`, `arm: "A"` then `"F"`):
   - A: the agent holds the Anthropic key and talks to every API itself.
   - F: the agent holds one gateway key. The Anthropic key lives in Fabric's vault, write-only.
   Show the credential page and the key-auth plugin on a route.
4. **Control.**
   - Ask `/anthropic-select` for Opus: `400 Model ... is not allowed for service "anthropic-select"`.
     Fabric decides which models an agent or team may use, not the agent.
   - The model can be chosen per request: `POST /review` with `"model": "cheap"` (Haiku 4.5), `"expensive"`
     (Sonnet 4.5) or a full model id. Arm D ignores it, because the router decides. One Haiku run in 8 missed an
     order, so say "Haiku passed 7 of 8".
   - Revoke or rotate the gateway key (or use the Killswitch) and re-run: the agent stops, nothing to redeploy.

## Act 3: observability (10 min)

Slide: *One run, seen from both sides* (screenshots of the Astro trace and the Fabric view).

1. Run a live review (`live: true`) with the rows created in Postman (`D3`, `D4`, `D5`).
2. **Astro side:** the trace of the run: steps, tool calls, model calls.
3. **Fabric side:** the same run per route and key: calls, tokens, cost, status, latency.
4. **Flow side:** `fraud-alert` per flagged order, one `fraud-review-summary`.
   Run again and show the Idempotency-Key stops duplicate alerts.

> TODO: capture the real Fabric screens (what the dashboard and traces show per call) before the first customer run.

## Act 4: what comes next, token savings (5 to 10 min)

Slides: *Results*, *Next: plugins that save tokens*.

1. **Honest numbers** (same task, 13 orders, oracle-checked: the flagged set must equal the expected set):

   | Arm | Path | Model | Cost per review |
   |---|---|---|---|
   | A | Direct | Sonnet 4.5 | $0.082 |
   | F | Fabric, tools in the agent | Sonnet 4.5 | about the same tokens as A |
   | F-eco | Fabric `/anthropic-select` | Haiku 4.5 | about $0.027 (3 of 3 pass) |

   Fabric alone does not cut tokens. The saving is the model choice, and Fabric lets you enforce it.
2. **Coming up, each measured with the same oracle:**
   - Adaptive model router (`anthropic-adaptive` route): the plugin sends the request text to a decision service
     (Jev, pinned to `jev-1.13.0` with tuned thresholds) and maps the answer to a model. Tested 2026-10-20: "Say hi"
     and "2+2" go to Haiku 5.5, but our review prompt goes to Opus 5.5 even with no tool data (so it is the task,
     not the tool schemas: system messages and tool descriptions are off by default). Cost about 2x arm A if Opus 5.5
     is priced like Opus 4.5 (unverified). Open: do customers get a Jev key? Who tunes the thresholds?
   - MCP bridge and Tool Search: three meta-tools instead of 21 tool schemas. Not yet in production.
   - Per-key rate limits and budgets.
3. Close with the customer's own scenario: which agent, which keys, which models, which tools.

## Reset between runs

`D1. Orders - RESET` in Postman. Runs with `live: false` never call the webhook.

## Fallbacks

- Fabric slow or down: run arm A, which needs no gateway.
- Live LLM slow: show a saved result from `results/`.
- Webhook down: run with `live: false`; the findings are in the response.
