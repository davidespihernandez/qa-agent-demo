# Plan

## Goal

Show how an agent is created and deployed (Astro), exposed through a gateway (Fabric), and how the gateway gives observability and token savings, in a demo that can be explained in 45 to 60 minutes and reused for other customers.

## Decisions

- **Agent framework: Mastra.** Explicit tool lists keep the baseline fair, it is model-agnostic, and Astro has a first-class adapter.
- **Browser tool: Playwright MCP over HTTP**, hosted on a small cloud VM so the gateway can reach it. Protected by a token that only the gateway holds.
- **Token comparison:** three arms (direct, gateway passthrough, gateway + Tool Search), 3 to 5 runs each. Ground truth is the LLM `usage` fields; cross-check with Fabric's Token Counter and Astro traces. Report pass rate and cache reads next to tokens.

## Risks and things to verify first

1. Playwright MCP must be reachable over HTTP by the gateway.
2. The agent's MCP client must be able to send a custom header to the gateway, and the LLM base URL must be overridable.
3. Tool Search may save less than expected if tool results (page snapshots) dominate token use, or if prompt caching already absorbs schema cost.
4. Fabric observability is dashboard-only according to its docs (no OpenTelemetry export mentioned).
5. Agent runs are non-deterministic: keep a recorded run as a fallback.

## Next steps

- [ ] Spike: hosted Playwright MCP reachable and token-protected
- [ ] Spike: agent calls LLM and MCP through the gateway
- [ ] Harness: run the three arms and print the comparison table
- [ ] Astro: spec, local run, deploy
- [ ] Fabric: connections, route, gateway key, plugins
- [ ] DEMO.md talk track with real numbers

## Ideas to integrate into the demo (parked, current plan stays as is)

- **More MCP servers + Tool Search.** Register extra MCP servers behind Fabric next to Playwright
  (for example a docs MCP and an Orders API MCP, or the Orders OpenAPI exposed with the MCP HTTP
  bridge plugin). The agent then sees a large tool catalog. With Tool Search on, it gets 3 meta-tools
  (search, get, execute) instead of every schema, so tokens drop. With only Playwright (25 tools)
  the saving is small, so this is what makes the Tool Search story realistic.
  Measure it honestly: Tool Search adds steps and does not shrink page snapshots.
- **Arm D: adaptive-model-router (Jev).** Picks model and reasoning effort per request, so easy tests
  run on a cheaper model. Needs a Jev endpoint and key as a Fabric decision service. Report pass rate
  next to cost, turn session stickiness on, and flag mid-run model switches.
- **Guardrails act (optional):** LLM Rate Limit, Agent Scope Gate (block `browser_run_code_unsafe`),
  Killswitch. Keep them off during benchmark runs so they cannot distort the numbers.
