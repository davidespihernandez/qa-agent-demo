/** Generates fraud-agent.postman_collection.json (run: bun postman/build-collection.ts). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const arms = [
  ['A', 'A · Direct to Anthropic', 'The agent calls Anthropic and the APIs itself. Nothing in between: the baseline.'],
  ['B', 'B · Through Fabric', 'Same agent, same task. LLM and API tools now go through Fabric: gateway key, traces, governance. Expect ~the same tokens.'],
  ['B-ro', 'B-ro · Fabric, read-only tools', 'Fabric exposes only the 8 GET operations to this agent. Fewer tool definitions per call, and it cannot write even if it wanted to.'],
  ['C', 'C · Fabric + Tool Search', 'Fabric hides the catalog behind a search tool; the model fetches only the tools it needs.'],
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

const item = (name: string, method: string, path: string, desc: string, body?: object, events: string[] = []) => ({
  name,
  event: events.length ? [{ listen: 'test', script: { type: 'text/javascript', exec: events } }] : [],
  request: {
    method,
    header: [
      { key: 'Content-Type', value: 'application/json' },
      { key: 'x-demo-key', value: '{{demoKey}}', disabled: false },
    ],
    url: { raw: `{{baseUrl}}${path}`, host: ['{{baseUrl}}'], path: path.split('/').filter(Boolean) },
    description: desc,
    ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2) } } : {}),
  },
});

const collection = {
  info: {
    name: 'Fraud agent: arms',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description:
      'Runs the same fraud-review agent through each path. Only the arm changes. Run the requests in order (or the whole folder with the Collection Runner), then open "Compare arms" and its Visualize tab. dryRun by default: the webhook is not called.',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:8787' },
    { key: 'demoKey', value: '' },
  ],
  item: [
    item('What does each arm change?', 'GET', '/arms', 'Plain-English description of every arm and whether it is configured on this server.'),
    {
      name: 'Run the arms',
      item: arms.map(([arm, name, desc]) => item(name, 'POST', '/review', desc, { arm, live: false }, test(arm))),
    },
    item('Compare arms', 'GET', '/arms', 'Open the Visualize tab: a table built from the runs above.', undefined, compareTest),
    item('LIVE: A run that fires the Postman webhook', 'POST', '/review', 'Only for the show-and-tell. Sends one alert per fraudulent order to the Flow webhook (Idempotency-Key header).', { arm: 'B', live: true }),
  ],
};

writeFileSync(join(import.meta.dir, 'fraud-agent.postman_collection.json'), JSON.stringify(collection, null, 2));
console.log('written');
