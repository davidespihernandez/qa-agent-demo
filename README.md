# fraud-agent demo (Astro + Fabric Gateway)

A fraud-investigation agent that reviews orders and reports suspicious ones to a Postman Flow, used to demo two Postman products working together:

- **Astro** (Astropods): build, run, deploy and observe the agent.
- **Fabric Gateway**: one governed entry point for the agent's LLM calls, APIs and MCP tools: authentication, model control, observability and token savings.

This repository has everything to reproduce the demo: the agent code, the Postman collections, the small services that run on Astro, the step-by-step Fabric configuration and the scripts to measure the cost of each setup.

## Where to start

| I want to... | Go to |
|---|---|
| Run the demo myself, from zero | [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) |
| Configure Fabric (connections, routes, plugins), step by step | [docs/FABRIC-SETUP.md](docs/FABRIC-SETUP.md) |
| Use the Postman collections | [docs/GETTING-STARTED.md#using-the-postman-collections](docs/GETTING-STARTED.md#using-the-postman-collections) |
| Understand the adaptive router's decision service | [decision-service/README.md](decision-service/README.md) |
| Measure Lightyear's token savings on coding agents | [lightyear-bench](https://github.com/davidespihernandez/lightyear-bench) (separate repo) |

## What is in this repository

| Path | What it contains |
|---|---|
| [`postman/collections/Fabric features/`](postman/collections) | Postman collection with 31 requests that show Fabric on its own (no agent): one entry point and one gateway key, Transformer plugin, model allowlist, adaptive router (Jev and our own decision service), cost side by side, traces, rate and token limits, validator, PII redaction, fallback, and Tool Search on an MCP server. Each request has a test. |
| [`postman/collections/Fraud agent - arms/`](postman/collections) | Postman collection with 16 requests that run the same fraud review through each arm (see below), reset the demo data, and a Compare request with a visualization of the cost of each arm. |
| `postman/environments/`, `postman/globals/` | The Postman environment and globals the collections use. They point at the author's tenant; see the guide to override them. |
| `postman/build-*.ts` | Scripts that generate the collections. The committed collections come from Postman's Git sync, so regenerating them overwrites that state. |
| [`agent/`](agent/README.md) | The fraud agent (Mastra, TypeScript, Bun), its HTTP API (`POST /review`, `GET /runs/{id}`, `GET /arms`), the plain-English fraud policy, the oracle that checks the result, and the Astro blueprint (`astropods.yml`). |
| [`mcp-server/`](mcp-server) | A small MCP server (Bun, runs on Astro) that turns the Orders, Users and Payments APIs into 21 MCP tools (`/mcp`) or the 8 read-only ones (`/mcp/readonly`). It stands in for the `mcp-http-bridge` plugin. |
| [`decision-service/`](decision-service/README.md) | A small deterministic HTTP service (Bun, runs on Astro) that answers the adaptive router's questions with plain rules instead of Jev. |
| `harness/` | Runs one or more arms from the command line and scores them: `bun harness/run.ts --arm F-eco --runs 3`, and `compare.ts` to compare results. |
| `scripts/` | `seed.ts` (create the labeled demo orders), `mcp-probe.ts` (check an MCP route), `dump-bridge-tools.ts` (dump the tools the bridge exposes). |
| [`docs/`](docs) | `GETTING-STARTED.md`, `FABRIC-SETUP.md`, `webhook-contract.md` (the fraud alert the agent sends), `PLAN.md` (the original plan, kept for history). |
| `results/` | Where the harness writes its runs (not committed). |

The Orders, Users and Payments APIs the agent reviews are a fake, in-memory test API (shared, with a default URL in `agent/agent/specs/demo-apis.json`).

## The idea

```
Postman / chat ──▶ [ fraud agent on Astro ] ── traces ──▶ Astro
                        │ LLM calls        │ API calls
                        ▼                  ▼
                 Fabric Gateway (one gateway key, model rules, per-call traces)
                        │                  │
                    Anthropic         Orders / Users / Payments APIs
                        │
                 report_fraud ──▶ Postman Flow webhook
```

The policy is plain English (`agent/agent/fraud-policy.md`): flag orders over $10,000, unknown customers, and 3 or more identical orders.

## Arms (same agent, only the path changes)

| Arm | Path | Notes |
|---|---|---|
| A | Direct to Anthropic and the APIs | baseline, the agent holds every key |
| F | Fabric `/anthropic` and `/api` | one gateway key, tools stay in the agent |
| F-eco | Fabric `/anthropic-select` | service only allows Haiku 4.5 and Sonnet 4.5; agent asks for Haiku |
| D | Fabric `/anthropic-adaptive` | adaptive router (decision service Jev); picks Haiku for trivial prompts, Opus 5.5 for our review task |
| B-ro | Fabric MCP route with only the 8 read-only tools | same as B, fewer tools |
| B | Fabric MCP route `/mcp/orders-all` (our own MCP server, 21 tools, plus GitHub MCP, 46 tools) | all 67 tool definitions go to the model on every step |
| C | Same 67 tools behind Tool Search (`/mcp/orders-all-search`) | the model sees 3 tools and searches for the rest |
| D2 | Fabric `/anthropic-adaptive-rules` | adaptive router with our own decision service |

The Postman collection `Fraud agent - arms` compares them in two scenarios, each sorted from the most to the least expensive arm: (1) same 21 tools, A vs F vs F-eco vs F with model "cheap"; (2) a 67-tool catalog, B vs C. Send requests 1 to 6, then 7 (Compare) and open Visualize.

Every run is checked by an oracle: the agent passes only if the set of flagged orders equals the set computed from the data.

## Run it

Short version (local, arm A, only an Anthropic key):

```bash
cp .env.example .env     # fill in ANTHROPIC_API_KEY; never commit .env
cd agent && bun install && cd ..
ast dev                   # local playground and POST /review (needs the Astro CLI)
bun harness/run.ts --arm A --runs 3      # from the repo root
```

For the Fabric arms, the Fabric features collection and the Astro deployment, follow [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## License

MIT
