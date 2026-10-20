# fraud-agent

A Mastra agent, packaged for Astro, that reviews orders against `agent/fraud-policy.md` and reports suspicious ones.

## Quick start

```bash
bun install
ast dev          # playground on localhost:3100, HTTP API on :8787
```

## Project structure

```
agent/
├── index.ts          # Astro entry point (Mastra + observability)
├── fraud-agent.ts    # brain (model), hands (tools), instructions
├── fraud-policy.md   # the policy, plain English
├── review.ts         # arms (A, F, F-eco, D, ...), runs one review, cost
├── oracle.ts         # checks the flagged set against the data
├── server.ts         # POST /review, GET /runs/{id}, GET /arms
└── specs/            # OpenAPI spec and tool snapshot
astropods.yml         # agent spec: model, inputs, interfaces
Dockerfile
```

## Configuration

Set in `astropods.yml` inputs (secrets in the Astro vault): `LLM_BASE_URL`, `FABRIC_GATEWAY_KEY`, `FABRIC_API_URL`, `FRAUD_WEBHOOK_URL`, `DEMO_API_KEY`. With none of them set the agent runs direct (arm A).

Deploy: `ast blueprint push`.
