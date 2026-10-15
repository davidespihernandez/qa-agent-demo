/** Generates the Postman v3 (YAML) collection in postman/collections/ (run: bun postman/build-collection.ts). */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arms = [
  ['A', '1. A - Direct to Anthropic', 'The agent calls Anthropic and the APIs itself. Nothing in between: the baseline.'],
  ['B', '2. B - Through Fabric', 'Same agent, same task. LLM and API tools now go through Fabric: gateway key, traces, governance. Expect ~the same tokens.'],
  ['B-ro', '3. B-ro - Fabric, read-only tools', 'Fabric exposes only the 8 GET operations to this agent. Fewer tool definitions per call, and it cannot write even if it wanted to.'],
  ['C', '4. C - Fabric + Tool Search', 'Fabric hides the catalog behind a search tool; the model fetches only the tools it needs.'],
];

const test = (arm: string) => [
  'const r = pm.response.json();',
  `pm.test('Agent flagged exactly the right orders', () => pm.expect(r.verdict).to.eql('pass'));`,
  `pm.collectionVariables.set('res_${arm}', JSON.stringify({ arm: r.arm, verdict: r.verdict, tools: r.toolCount, steps: r.steps,`,
  '  inTok: r.usage && r.usage.inputTokens, outTok: r.usage && r.usage.outputTokens, cost: r.estimatedCostUsd, sec: Math.round(r.ms / 1000) }));',
  'const t = `<style>body{font-family:sans-serif;font-size:14px}td,th{padding:4px 10px;text-align:right}th:first-child,td:first-child{text-align:left}</style>',
  '<h3>Arm ${r.arm}: ${r.title}</h3><p>${r.llm}<br>${r.tools}</p>',
  '<table><tr><th>Verdict</th><th>Tools sent</th><th>Steps</th><th>Input tokens</th><th>Output tokens</th><th>Est. cost</th><th>Time</th></tr>',
  '<tr><td>${r.verdict}</td><td>${r.toolCount}</td><td>${r.steps}</td><td>${r.usage && r.usage.inputTokens}</td><td>${r.usage && r.usage.outputTokens}</td><td>$${r.estimatedCostUsd && r.estimatedCostUsd.toFixed(3)}</td><td>${Math.round(r.ms/1000)}s</td></tr></table>`;',
  'pm.visualizer.set(t);',
];

const compareTest = [
  'const rows = ["A","B","B-ro","C"].map(a => { try { return JSON.parse(pm.collectionVariables.get("res_" + a)); } catch (e) { return null; } }).filter(Boolean);',
  'const base = rows.find(x => x.arm === "A");',
  'const d = x => base && base.inTok ? ((x.inTok / base.inTok - 1) * 100).toFixed(1) + "%" : "";',
  'const tr = rows.map(x => `<tr><td>${x.arm}</td><td>${x.verdict}</td><td>${x.tools}</td><td>${x.inTok}</td><td>${d(x)}</td><td>${x.outTok}</td><td>$${x.cost.toFixed(3)}</td><td>${x.sec}s</td></tr>`).join("");',
  'pm.visualizer.set(`<style>body{font-family:sans-serif;font-size:14px}td,th{padding:4px 12px;text-align:right}th:first-child,td:first-child{text-align:left}</style><h3>Same agent, same task: what changed per arm</h3><table><tr><th>Arm</th><th>Verdict</th><th>Tools sent</th><th>Input tokens</th><th>vs A</th><th>Output</th><th>Est. cost</th><th>Time</th></tr>${tr}</table>`);',
];

const dir = join(import.meta.dir, 'collections', 'Fraud agent - arms');
rmSync(dir, { recursive: true, force: true });
mkdirSync(join(dir, '.resources'), { recursive: true });

const q = (s: string) => JSON.stringify(s); // JSON strings are valid YAML scalars
const block = (lines: string[], pad: string) => lines.map((l) => pad + l).join('\n');

function request(order: number, name: string, method: string, path: string, desc: string, body?: object, script?: string[]) {
  const y = [
    '$kind: http-request',
    `description: ${q(desc)}`,
    `url: ${q('{{baseUrl}}' + path)}`,
    `method: ${method}`,
    'headers:',
    '  Content-Type: application/json',
    '  x-demo-key: "{{demoKey}}"',
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
    '  (or use the Collection Runner), then open "Compare arms" and its Visualize tab. Dry run by default: the webhook is not called.',
    'variables:',
    '  baseUrl: http://localhost:8787',
    '  demoKey: ""',
  ].join('\n') + '\n',
);

request(1000, '0. What does each arm change', 'GET', '/arms', 'Plain-English description of every arm and whether it is configured on this server.');
arms.forEach(([arm, name, desc], i) => request(2000 + i * 1000, name, 'POST', '/review', desc, { arm, live: false }, test(arm)));
request(7000, '5. Compare arms', 'GET', '/arms', 'Open the Visualize tab: a table built from the runs above.', undefined, compareTest);
request(8000, '6. LIVE - fire the Postman webhook', 'POST', '/review', 'Only for the show-and-tell. Sends one alert per fraudulent order to the Flow webhook (Idempotency-Key header).', { arm: 'B', live: true });
console.log('written', dir);
