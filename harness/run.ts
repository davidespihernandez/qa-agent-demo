/**
 * Run the fraud review with the agent and score it against the reference oracle.
 *
 *   bun harness/run.ts --arm A|F|F-eco|B|B-ro|C|D --runs 3 [--max-steps 40] [--live]
 *
 * The arm decides the path (see ARMS in agent/agent/review.ts): A direct, B through Fabric,
 * B-ro through Fabric with the read-only tool set, C through Fabric with Tool Search. The MCP route
 * URLs come from .env (MCP_URL, MCP_URL_READONLY, MCP_URL_SEARCH). Run from the repo root so .env is loaded.
 * Any other label (e.g. --arm D) just runs with whatever .env contains, for experiments.
 * The webhook is NEVER called unless --live is passed, so benchmark runs cannot spam your Flow.
 * A run PASSES when the agent flagged exactly the orders the policy says are fraud.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../agent/agent/fraud-agent';
import { armConfig, isArm, runReview } from '../agent/agent/review';

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
const cfg = isArm(arm) ? armConfig(arm) : loadConfig();

const results: any[] = [];
let expected: string[] = [];
for (let run = 1; run <= runs; run++) {
  const { record, truth } = await runReview(arm, cfg, { maxSteps, live });
  if (run === 1) {
    expected = truth.expected;
    console.log(`Data: ${truth.orders} orders, ${truth.customers} customers (${truth.known} known). Expected flags: ${expected.join(', ') || 'none'}`);
  }
  results.push({ run, ...record });
  const u = record.usage;
  console.log(
    `[${arm}] run ${run}: ${record.verdict}` +
      (u ? ` | in=${u.inputTokens} out=${u.outputTokens}` : '') +
      ` | steps=${record.steps} | ${Math.round(record.ms / 1000)}s | tools=${record.toolCount}` +
      (record.verdict !== 'pass' ? ` | ${record.reason}` : ''),
  );
}

await mkdir(join(import.meta.dir, '..', 'results'), { recursive: true });
const out = join(import.meta.dir, '..', 'results', `${arm}-fraud-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify({ arm, cfg: { model: cfg.model, viaGateway: !!cfg.gatewayKey, live }, expected, results }, null, 2));
console.log(`\nSaved ${out}`);
process.exit(0);
