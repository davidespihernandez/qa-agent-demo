# Demo script: a governed fraud agent (about 50 minutes)

One agent, one story: **Fabric is the front door (keys, models, limits), Astro builds and runs the agent behind it, then we watch and control it.**
Fabric comes first because the agent on Astro already uses it: if we show Astro first, every call to the LLM and the APIs raises questions.
Token savings are the last act ("what comes next"), not the main claim.

The agent reviews orders from the Orders/Users/Payments APIs and reports suspicious ones
(over $10,000, unknown customer, 3 or more identical orders) to a Postman Flow webhook.

## Before you start

- Orders API reachable (`GET /health`), Flow webhook URL in `FRAUD_WEBHOOK_URL`, Fabric key in `.env`.
- Run `D1. Orders - RESET` in the Postman collection so the data is two clean orders.
- Have a recorded run and screenshots ready as a fallback (agent runs are non-deterministic).

## Intro: the scenario (2 min)

Slide: *What are we building?*. A test agent that detects fraud in an existing Orders API, following a few rules written
in a markdown file (`agent/agent/fraud-policy.md`: over $10,000, unknown customer, 3 or more identical orders). The rules
are only an example, open the file if asked. The agent needs an LLM key and API access: Fabric is how we give it those
safely, Astro is where it lives.

Slide: *System architecture*. The big picture before the details: Astro builds, runs and deploys the agent
(code, container, live endpoint, runtime traces). Fabric sits in front of everything the agent calls (one gateway key,
provider keys in a vault, routing, limits, PII masking, traces with tokens and cost). Behind Fabric: the LLMs and the
Orders, Users and Payments APIs (MCP tools next).

## Act 1: Fabric, the front door (15 to 20 min)

Slides: divider *Postman Fabric Gateway*, *Following one request through Fabric* (agent, route, plugin, service,
provider), *Before Fabric*, *With Fabric*, *Fabric features and plugins*.

1. **Concepts in 2 minutes** (while on *Following one request*): service (where traffic ends up), route (the address on the gateway),
   plugin (a rule on a route), credential (a secret in the vault).
2. **See Fabric on its own, with no agent.** Switch to the slide *Fabric features and plugins* (the table follows the
   numbering of the collection, with a Type column: Plugin or Feature), then run each request in Postman (Postman collection `Fabric features`; each request has a test, so the
   Collection Runner shows what Fabric did). Pick the ones the customer cares about:

   | Show | Request | What Fabric does |
   |---|---|---|
   | One way in | 1a-1d | valid key 200; no key and `Bearer` both 401 (LLM routes read `fg-api-key` only); the Orders API behind the same key |
   | Change the model for everyone | 2a-2b | the Transformer on `anthropic-economy` rewrites any requested model to Haiku 4.5, streaming too |
   | Model allowlist | 3a, 3b | `anthropic-select`: Haiku passes, Opus gets 400 |
   | Pick the model by prompt | 4a-4b | adaptive router: "Say hi" goes to Haiku, the review task to Opus |
   | Your own routing rules | 4c-4e | same plugin, but the decision comes from our own small service (`decision-service/`, on Astro): Haiku for "Say hi", Sonnet for the fraud review, Opus for an architecture design. Deterministic, you can change the rules |
   | Cost side by side | 5a-5c | same prompt on Sonnet and Haiku, Visualize shows the saving (about 67%) |
   | Request limit | 6a, 6b | `anthropic-ratelimit`: 1 request per minute per key, then 429 |
   | Token budget | 7a, 7b | `anthropic-tokenlimit`: 200 tokens per minute, then 429 "Token budget exhausted" |
   | Required header | 8a, 8b | `anthropic-validated`: no `X-Team` gets 422, with it 200 (chargeback by team) |
   | Redact PII | 9a, 9b | `anthropic-pii`: the model sees `[EMAIL]` and `[CREDIT_CARD]` instead of the real values |
   | Survive an outage | 10a, 10b | `anthropic-fallback`: the first provider (bad key) returns 401, the router moves to the second, the caller gets 200 |

   Tips: wait a minute between demos of 6 and 7 (rolling windows); send 6b by hand and repeat it until the 429 shows (the
   counter is not exact: 6a and 6b can both pass, the third call was the one refused); for PII, the model refuses to repeat card numbers, so
   9a/9b ask about the domain and the last four digits instead. Plugins can take seconds, sometimes minutes, to apply
   after saving. How each route is built: `docs/FABRIC-SETUP.md`, section 7b.
3. **Say it:** none of this needed an agent. Next we build one, and it will only hold a gateway key.

## Act 2: Astro, build and run the agent (15 min)

