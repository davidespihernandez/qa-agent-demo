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

Deploy:

```bash
ast blueprint push -y        # build and register the image (prints the tag)
# values live in the account vault (ast secrets create NAME --value ...); the redeploy must name them:
V=(); for n in LLM_BASE_URL LLM_BASE_URL_ECONOMY LLM_BASE_URL_ADAPTIVE FABRIC_API_URL FABRIC_KEY_HEADER FABRIC_LLM_KEY_HEADER FABRIC_GATEWAY_KEY DEMO_API_KEY FRAUD_WEBHOOK_URL; do V+=(--var "$n=@"); done
ast agent redeploy --id <deployment id from 'ast agent list'> --latest "${V[@]}"
```

A redeploy without `--var` did not pass the new vault values to the container (arms F and F-eco answered "needs FABRIC_API_URL...").
