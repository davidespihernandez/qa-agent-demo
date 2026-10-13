/**
 * Compare arms: merges every results/*.json and prints a markdown table per test.
 *
 *   bun harness/compare.ts [--arms A,B,C] [--in-price 3] [--out-price 15]
 *
 * Prices are USD per million tokens (defaults: Sonnet 4.5 list price, the same rate
 * Fabric uses for its "Estimated cost"). Change them if you switch model.
 * Cache reads are billed at 10% of the input price, cache writes at 125%.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);
const inPrice = Number(args['in-price'] ?? 3);
const outPrice = Number(args['out-price'] ?? 15);
const armFilter = args.arms ? String(args.arms).split(',') : null;

const dir = join(import.meta.dir, '..', 'results');
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
const rows: any[] = [];
for (const f of files) {
  const data = JSON.parse(await readFile(join(dir, f), 'utf8'));
  for (const r of data.results ?? []) rows.push(r);
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

// Input as billed: uncached + cache reads at 10% + cache writes at 125%.
function cost(u: any) {
  const read = u.cachedInputTokens ?? 0;
  const write = u.cacheCreationInputTokens ?? 0;
  const plain = Math.max(0, (u.inputTokens ?? 0) - read - write);
  return (plain * inPrice + read * inPrice * 0.1 + write * inPrice * 1.25 + (u.outputTokens ?? 0) * outPrice) / 1e6;
}

const arms = [...new Set(rows.map((r) => r.arm))].filter((a) => !armFilter || armFilter.includes(a)).sort();
const tests = [...new Set(rows.map((r) => r.test))].sort();

console.log(`Prices: $${inPrice}/M input, $${outPrice}/M output\n`);
console.log('| Test | Arm | Runs | Pass/Fail/Err | Input tokens (median, range) | Output (median) | Cost/run (median) | Steps (median) | Time (median) | Tools |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const t of tests) {
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm && r.test === t);
    if (!rs.length) continue;
    const ok = rs.filter((r) => r.usage);
    const ins = ok.map((r) => r.usage.inputTokens);
    const count = (v: string) => rs.filter((r) => r.verdict === v).length;
    console.log(
      `| ${t.replace('.md', '')} | ${arm} | ${rs.length} | ${count('pass')}/${count('fail')}/${count('error') + count('unknown')} | ` +
        (ok.length
          ? `${k(median(ins))} (${k(Math.min(...ins))}–${k(Math.max(...ins))}) | ${k(median(ok.map((r) => r.usage.outputTokens)))} | $${median(ok.map((r) => cost(r.usage))).toFixed(3)} | ${median(ok.map((r) => r.steps ?? 0))} | ${Math.round(median(ok.map((r) => r.ms)) / 1000)}s | ${rs[0].toolCount} |`
          : '- | - | - | - | - | - |'),
    );
  }
}

// Overall per arm
console.log('\n| Arm | Runs | Total input | Total output | Total cost |');
console.log('|---|---|---|---|---|');
for (const arm of arms) {
  const ok = rows.filter((r) => r.arm === arm && r.usage);
  console.log(
    `| ${arm} | ${ok.length} | ${k(ok.reduce((s, r) => s + r.usage.inputTokens, 0))} | ${k(ok.reduce((s, r) => s + r.usage.outputTokens, 0))} | $${ok.reduce((s, r) => s + cost(r.usage), 0).toFixed(2)} |`,
  );
}
