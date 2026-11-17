# Getting started

How to run this demo yourself, from zero. Pick the level you need; each one builds on the previous.

> Honest status: the steps below come from how the demo was built and are written for someone else to follow, but they have not yet been walked through from a clean clone by a second person. If a step does not work, tell the author or fix the doc.

| Level | What you get | Needs | Time |
|---|---|---|---|
| 1. Fabric features | The `Fabric features` Postman collection: one entry point, model control, adaptive router, PII redaction, rate limits, fallback, traces | A Fabric tenant and an Anthropic key | 1 to 2 h (routes are created by hand) |
| 2. Agent, local | The fraud agent on your machine, arm A (direct) and the harness | Bun and an Anthropic key | 15 min |
| 3. Agent through Fabric and on Astro | Arms F, F-eco, D, B, C, and the agent deployed on Astro | Levels 1 and 2, the `ast` CLI and Astro access | half a day |

You can stop after any level.

## What you need

- **Bun** ([bun.sh](https://bun.sh)).
- An **Anthropic API key** (the gateway holds it; the agent only needs it for arm A).
- A **Fabric Gateway tenant** with permission to create connections, routes and plugins. Fabric has no CLI or import/export: the setup is done by hand in the console, following [FABRIC-SETUP.md](FABRIC-SETUP.md).
- The **Postman app or CLI** to run the collections.
- For level 3: the **Astro CLI** (`ast`) and access to an Astro organization. The demo was built in the shared Astro Corp org; use yours.

## Level 1: Fabric features

1. Create your Fabric tenant resources: [FABRIC-SETUP.md](FABRIC-SETUP.md), sections 0 to 3 (host, gateway key, the `anthropic` connection and route). Test with a `GET <HOST>/anthropic/v1/models` call and the `fg-api-key` header. A 200 means the gateway works.
2. Create the feature routes and plugins listed in section 7b (economy, allowlist, adaptive, rate limit, validator, PII, fallback...). Create only the ones you want to show; each row says which request of the collection uses it.
3. Bring the collection into Postman: the v3 YAML collections are in `postman/collections/`. Open the folder as a Postman workspace linked to Git, or import it.
4. Create a Postman **environment** with your values. The collections point at the author's tenant by default, so override these:

   | Variable | Value |
   |---|---|
   | `fabricUrl` (collection `Fabric features`) | `https://<your-tenant>.dp.fabricgateway.ai` |
   | `baseUrl` and `ordersUrl` (collection `Fraud agent - arms`) | `https://<your-tenant>.dp.fabricgateway.ai/agent` and `https://<your-tenant>.dp.fabricgateway.ai/api` |
   | `fabricKey` | your gateway key (mark it secret) |

   Keep the key out of the collection files.
5. Run the `Fabric features` collection in order. Each request has a test, so the Collection Runner shows what Fabric did. Open **Traces** in the Fabric console to see each call.

The adaptive router can use a decision service of your own: see [decision-service/README.md](../decision-service/README.md) and section 8c of FABRIC-SETUP.

## Level 2: the agent, local

```bash
cp .env.example .env          # fill in ANTHROPIC_API_KEY; never commit .env
cd agent && bun install && cd ..
ast dev                       # local playground and POST /review (needs the Astro CLI)
bun harness/run.ts --arm A --runs 3     # from the repo root
```

- Arm A goes direct to Anthropic and to the Orders, Users and Payments demo API. `API_BASE_URL` empty means the default demo API in `agent/agent/specs/demo-apis.json`. It is hosted by the author and could change. If you need your own, point `API_BASE_URL` at one.
- `bun scripts/seed.ts` prints a plan; `--yes` creates the labeled orders the policy expects. It writes to the Orders API.
- The harness never calls the Flow webhook unless you pass `--live`.
- A run passes when the agent flags exactly the orders the policy says are fraud (`agent/agent/oracle.ts`).

## Level 3: through Fabric and on Astro

1. Do the rest of [FABRIC-SETUP.md](FABRIC-SETUP.md): the HTTP service and route for the demo APIs (section 3), the MCP routes you want (4 to 6, and 8d/8e if you use our own MCP server), and the adaptive router (8, 8c).
2. Point the repo at your tenant: section 9 (`.env`: `LLM_BASE_URL`, `MCP_URL`, `FABRIC_GATEWAY_KEY`, the header names...). Check each arm: `bun harness/run.ts --arm F --runs 3`, then `F-eco`, `D`, `B`, `C`.
3. Deploy to Astro: section 10. Before you deploy, **rename the blueprints**: `name:` in `agent/astropods.yml`, `mcp-server/astropods.yml` and `decision-service/astropods.yml` is `david-espi-...`; use your own names, and your own organization (`ast account switch <org>`).
4. Run the `Fraud agent - arms` collection: requests 1 to 7, then 8 (Compare) and its Visualize tab.

Arms and their status (the legend in FABRIC-SETUP.md marks what was verified in production): A direct, F through Fabric, F-eco economy route, D adaptive router, B all 67 tools, C Tool Search. DEMO.md has the 50-minute talk track.

## Things tied to the author's setup

- Collections and environments committed in `postman/` use the author's tenant host. Override them as in Level 1.
- `FABRIC_HOST` in `.env` is read only by `postman/build-collection.ts` and `postman/build-fabric-collection.ts` (the generators). Those generators and the collections committed from Postman's Git sync are not identical byte for byte, so regenerating overwrites the synced files. Do it only on a fresh copy.
- Blueprint names and the Astro organization (see above).
- The default demo API server.

## Related

- **Lightyear** (token savings for long coding-agent sessions): https://github.com/davidespihernandez/lightyear-bench. A separate repo with a benchmark you can run on your own tenant.
- [DEMO.md](../DEMO.md): the talk track.
- [FABRIC-SETUP.md](FABRIC-SETUP.md): the Fabric configuration, step by step.
