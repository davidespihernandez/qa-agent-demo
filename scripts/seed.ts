/**
 * Seed (or remove) the labeled orders the fraud demo uses. This WRITES to the Orders API.
 *
 *   bun scripts/seed.ts            # print the plan, change nothing
 *   bun scripts/seed.ts --yes      # create the orders, remember their ids in results/seed-ids.json
 *   bun scripts/seed.ts --reset --yes   # delete only the orders this script created
 *
 * Expected by the policy (agent/agent/fraud-policy.md):
 *   flagged: high-value 12,500 | unknown customer | 3 identical orders from usr-001
 *   clean:   a few ordinary orders, including 10,000.00 exactly (the boundary is NOT fraud)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const yes = args.has('--yes');
const reset = args.has('--reset');
const base = (process.env.API_BASE_URL ?? 'https://18-157-170-15.nip.io').replace(/\/+$/, '');
const idsFile = join(import.meta.dir, '..', 'results', 'seed-ids.json');

const SEED = [
  { label: 'clean', customerId: 'usr-001', total: 120.0 },
  { label: 'clean', customerId: 'usr-002', total: 75.25 },
  { label: 'clean', customerId: 'usr-003', total: 310.0 },
  { label: 'clean (boundary, exactly 10,000)', customerId: 'usr-003', total: 10000.0 },
  { label: 'FRAUD high-value', customerId: 'usr-001', total: 12500.0 },
  { label: 'FRAUD unknown customer', customerId: 'usr-ghost', total: 80.0 },
  { label: 'FRAUD repeated x3', customerId: 'usr-001', total: 42.0 },
  { label: 'FRAUD repeated x3', customerId: 'usr-001', total: 42.0 },
  { label: 'FRAUD repeated x3', customerId: 'usr-001', total: 42.0 },
];

if (reset) {
  const ids: string[] = JSON.parse(await readFile(idsFile, 'utf8').catch(() => '[]'));
  console.log(`Would delete ${ids.length} seeded orders: ${ids.join(', ') || '(none)'}`);
  if (!yes) process.exit(0);
  for (const id of ids) console.log(id, (await fetch(`${base}/orders/${id}`, { method: 'DELETE' })).status);
  await writeFile(idsFile, '[]');
  process.exit(0);
}

console.log(`Target: ${base}/orders`);
for (const s of SEED) console.log(`  ${s.label.padEnd(34)} ${s.customerId.padEnd(10)} ${s.total}`);
if (!yes) {
  console.log('\nDry run. Re-run with --yes to create these orders.');
  process.exit(0);
}

const created: string[] = JSON.parse(await readFile(idsFile, 'utf8').catch(() => '[]'));
for (const s of SEED) {
  const res = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: s.customerId, total: s.total, currency: 'USD' }),
  });
  const body: any = await res.json().catch(() => ({}));
  console.log(res.status, s.label, body.id ?? JSON.stringify(body));
  if (body.id) created.push(body.id);
}
await mkdir(join(import.meta.dir, '..', 'results'), { recursive: true });
await writeFile(idsFile, JSON.stringify(created, null, 2));
