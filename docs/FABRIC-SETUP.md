# Fabric Gateway setup (by hand, there is no CLI or export/import)

Everything the demo needs in a Fabric tenant, with exact names and values. Follow it top to bottom on a fresh tenant
(the beta tenant was built this way). Names matter: the repo's `.env`, the Postman collection and the Astro inputs
refer to the URLs these names produce.

> **Beta vs production.** This guide was written from the beta UI. Production labels and menus can differ
> (the production docs call the sidebar items *LLMs*, *MCP servers*, *Services*, and show the key header as
> `X-Gateway-Key`). If a field is not where this says, look for the same word elsewhere. Where production behaves
> differently, the repo is configurable (see step 9).

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

## 1. Gateway key (the only secret the agent holds)

Where: **Gateway keys** (or *Administration → Gateway keys / API keys*).

| Field | Value |
|---|---|
| Name | `demo-agent-key` |
| Scope / routes | all routes (or at least the ones created below) |

Copy the key once. It goes in `.env` as `FABRIC_GATEWAY_KEY` and in the Astro vault.

---

## 2. LLM connection: Anthropic

Where: **LLMs** (beta: **Services → Create connection**, type **LLM**). Pick **Anthropic** from the provider catalog
(*Use integration*), which pre-fills the target URL and auth type.

| Field | Value |
|---|---|
| Provider / service name | `anthropic` |
| Target URL | `https://api.anthropic.com` (pre-filled) |
| Upstream auth requirement | the one the template pre-selects; **Applies to: Org/tenant** |
| Credential | paste your **Anthropic API key** (stored in Fabric's vault, write-only) |

**Route** (LLMs → Routes, or the route created for you):

| Field | Value |
|---|---|
| Name | `anthropic-route` |
| Protocol | **LLM** |
| Paths | the catalog paths, `/anthropic/v1/messages`, `/anthropic/v1/messages/count_tokens`, `/anthropic/v1/models` |
| Service | `anthropic` |
| Gateway auth | **Gateway key** |

Test (replace the key header if production uses `X-Gateway-Key`):
```bash
curl -s https://<HOST>/anthropic/v1/messages \
  -H "Authorization: Bearer $FABRIC_GATEWAY_KEY" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":20,"messages":[{"role":"user","content":"say hi"}]}'
```
Expected: a normal Anthropic response, and a trace in **Observability → Traces** with tokens and an estimated cost.

Optional plugin (Plugin instances → New): **Token Counter**: name `anthropic-token-counter`,
plugin `token-counter`, scope kind **service**, scope name `anthropic`, match conditions empty.

---

## 3. HTTP service: the Orders / Users / Payments APIs

The three business APIs are one merged OpenAPI file with 21 operations.

Where: **Services → Import an OpenAPI spec** (a 3-step wizard; in beta it is a global action, reachable from the banner
inside the *mcp-http-bridge* plugin form or from the Services page).

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

## 4. MCP route A: all tools (arm B)

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

## 5. MCP route B-ro: read-only tools (arm B-ro)

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

## 6. MCP route C: Tool Search (arm C)

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
Beta status when this was written: the embedder answered, but the catalog came back empty (`"results":[]`) and
`get_tool listOrders` said "tool not found". Check with the Fabric team whether the bridge's tools are indexed.

---

## 7. (Optional) Expose the deployed agent through Fabric

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

## 8. Optional governance extras (for the talk track)

Add in Plugin instances; not needed for the token comparison.

| Plugin | Scope | Why |
|---|---|---|
| `llm-rate-limit` | route `anthropic-route` | cap tokens per minute per key |
| `agent-scope-gate` | route `demo-apis-mcp` | allow only the read-only tools, block writes at the gateway |
| `adaptive-model-router` | route `anthropic-route` | arm D (needs a Jev decision service and key; not set up yet) |

---

## 9. Point the repo at the new tenant

Edit `.env` (git-ignored):

```
LLM_BASE_URL=https://<HOST>/anthropic
MCP_URL=https://<HOST>/mcp/demo-apis
MCP_URL_READONLY=https://<HOST>/mcp/demo-apis-ro
MCP_URL_SEARCH=https://<HOST>/mcp/demo-apis-search
FABRIC_GATEWAY_KEY=<key from step 1>
# Production docs show the header as X-Gateway-Key. If the beta defaults do not work, set:
FABRIC_KEY_HEADER=X-Gateway-Key        # HTTP and MCP routes (default fg-api-key)
FABRIC_LLM_KEY_HEADER=X-Gateway-Key    # LLM route (default is Authorization: Bearer)
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

## Gotchas learned the hard way

- **Spec import creates open routes.** Delete the REST routes it makes (step 3), keep the service.
- **Never delete the service** that holds the spec; re-import if you did.
- **Service credentials are tied to one auth type.** Changing the auth type creates a new requirement that needs a new credential.
- **Tool Search lives on its own route.** On the shared route it hides all 21 tools.
- **Gateway auth: Gateway key** on every route. "No gateway auth" makes the route public.
- **Header names differ**: LLM route `Authorization: Bearer` (beta) vs `X-Gateway-Key` (production docs); HTTP/MCP routes `fg-api-key` (beta) vs `X-Gateway-Key`. The anthropic route also needs the client to send `anthropic-version`.
- **A private data-plane host cannot be reached from Astro.** Check step 0 first.

## Final checklist

- [ ] Gateway key `demo-agent-key` created and saved
- [ ] `anthropic` service + `anthropic-route`, test call returns 200 and shows a trace
- [ ] Service `demo-apis-orders-users-payments` with spec imported, 9 open REST routes deleted
- [ ] Route + bridge `demo-apis-mcp` (21 tools)
- [ ] Route + bridge `demo-apis-mcp-ro` (8 tools)
- [ ] Route + bridge + tool-search `demo-apis-mcp-search` (3 meta-tools, search returns results)
- [ ] `.env` updated, `mcp-probe` and `harness/run.ts` pass for A, B, B-ro
- [ ] Astro secrets updated, redeployed, `/diag` shows Fabric reachable
- [ ] (optional) `fraud-agent` service + route, Postman collection works through Fabric