Slides: divider *Astro*, *Astro turns an agent into a service*, *Five layers*, *Anatomy of the agent*, *The agent plugs into any system through a webhook*, *What we set up in Fabric*.

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

5. **Connect it to Fabric.** (Slide: *What we set up in Fabric*.)
   **Simplified authentication.** Compare arm A and arm F (`POST /review`, `arm: "A"` then `"F"`):
   - A: the agent holds the Anthropic key and talks to every API itself.
   - F: the agent holds one gateway key. The Anthropic key lives in Fabric's vault, write-only.
   Show the credential page and the key-auth plugin on a route.
   **What we set up in the console** (same names as the slide):
   - `/agent`: our agent on Astro, so Postman calls it through Fabric.
   - `/api`: the Orders API, so the agent reads data through Fabric.
   - `/anthropic`: Anthropic, so the agent calls the LLM through Fabric.
   - `/anthropic-select`: Anthropic, but the service only allows Haiku 4.5 and Sonnet 4.5.
   **Control from Fabric, not from the agent.**
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
3. **Fabric side** (console, Analytics, window 1H). Two levels:
   - *Dashboard* (tabs Overview / MCP / LLM, filter by protocol): total requests, error rate, P95 latency, active
     consumers, traffic per minute by protocol (HTTP vs LLM), errors (4xx/5xx), P95 over time, top routes and top
     consumers. Our two runs (arm F and F-eco, 4 LLM calls each plus the API reads) showed 18 requests: `/api/*` 10,
     `anthropic-select` 4, `anthropic-route` 4, all from one consumer (the identity behind the gateway key).
   - *Trace of one call* (open a call from the list): spans `POST /anthropic/v1/messages` > `chat claude-sonnet-4-5`
     > `POST api.anthropic.com`, with `fabric.service.name`, `gen_ai.request.model` and `gen_ai.response.model`,
     input and output tokens (first call: 3,894 in, 60 out, 2.15 s), finish reason (`tool_use`), **estimated cost**
     ($0.013 for that call), and the full request (system prompt, user message, the 22 tools, tool choice) and response.
   - Where the tokens go (arm F run, 4 LLM calls, 20,493 in / 1,511 out): call 1 is only the system prompt plus the
     22 tool schemas (3,894 in, $0.013). Later calls resend the whole history, so call 3 (5,335 in, 1,057 out, 10.7 s,
     $0.032) carries the orders JSON and the four user lookups, and ends with 5 `report_fraud` calls. The estimate
     matches list price (Sonnet 4.5, $3 in / $15 out per million). This is the picture behind the token-saving next steps:
     Tool Search would shrink call 1, a cheaper model shrinks the price of all four.
   - *Traces list* (Traces, windows 24H to 90D): one row per call with protocol (LLM or HTTP), operation, route, service,
     user, status and duration, and filters for each. Our two runs side by side: arm F made 4 calls to
     `claude-sonnet-4-5` (2.15 s, 6.28 s, 10.71 s, 1.69 s, about 21 s total), arm F-eco made 4 calls to
     `claude-haiku-4-5` through `anthropic-select` (1.02 s, 2.06 s, 7.80 s, 0.83 s, about 12 s), and each run's API
     reads show as `GET /api/*`. The yellow 404s are the lookup of the unknown customer `usr-ghost`, which is the
     expected signal for the "unknown customer" rule. The 401 (no user) from the day before is a call without a key.
     The 24H error rate (19.8%) includes our earlier tests, so use the 1H window for a clean demo.
   - Point out: the same view for `/anthropic-select` shows Haiku, so the model difference is visible per call.
     Note for customers: traces include the prompt, so decide who can see them.
4. **Flow side** (or any system behind the webhook): `fraud-alert` per flagged order, one `fraud-review-summary`.
   Run again and show the Idempotency-Key stops duplicate alerts.

> TODO: screenshot of the Astro trace for a `POST /review` run (Traces & Evals, 7d). Each review is traced as `invoke_agent Fraud Agent` with latency and cost (a Haiku run showed $0.027, a Sonnet chat run $0.084); CLI: `ast agent trace --id <id>`. Usage & Cost fills in after a day or two.

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
   - Per-key rate limits and token budgets: already shown in the `Fabric features` collection (7 and 8); next is applying them per agent key.
3. Close with the customer's own scenario: which agent, which keys, which models, which tools.

## Reset between runs

`D1. Orders - RESET` in Postman. Runs with `live: false` never call the webhook. The rate-limit demos (7, 8) reset after a minute.

## Fallbacks

- Fabric slow or down: run arm A, which needs no gateway.
- Live LLM slow: show a saved result from `results/`.
- Webhook down: run with `live: false`; the findings are in the response.
