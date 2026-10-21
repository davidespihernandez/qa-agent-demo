/** Generates the Postman v3 (YAML) collection in postman/collections/ (run: bun postman/build-collection.ts). */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// [key, arm sent to the agent, request name, description, extra body fields]
const arms: [string, string, string, string, object?][] = [
  ['A', 'A', '1. A - Direct to Anthropic', 'The agent calls Anthropic and the APIs itself, with the real Anthropic key inside the agent. Nothing in between: the baseline (Sonnet 4.5).'],
  ['F', 'F', '2. F - Through Fabric', 'Same agent, same task. The LLM and the APIs go through Fabric: the agent only holds a gateway key (fg-api-key), and Fabric adds the real credentials. Expect the same tokens and cost as A, plus traces, analytics and control in Fabric.'],
  ['F-eco', 'F-eco', '3. F-eco - Fabric economy route', 'Same as F, but the agent calls the economy route, where a Transformer plugin rewrites the model to Haiku 4.5. No agent change. About 67% cheaper in our runs; Haiku passed 7 of 8.'],
  ['F-cheap', 'F', '4. F + model "cheap" - choose the model per request', 'Same as F, but the request asks for the "cheap" model (Haiku 4.5). The agent switches model per request, with no redeploy. Use "expensive" for Sonnet 4.5 or a full model id.', { model: 'cheap' }],
  ['B', 'B', '5. B - Fabric MCP route (optional)', 'Tools come from a Fabric MCP route instead of in-process calls: the bridge exposes all 21 operations. Needs MCP_URL on the agent.'],
  ['B-ro', 'B-ro', '6. B-ro - MCP, read-only tools (optional)', 'Fabric exposes only the 8 GET operations to this agent. Fewer tool definitions per call, and it cannot write even if it wanted to. Needs MCP_URL_READONLY.'],
  ['C', 'C', '7. C - MCP + Tool Search (optional)', 'Fabric hides the catalog behind a search tool; the model fetches only the tools it needs. Needs MCP_URL_SEARCH.'],
];

const test = (arm: string, label = arm) => [
  '// POST /review answers 202 at once; poll /runs/{id} until the review finishes (a review takes 20-60 s).',
  'const show = (r) => {',
  `  pm.test('Agent flagged exactly the right orders', () => pm.expect(r.verdict).to.eql('pass'));`,
  `  pm.collectionVariables.set('res_${arm}', JSON.stringify({ arm: '${label}', verdict: r.verdict, tools: r.toolCount, steps: r.steps,`,
  '    inTok: r.usage && r.usage.inputTokens, outTok: r.usage && r.usage.outputTokens, cost: r.estimatedCostUsd, sec: Math.round(r.ms / 1000) }));',
  '  let t = `<style>body{font-family:sans-serif;font-size:14px}td,th{padding:4px 10px;text-align:right}th:first-child,td:first-child{text-align:left}</style>',
  '  <h3>Arm ${r.arm}: ${r.title}</h3><p>${r.llm}<br>${r.tools}</p>',
  '  <table><tr><th>Verdict</th><th>Tools sent</th><th>Steps</th><th>Input tokens</th><th>Output tokens</th><th>Est. cost</th><th>Time</th></tr>',
  '  <tr><td>${r.verdict}</td><td>${r.toolCount}</td><td>${r.steps}</td><td>${r.usage && r.usage.inputTokens}</td><td>${r.usage && r.usage.outputTokens}</td><td>$${r.estimatedCostUsd && r.estimatedCostUsd.toFixed(3)}</td><td>${Math.round(r.ms/1000)}s</td></tr></table>`;',
  '  const esc = x => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;");',
  '  const f = (r.findings || []).map(x => `<tr><td>${esc(x.orderId)}</td><td>${esc(x.customerId)}</td><td>${esc(x.total)}</td><td>${esc((x.rulesBroken || []).join(", "))}</td><td>${esc(x.severity)}</td><td class="l">${esc(x.evidence)}</td></tr>`).join("") || `<tr><td colspan="6" class="l">No fraud found in ${esc(r.truth && r.truth.orders)} orders.</td></tr>`;',
  '  const w = r.webhook || { alerts: [], summary: {} };',
  '  const wr = [...(w.alerts || []), w.summary].filter(Boolean).map(d => `<tr><td>${esc(d.kind)}</td><td>${esc(d.orderId || "")}</td><td>${esc(d.status)}</td><td>${esc(d.httpStatus || "")}</td><td class="l">${esc(d.response)}</td></tr>`).join("");',
  '  const calls = (r.calls || []).map(c => `${esc(c.tool)}`).join(" &rarr; ");',
  '  t += `<h4>What the agent found (${esc(r.summary)})</h4><table><tr><th>Order</th><th>Customer</th><th>Total</th><th>Rules broken</th><th>Severity</th><th>Evidence (written by the agent)</th></tr>${f}</table>',
  '  <h4>Webhook deliveries and the Flow\'s reply</h4><table><tr><th>Kind</th><th>Order</th><th>Status</th><th>HTTP</th><th>Response from the webhook</th></tr>${wr}</table>',
  '  <h4>Summary event sent to the webhook</h4><pre>${esc(r.sentToWebhook ? JSON.stringify(r.sentToWebhook, null, 2) : "(dry run: nothing sent)")}</pre>',
  '  <h4>Tool calls the agent made (${(r.calls || []).length})</h4><p class="l">${calls}</p>`;',
  '  t = t.replace("</style>", "td.l,p.l{text-align:left}pre{font-size:12px;background:#f4f4f4;padding:8px}</style>");',
  '  pm.visualizer.set(t);',
  '};',
  'const start = pm.response.json();',
  'const poll = (left) => pm.sendRequest({',
  '  url: pm.variables.replaceIn("{{baseUrl}}") + start.statusUrl, method: "GET",',
  '  header: { "x-demo-key": pm.variables.replaceIn("{{demoKey}}"), "fg-api-key": pm.variables.replaceIn("{{fabricKey}}") },',
  '}, (err, res) => {',
  '  const r = err ? { status: "error" } : res.json();',
  '  if (r.status === "running" && left > 0) return setTimeout(() => poll(left - 1), 3000);',
  '  if (r.status !== "done") return pm.test("Review finished: " + (r.error || r.status), () => pm.expect.fail());',
  '  show(r);',
  '});',
  'if (pm.response.code === 202) poll(60); else pm.test("Review accepted: " + (start.error || pm.response.code), () => pm.expect.fail());',
];

