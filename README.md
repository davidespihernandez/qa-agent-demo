# qa-agent-demo

A UI-testing agent that reads **plain-English test specs**, drives a real browser, and reports pass/fail with evidence. Built to demo two Postman products end to end:

- **Astro** (Astropods): build, run, deploy and observe the agent.
- **Fabric Gateway**: put every LLM and tool call behind one governed, observable endpoint, and measure token savings.

> Status: work in progress. See [docs/PLAN.md](docs/PLAN.md) for the plan and [DEMO.md](DEMO.md) for the talk track.

## The idea

```
tester (chat)
   │
[ QA agent  ]  ── traces ──▶ Astro (turns, evals, outcomes)
   │ LLM calls        │ tool calls (MCP)
   ▼                  ▼
 Fabric Gateway (gateway key · Tool Search · Token Counter · audit)
   │                  │
 Anthropic       Playwright MCP ──▶ Chrome ──▶ app under test
```

Astro tells you whether the agent did its job. Fabric tells you what it cost, what it touched, and can stop it from touching what it shouldn't.

## Token comparison (the value of the gateway)

The same tests run three ways, several times each:

| Arm | Path | Shows |
|---|---|---|
| A. Baseline | agent → LLM and tools directly | the "before" |
| B. Gateway passthrough | agent → Fabric | observability with ~no token change |
| C. Gateway + Tool Search | agent → Fabric, Tool Search on | the token savings |

Ground truth is the LLM `usage` fields captured by the harness, cross-checked against Fabric's Token Counter and Astro's traces. Pass rate is reported next to tokens, so savings can't hide failures.

## Layout

| Path | What |
|---|---|
| `tests/` | plain-English test specs (what a customer would write) |
| `agent/` | the agent (Mastra) and its evaluation instructions |
| `agent-runtime/` | browser host: Playwright MCP + the app under test (AWS) |
| `harness/` | runs the three arms and prints the comparison table |
| `docs/` | plan and notes |

## Configuration

Copy `.env.example` to `.env`. Never commit `.env`.

## License

MIT
