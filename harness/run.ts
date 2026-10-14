/**
 * Run the fraud review with the agent and score it against the reference oracle.
 *
 *   bun harness/run.ts --arm A --runs 3 [--max-steps 40] [--live]
 *
 * The arm is just a label: which path the traffic takes is decided by the env vars
 * (see agent/agent/fraud-agent.ts and .env.example). Run from the repo root so .env is loaded.
 * The webhook is NEVER called unless --live is passed, so benchmark runs cannot spam your Flow.
 * A run PASSES when the agent flagged exactly the orders the policy says are fraud.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createFraudAgent, loadConfig, type FraudReport } from '../agent/agent/fraud-agent';
import { expectedFlags } from '../agent/agent/oracle';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);

const arm = args.arm ?? 'A';
const runs = Number(args.runs ?? 1);
const maxSteps = Number(args['max-steps'] ?? 40);
const live = args.live === 'true';

// Arm A is the direct baseline: never let gateway settings from .env leak into it.
if (arm === 'A') {
  for (const k of ['LLM_BASE_URL', 'FABRIC_GATEWAY_KEY', 'MCP_URL', 'MCP_TOKEN']) delete process.env[k];
}
const cfg = loadConfig();
if (!live) cfg.webhookUrl = undefined;

// Ground truth, computed from the live data right before the runs.
const base = (cfg.apiBaseUrl ?? 'https://18-157-170-15.nip.io').replace(/\/+$/, '');
const getJson = async (p: string) => (await fetch(base + p)).json() as Promise<{ data: any[] }>;
const orders = await getJson('/orders');
// The users list is huge (tens of thousands of synthetic users), so look customers up one by one.
const customers = [...new Set<string>(orders.data.map((o) => o.customerId))];
const known = new Set<string>();
for (const id of customers) if ((await fetch(`${base}/users/${encodeURIComponent(id)}`)).ok) known.add(id);
const expected = expectedFlags(orders.data, known);
console.log(`Data: ${orders.data.length} orders, ${customers.length} customers (${known.size} known). Expected flags: ${[...expected.keys()].join(', ') || 'none'}`);

const prompt = 'Review all orders for fraud according to the policy. Report each suspicious order with report_fraud, then finish with the SUMMARY line.';
const results: any[] = [];

for (let run = 1; run <= runs; run++) {
  const started = Date.now();
  const reports: FraudReport[] = [];
  const { agent, mcp, toolCount } = await createFraudAgent(cfg, {}, (r) => reports.push(r));
  let record: any = { arm, run, test: 'fraud-review', toolCount, model: cfg.model };
  try {
    const res: any = await agent.generate(prompt, { maxSteps });
    const flagged = new Set(reports.map((r) => r.orderId));
    const missed = [...expected.keys()].filter((id) => !flagged.has(id));
    const extra = [...flagged].filter((id) => !expected.has(id));
    record = {
      ...record,
      verdict: missed.length === 0 && extra.length === 0 ? 'pass' : 'fail',
      reason: `expected [${[...expected.keys()]}] flagged [${[...flagged]}] missed [${missed}] extra [${extra}]`,
      flagged: [...flagged],
      missed,
      extra,
      usage: res.totalUsage ?? res.usage ?? null,
      steps: res.steps?.length ?? null,
      toolCalls: res.toolCalls?.length ?? null,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    record = { ...record, verdict: 'error', reason: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started };
  } finally {
    await mcp?.disconnect().catch(() => {});
  }
  results.push(record);
  const u = record.usage;
  console.log(
    `[${arm}] run ${run}: ${record.verdict}` +
      (u ? ` | in=${u.inputTokens} out=${u.outputTokens}` : '') +
      ` | steps=${record.steps} | ${Math.round(record.ms / 1000)}s | tools=${toolCount}` +
      (record.verdict !== 'pass' ? ` | ${record.reason}` : ''),
  );
}

await mkdir(join(import.meta.dir, '..', 'results'), { recursive: true });
const out = join(import.meta.dir, '..', 'results', `${arm}-fraud-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify({ arm, cfg: { model: cfg.model, viaGateway: !!cfg.gatewayKey, live }, expected: [...expected.keys()], results }, null, 2));
console.log(`\nSaved ${out}`);
process.exit(0);
