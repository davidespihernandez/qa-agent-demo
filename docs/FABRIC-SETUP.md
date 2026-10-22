# Fabric Gateway setup (by hand, there is no CLI or export/import)

Everything the demo needs in a Fabric tenant, with exact names and values. Follow it top to bottom on a fresh tenant
(the beta tenant was built this way). Names matter: the repo's `.env`, the Postman collection and the Astro inputs
refer to the URLs these names produce.

> **Beta vs production.** This guide started from the beta UI (tenant on `*.dp.fabricgateway-beta.ai`) and is being
> checked against production (`app.fabricgateway.ai`, sidebar: *Getting started, LLMs, MCP servers, Services, Plugins,
> Members, Credentials*). Each step says what was **verified in production** and what is still **beta-only**. Production
> docs show the key header as `X-Gateway-Key`; the repo is configurable (see step 9); in practice `fg-api-key` worked.
>
> Status legend: ✅ verified in production · 🟡 written from beta, not yet verified in production · ❌ known not to work (yet).

Legend: **bold** = a value you type or select. `code` = exact text.

---

## 0. Before you start (5 min)

1. Sign in to the tenant. Note the **data-plane host**, the hostname calls go to. Beta looked like
   `https://<tenant>.dp.fabricgateway-beta.ai`; production looks like `https://<subdomain>.fabricgateway.ai`.
   Call it `<HOST>` below.
2. **Check the host is public.** The beta host resolved to a private address (`100.72.x.x`, VPN only), which means
   an agent running on Astro could not reach it.
   ```bash
   dig +short <HOST-without-https>       # a public IP is good; 100.64-127.x.x / 10.x / 172.16-31.x is private
   curl -s -o /dev/null -w "%{http_code}\n" https://<HOST>/   # run it WITHOUT the VPN too; any HTTP code means reachable
   ```
3. Have these ready: your Anthropic API key, and the file `agent/agent/specs/demo-apis.json` from this repo.

---

## 1. Gateway key (the only secret the agent holds) ✅

Where (production): sidebar **Credentials → Create credential**. (Beta: Administration → Credentials.)

| Field | Value |
|---|---|
| Credential type | **Gateway credential** (the other type, *Service credential*, is for upstream secrets such as the Anthropic key) |
| Owner | **Myself** |
| Gateway key → Name | `demo-agent-key` |

Click **Create credential**. The key is minted by the server and **shown once**: copy it straight into `.env`
(`FABRIC_GATEWAY_KEY=`), never into chat or git.

Owner matters: a route only accepts keys of the owner selected on the route (wizard field *Credential owner*:
Org / tenant, a user, or a user group). One key owned by you worked as "the demo key" on beta. If a route answers 401
with a valid key, create another gateway credential with the owner the route expects.

---

## 2. LLM connection: Anthropic ✅

Where (production): **Getting started → Anthropic → Use integration** opens a **4-step wizard**
(*Create service → Set up credentials → Model filter → Route & gateway*). The service is pre-filled from the catalog
(Anthropic Messages API; auth is the `x-api-key` header plus a static `anthropic-version` header).

