# fraud-agent demo (Astro + Fabric Gateway)

A fraud-investigation agent that reviews orders and reports suspicious ones to a Postman Flow. Built to demo:

- **Astro** (Astropods): build, run, deploy and observe the agent.
- **Fabric Gateway**: one governed entry point for the agent's LLM and API calls (simple authentication, model control, observability).

> Status: the demo covers build (Astro), gateway (Fabric) and observability. Token-saving plugins (adaptive router, Tool Search) are measured as "next steps". See [DEMO.md](DEMO.md) for the talk track and [docs/FABRIC-SETUP.md](docs/FABRIC-SETUP.md) for the Fabric configuration.

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
| B, B-ro, C | Fabric MCP route (all / read-only / Tool Search) | blocked until `mcp-http-bridge` exists in production |

Every run is checked by an oracle: the agent passes only if the set of flagged orders equals the set computed from the data.

## Layout

| Path | What |
|---|---|
| `agent/` | the agent (Mastra), its HTTP API (`POST /review`) and `astropods.yml` |
| `harness/` | runs one or more arms: `bun harness/run.ts --arm F-eco --runs 3` |
| `postman/` | two collections: `Fraud agent - arms` (every arm, data-reset requests, the Flow webhook; built by `build-collection.ts`) and `Fabric features` (26 requests that show Fabric on its own: auth, Transformer, allowlist, adaptive router, cost, traces, rate limits, validator, PII, fallback; built by `build-fabric-collection.ts`) |
| `scripts/` | seed data, tool dump, MCP probe |
| `docs/` | Fabric setup guide, webhook contract, plan |
| `results/` | saved harness runs |

## Run it

```bash
cp .env.example .env     # fill in keys; never commit .env
cd agent && bun install
ast dev                   # local playground and POST /review
bun harness/run.ts --arm A --runs 3      # from the repo root
```

## License

MIT
