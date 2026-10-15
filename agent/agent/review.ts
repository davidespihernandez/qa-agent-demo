/**
 * One fraud review, scored against the reference oracle. Shared by the CLI harness and the HTTP server,
 * so "run arm B" means exactly the same thing from a terminal, from a Postman request, or from Astro.
 *
 * An arm is just a label for "which path the traffic takes". Everything else (agent, instructions,
 * tools' names and schemas, model, task) is identical across arms.
 */

import { createFraudAgent, loadConfig, type FraudReport, type QaConfig } from './fraud-agent';
import { expectedFlags } from './oracle';

export type Arm = 'A' | 'B' | 'B-ro' | 'C';

export const ARMS: Record<Arm, { title: string; llm: string; tools: string; env?: string }> = {
  A: {
    title: 'Direct',
    llm: 'Anthropic, with the real API key inside the agent',
    tools: 'API calls made in-process by the agent (21 tools, writes blocked in code)',
  },
  B: {
    title: 'Through Fabric',
    llm: 'Fabric LLM route (the agent only holds a gateway key)',
    tools: 'Fabric MCP route: bridge exposes all 21 operations',
    env: 'MCP_URL',
  },
  'B-ro': {
    title: 'Through Fabric, read-only tools',
    llm: 'Fabric LLM route',
    tools: 'Fabric MCP route: bridge exposes only the 8 GET operations (least privilege)',
    env: 'MCP_URL_READONLY',
  },
  C: {
    title: 'Fabric + Tool Search',
    llm: 'Fabric LLM route',
    tools: 'Fabric MCP route with the Tool Search plugin: the model searches for tools instead of receiving all of them',
    env: 'MCP_URL_SEARCH',
  },
};

export const isArm = (a: string): a is Arm => a in ARMS;

/** Config for an arm: the same env vars as always, with the MCP route (or none) chosen by the arm. */
export function armConfig(arm: Arm, env: Record<string, string | undefined> = process.env): QaConfig {
  const cfg = loadConfig(env);
  if (arm === 'A') return { ...cfg, llmBaseUrl: undefined, gatewayKey: undefined, mcpUrl: undefined, mcpToken: undefined };
  const mcpUrl = env[ARMS[arm].env!] || undefined;
  if (!mcpUrl) throw new Error(`Arm ${arm} needs ${ARMS[arm].env} (the Fabric MCP route URL) in the environment.`);
  if (!cfg.llmBaseUrl || !cfg.gatewayKey) throw new Error(`Arm ${arm} needs LLM_BASE_URL and FABRIC_GATEWAY_KEY.`);
  return { ...cfg, mcpUrl };
}

/** Sonnet 4.5 list price in USD per million tokens, the same rate Fabric uses for "Estimated cost". */
export const PRICE = { in: 3, out: 15 };
export const estimateCost = (u: { inputTokens?: number; outputTokens?: number } | null | undefined) =>
  u ? ((u.inputTokens ?? 0) * PRICE.in + (u.outputTokens ?? 0) * PRICE.out) / 1e6 : null;

const PROMPT =
  'Review all orders for fraud according to the policy. Report each suspicious order with report_fraud, then finish with the SUMMARY line.';

/** Ground truth from the live data: look customers up one by one (the users list is huge). */
async function groundTruth(apiBaseUrl?: string) {
  const base = (apiBaseUrl ?? 'https://18-157-170-15.nip.io').replace(/\/+$/, '');
  const orders: any = await (await fetch(base + '/orders')).json();
  const customers = [...new Set<string>(orders.data.map((o: any) => o.customerId))];
  const known = new Set<string>();
  for (const id of customers) if ((await fetch(`${base}/users/${encodeURIComponent(id)}`)).ok) known.add(id);
  return { orders: orders.data.length, customers: customers.length, known: known.size, expected: expectedFlags(orders.data, known) };
}

export type ReviewOptions = { maxSteps?: number; live?: boolean };

export async function runReview(arm: string, cfg: QaConfig, opts: ReviewOptions = {}) {
  const truth = await groundTruth(cfg.apiBaseUrl);
  // The webhook is only called on a live run, so benchmark runs never spam the Flow.
  const runCfg = { ...cfg, webhookUrl: opts.live ? cfg.webhookUrl : undefined };
  const started = Date.now();
  const reports: FraudReport[] = [];
  const { agent, mcp, toolCount, runId } = await createFraudAgent(runCfg, {}, (r) => reports.push(r));
  let record: any = { arm, test: 'fraud-review', runId, toolCount, model: cfg.model, live: !!opts.live };
  try {
    const res: any = await agent.generate(PROMPT, { maxSteps: opts.maxSteps ?? 40 });
    const flagged = new Set(reports.map((r) => r.orderId));
    const missed = [...truth.expected.keys()].filter((id) => !flagged.has(id));
    const extra = [...flagged].filter((id) => !truth.expected.has(id));
    const usage = res.totalUsage ?? res.usage ?? null;
    record = {
      ...record,
      verdict: missed.length === 0 && extra.length === 0 ? 'pass' : 'fail',
      reason: `expected [${[...truth.expected.keys()]}] flagged [${[...flagged]}] missed [${missed}] extra [${extra}]`,
      flagged: [...flagged],
      missed,
      extra,
      usage,
      estimatedCostUsd: estimateCost(usage),
      steps: res.steps?.length ?? null,
      toolCalls: res.toolCalls?.length ?? null,
      summary: String(res.text ?? '').split('\n').filter((l) => l.startsWith('SUMMARY')).pop() ?? null,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    record = { ...record, verdict: 'error', reason: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started };
  } finally {
    await mcp?.disconnect().catch(() => {});
  }
  return { record, truth: { orders: truth.orders, customers: truth.customers, known: truth.known, expected: [...truth.expected.keys()] } };
}