| Wizard step | Field | Value |
|---|---|---|
| 1 Create service | Service name | `anthropic` (default) |
| 2 Set up credentials | Anthropic API key | paste your key (stored in Fabric's vault, write-only) |
| 3 Model filter | | leave the default (all models) |
| 4 Route & gateway | Route setup | **Create new route** |
| 4 | Route name | `anthropic-route` |
| 4 | API compatibility class | **Anthropic Messages API** |
| 4 | **Route base path** | **`/anthropic`** (it is EMPTY by default; without it the endpoints are mounted at the root) |
| 4 | Endpoints to expose | keep all three ticked: `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` |
| 4 | Access mode | **Open** (this is a separate "needs a grant" feature, not authentication) |
| 4 | Create a gateway credential | **Unchecked** to reuse the key from step 1 (check it only if you want a new org-level key; it is shown once). Keep **Auth mode = Gateway key** |
| 4 | Credential owner | **Org / tenant** if the wizard creates the key; if you reuse your own key, pick yourself |

Resulting URLs: `https://<HOST>/anthropic/v1/messages` etc., which is `LLM_BASE_URL=https://<HOST>/anthropic`.

**The key header is `fg-api-key` on production too, for the LLM route as well** (verified). The production docs say
`X-Gateway-Key` and beta's LLM route used `Authorization: Bearer`; on the production tenant both of those, and `x-api-key`,
answer **401**, and only `fg-api-key` gets a 200. Test:
```bash
curl -s https://<HOST>/anthropic/v1/messages \
  -H "fg-api-key: $FABRIC_GATEWAY_KEY" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":20,"messages":[{"role":"user","content":"say hi"}]}'
```
Expected: a normal Anthropic response and a trace under **Observability → Traces** with tokens and an estimated cost.
A 401 usually means the wrong header name (try `fg-api-key`, `X-Gateway-Key`, `Authorization: Bearer`, one at a time) or a key
whose owner the route does not accept (see step 1). Reusing the step 1 key (owner *Myself*, wizard checkbox
"Create a gateway credential" unchecked) worked on production.

Optional plugin (Plugins → New instance): **Token Counter**: name `anthropic-token-counter`, plugin `token-counter`,
scope kind **service**, scope name `anthropic`, match conditions empty. 🟡

---

## 3. HTTP service: the Orders / Users / Payments APIs ✅

The three business APIs are one merged OpenAPI file with 21 operations.

Where: **Services → Add resource**, service type **HTTP**, then the **Import an OpenAPI spec** button under the description (a 3-step wizard; leave Name/Target URL empty).

| Step | Field | Value |
|---|---|---|
| 1 Provide spec | Spec | upload `agent/agent/specs/demo-apis.json` |
| 1 | Import mode | **Merge** |
| 1 Advanced | Import ID | `demo-apis` |
| 1 Advanced | Route prefix | leave empty |
| 1 Advanced | Upstream URL override | leave empty (the spec's `servers` already points at `https://18-157-170-15.nip.io`) |
| 2 Review plan | | it names the service to create. Rename it to `demo-apis-orders-users-payments` if it differs |
| 3 | Publish | |

**Then delete the auto-created REST routes.** The import creates one REST route per path with **no authentication**
(about 9 routes under Services → Routes, all belonging to `demo-apis-orders-users-payments`).
Delete them all; the MCP routes below do not need them. Do NOT delete the *service*, because it holds the imported spec.
(Deleting the service loses the spec and you have to import again.) Verify: `curl https://<HOST>/orders` should now be 404.

No credential is needed: the Orders API is public.

---

## 4. MCP route A: all tools (arm B) ❌ blocked

> **Blocked (2026-10-16):** the `mcp-http-bridge` plugin is not available in the production tenant yet. Bhargav (Fabric) is looking into it. Steps 4-6 depend on it.

### 4a. Route
Where: **Routes → Create route**.

| Field | Value |
|---|---|
| Name | `demo-apis-mcp` |
| Paths | `/mcp/demo-apis` (type a plain hyphen `-`, not a long dash) |
| Protocol | **MCP** |
| Services | `demo-apis-orders-users-payments` |
| Gateway auth | **Gateway key** (never leave "No gateway auth") |

### 4b. Bridge plugin (turns the OpenAPI spec into MCP tools)
Where: **Plugin instances → New plugin instance**.

| Field | Value |
|---|---|
| Name | `demo-apis-mcp-bridge` |
| Plugin | `mcp-http-bridge` |
| Scope kind / name | **route** / `demo-apis-mcp` |
| HTTP service | `demo-apis-orders-users-payments` |
| Operations | **all 21 selected** ("Tools 21 / 200") |

If it says "Could not compile tools": click **Recompile** (it is only timing). Three yellow `PATCH ... minProperties`
warnings are harmless. If Save says `name: Too small`, the Name field is empty.

Verify (expect 21 tools):
```bash
bun --env-file=.env scripts/mcp-probe.ts https://<HOST>/mcp/demo-apis
```

---

## 5. MCP route B-ro: read-only tools (arm B-ro) 🟡

Same as step 4, but only the 8 safe operations.

| Field | Value |
|---|---|
| Route name | `demo-apis-mcp-ro` |
| Path | `/mcp/demo-apis-ro` |
| Protocol / service / auth | **MCP** / `demo-apis-orders-users-payments` / **Gateway key** |
| Bridge name | `demo-apis-mcp-bridge-ro` |
| Bridge scope | route `demo-apis-mcp-ro` |
| Operations | click **Select read-only (GET/HEAD)** → **8 tools**: `getHealth`, `getOpenApi`, `listOrders`, `getOrder`, `listPayments`, `getPayment`, `listUsers`, `getUser` |

Verify: `bun --env-file=.env scripts/mcp-probe.ts https://<HOST>/mcp/demo-apis-ro` shows 8 tools.

---

## 6. MCP route C: Tool Search (arm C) 🟡

Keep this on its **own route**, never on route A: Tool Search replaces the tool list with 3 meta-tools and would break arm B.

| Field | Value |
|---|---|
| Route name | `demo-apis-mcp-search` |
| Path | `/mcp/demo-apis-search` |
| Protocol / service / auth | **MCP** / `demo-apis-orders-users-payments` / **Gateway key** |
| Bridge name | `demo-apis-search-bridge`, scope route `demo-apis-mcp-search`, **all 21** operations |

**Tool Search instance** (Plugin instances → New): name `demo-apis-search`, plugin `tool-search`,
scope kind **route**, scope name `demo-apis-mcp-search` (the default is *global*: change it).

| Embedder field | Value |
|---|---|
| Model identifier | `BAAI/bge-small-en-v1.5` |
| Per-request timeout | `60s` |
| Base URL | the tenant's in-house embedder, **ask the Fabric team** (beta: `http://fabric-gateway-embedder.pm-fabric-dp-postman.svc.cluster.local/v1`). No trailing slash and no `/embeddings` |
| Provider | `openai` |
| Vector dimension | `384` |
| API key reference | empty |
| Cold-start timeout | `60s` |

Do not use OpenAI (no credits) or a Gemini route on the same tenant: the plugin could not call it in beta.

Verify (expect 3 meta-tools and a non-empty result list):
```bash
bun --env-file=.env scripts/mcp-probe.ts https://<HOST>/mcp/demo-apis-search "list all orders"
```
❌ **Beta status:** the in-house embedder answered (no more `embedder unavailable`), but the catalog came back empty
(`"results":[]`) and `get_tool listOrders` said "tool not found", so the bridge's tools were not indexed. Ask the Fabric team
whether Tool Search indexes tools generated by the `mcp-http-bridge` plugin on the same route, or only upstream MCP servers.
Until that works, arm C cannot be measured. The OpenAI embedder (no credits) and a Gemini route on the same tenant
both failed on beta (the plugin never called them).

---

## 7. (Optional) Expose the deployed agent through Fabric ✅

So Postman calls Fabric with only the gateway key, and Fabric adds the agent's own key.

**Service** (Services → Create connection, type **HTTP**):

| Field | Value |
|---|---|
| Name | `fraud-agent-astro` |
| Target URL | the agent's public URL from `ast agent get --name fraud-agent` (the `frontend` one, host ends in `agents.public.astropods.ai`) |
| Upstream auth | **API key in header** (or Custom header), header name `x-demo-key`, value = `DEMO_API_KEY` from `.env` |

**Route**:

| Field | Value |
|---|---|
| Name | `fraud-agent` |
| Protocol | **HTTP** |
| Paths | `/agent/*` |
| Service | `fraud-agent-astro` |
| Gateway auth | **Gateway key** |

Note: reviews take 20-60 s, so use the async API (`POST /agent/review` returns a run id; poll `GET /agent/runs/{id}`).

---

## 8. Optional governance extras (for the talk track) 🟡

Add in Plugin instances; not needed for the token comparison.

| Plugin | Scope | Why |
|---|---|---|
| `llm-rate-limit` | route `anthropic-route` | cap tokens per minute per key |
| `agent-scope-gate` | route `demo-apis-mcp` | allow only the read-only tools, block writes at the gateway |
| `adaptive-model-router` | route `anthropic-route` | arm D. Set up on route `anthropic-adaptive`: service `anthropic`, decision service `jev` (a Fabric service whose upstream is the Jev endpoint, API key in the vault), Jev model `jev-1.13.0`, max input 32000 chars; system messages, tool descriptions and session stickiness off. Customers need their own Jev key (availability to customers unconfirmed) |

---

## 8b. Feature routes for the `Fabric features` collection ✅

Each route has base path `/<route name>`, API class Anthropic Messages API, endpoints `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, gateway key `fg-api-key`. Use **Routes > New route** (the Anthropic wizard also creates a service and a credential, which you only want for a new service). Scope every plugin to its **route**: the form preselects `anthropic-route`, the main route, so change it before saving.

| Route | Service | Plugin (name) and config | Collection requests |
|---|---|---|---|
| `anthropic-economy` | `anthropic` | `transformer`: body_set `model` = `claude-haiku-4-5-20251001`. **Match conditions: path prefix `/anthropic-economy/v1/messages`, method POST.** Without them the plugin ran on body-less GETs and `/v1/models` returned 502 | 2a-2c, 5b |
| `anthropic-select` | `anthropic-select` (model allowlist: Haiku 4.5, Sonnet 4.5) | none | 3a, 3b |
| `anthropic-adaptive` | `anthropic` | `adaptive-model-router`, see section 8 | 4a-4c |
| `anthropic-ratelimit` | `anthropic` | `rate-limit`: count by Consumer, limit 1, window 60 s | 7a, 7b |
| `anthropic-tokenlimit` | `anthropic` | `llm-rate-limit`: max tokens 200, window 60 s | 8a, 8b |
| `anthropic-validated` | `anthropic` | `validator` (`require-team-header`): enforce on, deny status 422, rule Request / Header `X-Team` / exists, match POST on `/anthropic-validated/v1/messages` | 9a, 9b |
| `anthropic-pii` | `anthropic` | `pii-redaction`: redact on, default action Mask (email, card, SSN, AWS key; phone and IP stay off, they match order ids) | 10a, 10b |
| `anthropic-broken` | `anthropic-broken` (copy of `anthropic` with the credential `sk-ant-invalid`) | none | 11a |
| `anthropic-fallback` | `anthropic` and `anthropic-broken` both attached to the route | `llm-router` (`anthropic-fallback`): mode fallback, targets `anthropic-broken` then `anthropic`, no retries, on status codes `401, 429, 503` | 11b |

Seen while building them: plugins can take seconds, once about ten minutes, to apply after saving (a 502 or 404 right after a save is not necessarily a bug); the `llm-router` target dropdown lists only the services attached to the route; the rate-limit counter is not instant; the validator's 422 body is `{"error":"validation_failed"}` without the custom message. Collection check: `postman collection run "postman/collections/Fabric features" -e <env with fabricKey>`.
Other plugins in the catalog, not used yet: `token-counter`, `agent-audit`, `access-log` (global, observational), and `llm-router` modes loadbalance and lightyear.

---

## 9. Point the repo at the new tenant

Edit `.env` (git-ignored):

```
LLM_BASE_URL=https://<HOST>/anthropic
MCP_URL=https://<HOST>/mcp/demo-apis
MCP_URL_READONLY=https://<HOST>/mcp/demo-apis-ro
MCP_URL_SEARCH=https://<HOST>/mcp/demo-apis-search
FABRIC_GATEWAY_KEY=<key from step 1>
# Header that carries the gateway key. Production (verified) accepts fg-api-key on every route, LLM included.
# Beta used Authorization: Bearer on the LLM route (leave FABRIC_LLM_KEY_HEADER empty for that).
FABRIC_KEY_HEADER=fg-api-key           # HTTP and MCP routes
FABRIC_LLM_KEY_HEADER=fg-api-key       # LLM route
```

Then, in this order:
```bash
bun --env-file=.env scripts/mcp-probe.ts "$MCP_URL"              # 21 tools
bun --env-file=.env scripts/mcp-probe.ts "$MCP_URL_READONLY"     # 8 tools
bun harness/run.ts --arm A  --runs 1                             # direct baseline
bun harness/run.ts --arm B  --runs 1                             # through Fabric
bun harness/run.ts --arm B-ro --runs 1
```
**Re-snapshot the tool list only if the spec changed**, and only against route A (never the Tool Search route):
`bun --env-file=.env scripts/dump-bridge-tools.ts` overwrites `agent/agent/specs/bridge-tools.json`, which arm A uses.

Astro (re-run after changing values): update the vault entries and redeploy.
```bash
ast secrets update FABRIC_GATEWAY_KEY ; ast secrets update LLM_BASE_URL ; ast secrets update MCP_URL
ast agent redeploy --name fraud-agent
```
Then on the deployed agent: `GET /diag` (header `x-demo-key`) must show the Fabric MCP and LLM hops answering, not timing out.
Add `MCP_URL_READONLY` / `MCP_URL_SEARCH` (and `FABRIC_KEY_HEADER` if needed) in the agent's Configure page.

---

## 10. Astro side (agent deployment), what we learned

Not Fabric, but it decides whether the Fabric arms can run from the deployed agent. Account: `ast whoami` must show
`davidespi` (personal), never the `postman` org.

```bash
cd agent
ast blueprint push fraud-agent                                  # private blueprint, new build id each push
ast secrets import --file <a file with only the keys you need>  # then delete that file
ast blueprint deploy fraud-agent --adapter web \
  --var ANTHROPIC_API_KEY=@ --var FABRIC_GATEWAY_KEY=@ --var LLM_BASE_URL=@ --var MCP_URL=@ \
  --var FRAUD_WEBHOOK_URL=@ --var DEMO_API_KEY=@ --wait
ast agent redeploy --name fraud-agent --build <build id> --wait  # after every push
ast agent logs --name fraud-agent ; ast agent network --name fraud-agent
```

- **Public HTTP API:** the agent's HTTP surface is the *frontend* interface. In the Astro dashboard open the agent →
  **Configure → Access → Custom app → Public**, then **redeploy**. Only then does the host change to
  `<agent>.agents.public.astropods.ai` and answer without the Astro login (OIDC). The chat (Web chat) stays "Invited only".
  Protect `POST /review` with `x-demo-key` (`DEMO_API_KEY`).
- **15 s edge timeout:** Astro's public edge answers 504 after about 15 s, so `POST /review` is asynchronous (202 + run id,
  then `GET /runs/{id}`). Use the same shape through Fabric.
- **Pin dependencies:** the image must use `bun.lock` (it does); a fresh install pulled a newer MCP client.
- **Network check:** `GET <agent url>/diag` (header `x-demo-key`) times each hop from inside Astro: the Orders API,
  Fabric MCP, Fabric LLM and Anthropic. On the beta tenant Fabric timed out (the host resolves to a private `100.72.x.x` address,
  VPN only), so only arm A could run on Astro. **On production this must show Fabric answering**; if not, the Fabric
  arms can only run from a laptop on the network that can reach Fabric.
- **Startup safety:** if the gateway is unreachable at boot, the chat agent falls back to the direct arm instead of crashing.

---

## Gotchas learned the hard way

- **Spec import creates open routes.** Delete the REST routes it makes (step 3), keep the service.
- **Never delete the service** that holds the spec; re-import if you did.
- **Service credentials are tied to one auth type.** Changing the auth type creates a new requirement that needs a new credential.
- **Tool Search lives on its own route.** On the shared route it hides all 21 tools.
- **Gateway auth: Gateway key** on every route. "No gateway auth" makes the route public.
- **Header names differ**: beta LLM route `Authorization: Bearer`; production accepts `fg-api-key` everywhere (the production docs' `X-Gateway-Key` returned 401). The Anthropic route also needs the client to send `anthropic-version`.
- **A private data-plane host cannot be reached from Astro.** Check step 0 first.
- **Anthropic wizard: set the Route base path to `/anthropic`.** It is empty by default.
- **Gateway key owner:** a route accepts only keys of its selected owner (Org / tenant, user, group).
- **Newer MCP clients send a version-negotiation probe** (3 s timeout) that failed against the beta MCP route from Astro; locally it works. Keep `bun.lock` pinned.

## Final checklist

- [x] Production host is public (step 0): resolves to Cloudflare addresses, reachable without VPN
- [ ] Gateway key `demo-agent-key` created and saved in `.env`
- [x] `anthropic` service + `anthropic-route`, test call returns 200 (header `fg-api-key`); check the trace in the UI
- [ ] Service `demo-apis-orders-users-payments` with spec imported, 9 open REST routes deleted
- [ ] Route + bridge `demo-apis-mcp` (21 tools)
- [ ] Route + bridge `demo-apis-mcp-ro` (8 tools)
- [ ] Route + bridge + tool-search `demo-apis-mcp-search` (3 meta-tools, search returns results)
- [ ] `.env` updated, `mcp-probe` and `harness/run.ts` pass for A, B, B-ro
- [ ] Astro secrets updated, redeployed, `/diag` shows Fabric reachable
- [ ] (optional) `fraud-agent` service + route, Postman collection works through Fabric
- [ ] Astro agent deployed, Custom app = Public, `/diag` shows Fabric reachable (section 10)


## Verified 2026-10-16: Astro reaches production Fabric

With production values in the Astro vault (`ast secrets import --overwrite`, then `ast blueprint push`, then `ast agent redeploy --latest --var KEY=@ ...`), `GET <public url>/diag` shows the Fabric MCP route answering `initialize` with 200 in about 150 ms and the LLM route 401 without a key (reachable). The beta data plane was unreachable from Astro; production is fine. Until `mcp-http-bridge` is available, the MCP route lists 0 tools, so arm B cannot run yet.

## Verified 2026-10-16: agent exposed through Fabric

Service `fraud-agent-astro` (HTTP, target = the agent's `agents.public.astropods.ai` URL, upstream auth type **API key header**, header name `x-demo-key`, applies to Org/tenant). The service form only takes the header NAME; the value is a separate upstream credential under **Credentials**. Route `fraud-agent`: protocol HTTP, path match **Prefix** `/agent`, path the service receives **Remove the matched prefix** (the agent serves `/health`, `/review` at its root), gateway auth Gateway key. Result: `GET /agent/health` and `/agent/arms` return 200 with only `fg-api-key`, 401 without it, and `/agent/diag` works without sending `x-demo-key` (Fabric injects it).

## Verified 2026-10-16: Orders/Users/Payments REST through Fabric

Route `demo-apis-rest`: protocol HTTP, path match **Prefix** `/api`, path the service receives **Remove the matched prefix**, service `demo-apis-orders-users-payments`, gateway auth **Gateway key**. `GET /api/orders` returns the orders with `fg-api-key`, 401 without. The Postman collection's `ordersUrl` points here (with `fabricKey`); the oracle and arm A keep using the direct URL on purpose.
