/**
 * Run the plain-English tests with the QA agent and record tokens, cost inputs, time and verdict.
 *
 *   bun harness/run.ts --arm A --runs 3 [--tests 01,02] [--max-steps 40]
 *
 * The arm is just a label: which path the traffic takes is decided by the env vars
 * (see agent/agent/qa-agent.ts and .env.example). Run from the repo root so .env is loaded.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createQaAgent, loadConfig, parseVerdict } from '../agent/agent/qa-agent';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);

const arm = args.arm ?? 'A';
const runs = Number(args.runs ?? 1);
const maxSteps = Number(args['max-steps'] ?? 40);
const filter = args.tests ? String(args.tests).split(',') : null;

const testsDir = join(import.meta.dir, '..', 'tests');
const files = (await readdir(testsDir)).filter((f) => f.endsWith('.md')).sort().filter((f) => !filter || filter.some((p) => f.startsWith(p)));

const cfg = loadConfig();
const results: any[] = [];

for (let run = 1; run <= runs; run++) {
  for (const file of files) {
    const spec = await readFile(join(testsDir, file), 'utf8');
    const started = Date.now();
    const { agent, mcp, toolCount } = await createQaAgent(cfg);
    let record: any = { arm, run, test: file, toolCount, model: cfg.model };
    try {
      const res: any = await agent.generate(`Application URL: ${cfg.appUrl}\n\nTest:\n${spec}`, { maxSteps });
      const verdict = parseVerdict(res.text ?? '');
      record = {
        ...record,
        ...verdict,
        usage: res.totalUsage ?? res.usage ?? null,
        steps: res.steps?.length ?? null,
        toolCalls: res.toolCalls?.length ?? null,
        ms: Date.now() - started,
      };
    } catch (e: any) {
      record = { ...record, verdict: 'error', reason: String(e?.message ?? e).slice(0, 300), ms: Date.now() - started };
    } finally {
      await mcp.disconnect().catch(() => {});
    }
    results.push(record);
    const u = record.usage;
    console.log(
      `[${arm}] run ${run} ${file}: ${record.verdict}` +
        (u ? ` | in=${u.inputTokens} out=${u.outputTokens}` : '') +
        ` | ${Math.round(record.ms / 1000)}s | tools=${toolCount}` +
        (record.verdict === 'error' ? ` | ${record.reason}` : ''),
    );
  }
}

await mkdir(join(import.meta.dir, '..', 'results'), { recursive: true });
const out = join(import.meta.dir, '..', 'results', `${arm}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(out, JSON.stringify({ arm, cfg: { model: cfg.model, appUrl: cfg.appUrl, viaGateway: !!cfg.gatewayKey }, results }, null, 2));
console.log(`\nSaved ${out}`);
process.exit(0);
