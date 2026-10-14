/**
 * Reference implementation of fraud-policy.md. The agent never sees this: the harness uses it
 * as ground truth to score what the agent flagged.
 */

export type Order = { id: string; customerId: string; total: number };

export function expectedFlags(orders: Order[], knownCustomers: Set<string>): Map<string, string[]> {
  const known = knownCustomers;
  const groups = new Map<string, Order[]>();
  for (const o of orders) {
    const key = `${o.customerId}|${o.total}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const flags = new Map<string, string[]>();
  const add = (id: string, rule: string) => flags.set(id, [...(flags.get(id) ?? []), rule]);
  for (const o of orders) {
    if (o.total > 10000) add(o.id, 'high-value');
    if (!known.has(o.customerId)) add(o.id, 'unknown-customer');
    if ((groups.get(`${o.customerId}|${o.total}`)?.length ?? 0) >= 3) add(o.id, 'repeated-identical');
  }
  return flags;
}
