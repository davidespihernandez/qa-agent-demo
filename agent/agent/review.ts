/**
 * One fraud review, scored against the reference oracle. Shared by the CLI harness and the HTTP server,
 * so "run arm B" means exactly the same thing from a terminal, from a Postman request, or from Astro.
 *
 * An arm is just a label for "which path the traffic takes". Everything else (agent, instructions,
 * tools' names and schemas, model, task) is identical across arms.
 */

import { createHash } from 'node:crypto';
import { createFraudAgent, loadConfig, postWebhook, POLICY_VERSION, type Delivery, type FraudReport, type QaConfig } from './fraud-agent';
import { expectedFlags } from './oracle';

export type Arm = 'A' | 'B' | 'B-ro' | 'C' | 'D';

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
  D: {
    title: 'Fabric + adaptive model router',
    llm: 'Fabric LLM route with the adaptive-model-router plugin: Jev picks the model for each request',
    tools: 'API calls made in-process by the agent, as in arm A (isolates the router)',
    env: 'LLM_BASE_URL_ADAPTIVE',
  },
};

export const isArm = (a: string): a is Arm => a in ARMS;

/** Config for an arm: the same env vars as always, with the MCP route (or none) chosen by the arm. */
export function armConfig(arm: Arm, env: Record<string, string | undefined> = process.env): QaConfig {
  const cfg = loadConfig(env);
  if (arm === 'A') return { ...cfg, llmBaseUrl: undefined, gatewayKey: undefined, mcpUrl: undefined, mcpToken: undefined };
  if (arm === 'D') {
    const llmBaseUrl = env.LLM_BASE_URL_ADAPTIVE;
    if (!llmBaseUrl || !cfg.gatewayKey) throw new Error('Arm D needs LLM_BASE_URL_ADAPTIVE (the Fabric adaptive route) and FABRIC_GATEWAY_KEY.');
    return { ...cfg, llmBaseUrl, mcpUrl: undefined, mcpToken: undefined };
  }
  const mcpUrl = env[ARMS[arm].env!] || undefined;
  if (!mcpUrl) throw new Error(`Arm ${arm} needs ${ARMS[arm].env} (the Fabric MCP route URL) in the environment.`);
  if (!cfg.llmBaseUrl || !cfg.gatewayKey) throw new Error(`Arm ${arm} needs LLM_BASE_URL and FABRIC_GATEWAY_KEY.`);
  return { ...cfg, mcpUrl };
}

/** Sonnet 4.5 list price in USD per million tokens, the same rate Fabric uses for "Estimated cost". */
export const PRICE = { in: 3, out: 15 };
export const estimateCost = (u: { inputTokens?: number; outputTokens?: number } | null | undefined) =>
  u ? ((u.inputTokens ?? 0) * PRICE.in + (u.outputTokens ?? 0) * PRICE.out) / 1e6 : null;

/**
 * List prices in USD per million tokens, by model id prefix. Only models whose price is known are here:
 * an adaptive run that lands on any other model reports tokens per model and no total cost, never a guess.
 */
const MODEL_PRICES: [string, { in: number; out: number }][] = [
  ['claude-sonnet-4-5', { in: 3, out: 15 }],
  ['claude-haiku-4-5', { in: 1, out: 5 }],
  ['claude-opus-4-5', { in: 5, out: 25 }],
];

/** What each step really ran on (the router may change the model per request) and what that cost. */
export function perModelUsage(steps: any[] = []) {
  const byModel: Record<string, { steps: number; inputTokens: number; outputTokens: number; costUsd: number | null }> = {};
  for (const st of steps) {
    const m = String(st.response?.modelId ?? st.response?.model ?? 'unknown');
    const u = st.usage ?? {};
    const e = (byModel[m] ??= { steps: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    e.steps += 1;
    e.inputTokens += u.inputTokens ?? u.promptTokens ?? 0;
    e.outputTokens += u.outputTokens ?? u.completionTokens ?? 0;
  }
  for (const [m, e] of Object.entries(byModel)) {
    const price = MODEL_PRICES.find(([p]) => m.startsWith(p))?.[1];
    e.costUsd = price ? (e.inputTokens * price.in + e.outputTokens * price.out) / 1e6 : null;
  }
  const costs = Object.values(byModel).map((e) => e.costUsd);
  return { byModel, totalCostUsd: costs.length && costs.every((c) => c !== null) ? (costs as number[]).reduce((a, b) => a + b, 0) : null };
}

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
  const alerts: Delivery[] = [];
  const { agent, mcp, toolCount, runId } = await createFraudAgent(runCfg, {}, (r) => reports.push(r), (d) => alerts.push(d));
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
      // Arm D can use several models in one run: price each step by the model that served it.
      ...(arm === 'D'
        ? (() => {
            const pm = perModelUsage(res.steps);
            return { modelsUsed: pm.byModel, estimatedCostUsd: pm.totalCostUsd };
          })()
        : { estimatedCostUsd: estimateCost(usage) }),
      steps: res.steps?.length ?? null,
      toolCalls: res.toolCalls?.length ?? null,
      summary: String(res.text ?? '').split('\n').filter((l) => l.startsWith('SUMMARY')).pop() ?? null,
      findings: reports,
      // What the agent actually did: every tool it called, in order, with the arguments it chose.
      calls: (res.steps ?? []).flatMap((st: any) => (st.toolCalls ?? []).map((c: any) => ({ tool: c.payload?.toolName ?? c.toolName, args: c.payload?.args ?? c.args }))),
      ms: Date.now() - started,
    };
  } catch (e: any) {
    record = { ...record, verdict: 'error', reason: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started };
  } finally {
    await mcp?.disconnect().catch(() => {});
  }
  // Every live review ends with ONE summary event to the webhook, fraud or not, so the Flow always hears back.
  let summary: Delivery = { kind: 'summary', status: 'skipped', response: 'Dry run: the webhook is not called.' };
  if (opts.live && cfg.webhookUrl) {
    const reviewed = Number(String(record.summary ?? '').match(/reviewed (\d+)/)?.[1] ?? truth.orders);
    const payload = {
      type: 'fraud-review-summary',
      runId,
      arm,
      model: arm === 'D' ? 'adaptive (chosen per step by the router)' : cfg.model,
      policyVersion: POLICY_VERSION,
      status: record.verdict === 'error' ? 'error' : 'completed',
      error: record.verdict === 'error' ? record.reason : undefined,
      ordersAnalyzed: reviewed,
      customersChecked: truth.customers,
      fraudulentOrders: reports.length,
      cleanOrders: Math.max(reviewed - reports.length, 0),
      flagged: reports,
      agentSummary: record.summary ?? null,
      matchesReferenceCheck: record.verdict === 'pass',
      usage: record.usage ?? null,
      estimatedCostUsd: record.estimatedCostUsd ?? null,
      durationMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    };
    const key = createHash('sha256').update(`summary:${runId}`).digest('hex');
    summary = { kind: 'summary', ...(await postWebhook(cfg.webhookUrl, key, payload)) };
    record.sentToWebhook = payload;
  }
  record.webhook = { alerts, summary };
  return { record, truth: { orders: truth.orders, customers: truth.customers, known: truth.known, expected: [...truth.expected.keys()] } };
}