const compareTest = [
  'const rows = ["A","F","F-eco","F-cheap","B","B-ro","C"].map(a => { try { return JSON.parse(pm.collectionVariables.get("res_" + a)); } catch (e) { return null; } }).filter(Boolean);',
  'const base = rows.find(x => x.arm === "A");',
  'const d = x => base && base.inTok ? ((x.inTok / base.inTok - 1) * 100).toFixed(1) + "%" : "";',
  'const tr = rows.map(x => `<tr><td>${x.arm}</td><td>${x.verdict}</td><td>${x.tools}</td><td>${x.inTok}</td><td>${d(x)}</td><td>${x.outTok}</td><td>$${x.cost.toFixed(3)}</td><td>${x.sec}s</td></tr>`).join("");',
  'pm.visualizer.set(`<style>body{font-family:sans-serif;font-size:14px}td,th{padding:4px 12px;text-align:right}th:first-child,td:first-child{text-align:left}</style><h3>Same agent, same task: what changed per arm</h3><table><tr><th>Arm</th><th>Verdict</th><th>Tools sent</th><th>Input tokens</th><th>vs A</th><th>Output</th><th>Est. cost</th><th>Time</th></tr>${tr}</table>`);',
];

const dir = join(import.meta.dir, 'collections', 'Fraud agent - arms');
// Regenerate everything except the hand-written T* (Transformer) and R* (adaptive router) repro requests.
mkdirSync(join(dir, '.resources'), { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.request.yaml') && !/^[TR]\d\./.test(f)) rmSync(join(dir, f));

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars
const block = (lines: string[], pad: string) => lines.map((l) => pad + l).join('\n');

function request(order: number, name: string, method: string, path: string, desc: string, body?: object, script?: string[], base = '{{baseUrl}}') {
  const y = [
    '$kind: http-request',
    `description: ${q(desc)}`,
    `url: ${q(base + path)}`,
    `method: ${method}`,
    'headers:',
    '  Content-Type: application/json',
    ...(base === '{{baseUrl}}' ? ['  x-demo-key: "{{demoKey}}"', '  fg-api-key: "{{fabricKey}}"'] : ['  fg-api-key: "{{fabricKey}}"']),
  ];
  if (body) y.push('body:', '  type: json', '  content: |-', block(JSON.stringify(body, null, 2).split('\n'), '    '));
  if (script) y.push('scripts:', '  - type: afterResponse', '    code: |-', block(script, '      '), '    language: text/javascript');
  y.push(`order: ${order}`);
  writeFileSync(join(dir, `${name}.request.yaml`), y.join('\n') + '\n');
}

writeFileSync(
  join(dir, '.resources', 'definition.yaml'),
  [
    '$kind: collection',
    'description: >-',
    '  Runs the same fraud-review agent through each path; only the arm changes. Run the arm requests in order',
    '  (or use the Collection Runner), then open "Compare arms" and its Visualize tab. Dry run by default: the webhook is not called. baseUrl points at the Fabric route /agent (needs fabricKey); for a local server use http://localhost:8787 and leave fabricKey empty.',
    'variables:',
    '  baseUrl: https://david-esp-s-fabric-team.dp.fabricgateway.ai/agent',
    '  ordersUrl: https://david-esp-s-fabric-team.dp.fabricgateway.ai/api',
    '  fabricKey: ""',
    '  demoKey: ""',
  ].join('\n') + '\n',
);

const resetScript = [
  'const keep = ["ord-001", "ord-002"];',
  'const all = pm.response.json().data || [];',
  'const extra = all.filter(o => !keep.includes(o.id));',
  'const base = pm.variables.replaceIn("{{ordersUrl}}");',
  'const out = [];',
  'const next = (i) => {',
  '  if (i >= extra.length) {',
  '    pm.test("Only ord-001 and ord-002 remain", () => pm.expect(out.filter(x => x.code !== 200 && x.code !== 204).length).to.eql(0));',
  '    return pm.visualizer.set(`<h3>Orders reset</h3><p>Kept ${keep.join(", ")}. Deleted ${out.length}: ${out.map(x => x.id + " (" + x.code + ")").join(", ") || "nothing to delete"}.</p>`);',
  '  }',
  '  pm.sendRequest({ url: base + "/orders/" + extra[i].id, method: "DELETE", header: { "fg-api-key": pm.variables.replaceIn("{{fabricKey}}") } }, (err, res) => { out.push({ id: extra[i].id, code: err ? 0 : res.code }); next(i + 1); });',
  '};',
  'next(0);',
];
const O = '{{ordersUrl}}';
const order = (customerId: string, total: number) => ({ customerId, total, currency: 'USD' });
request(100, 'D0. Orders - list what the agent will see', 'GET', '/orders', 'The live Orders API, reached through the Fabric route /api (gateway key required; the fake API runs on AWS). Shows the data the agent reviews.', undefined, undefined, O);
request(150, 'D1. Orders - RESET to ord-001 and ord-002', 'GET', '/orders', 'DESTRUCTIVE on the demo API: deletes every order except ord-001 and ord-002 (it lists them, then deletes the rest). Use it to start a demo from a clean state.', undefined, resetScript, O);
request(200, 'D2. Orders - new normal order', 'POST', '/orders', 'A routine order: should NOT be flagged.', order('usr-002', 64.9), undefined, O);
request(300, 'D3. Orders - new high-value order', 'POST', '/orders', 'Over $10,000: the agent should flag it (policy: high value).', order('usr-001', 15250), undefined, O);
request(400, 'D4. Orders - new order from an unknown customer', 'POST', '/orders', 'Customer is not in the Users API: the agent should flag it.', order('usr-unknown-' + 'x9', 80), undefined, O);
request(500, 'D5. Orders - repeated order (send it 3 times)', 'POST', '/orders', 'Send this three times: 3 identical orders from the same customer get flagged.', order('usr-003', 42), undefined, O);
request(1000, '0. What does each arm change', 'GET', '/arms', 'Plain-English description of every arm and whether it is configured on this server.');
arms.forEach(([key, arm, name, desc, extra], i) => request(2000 + i * 1000, name, 'POST', '/review', desc, { arm, ...extra, live: false }, test(key, key)));
request(7000, '8. Compare arms', 'GET', '/arms', 'Open the Visualize tab: a table built from the runs above.', undefined, compareTest);
request(8000, '9. LIVE - fire the Postman webhook', 'POST', '/review', 'Only for the show-and-tell. Sends one alert per fraudulent order to the Flow webhook (Idempotency-Key header).', { arm: 'F', live: true });
console.log('written', dir);
