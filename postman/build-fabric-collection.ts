/**
 * Generates the "Fabric features" Postman collection (no agent involved). Run: bun postman/build-fabric-collection.ts
 * Regenerates every request except the hand-written 2a, 4a-4e and 11a-11e (they hold long prompts and are edited in place).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, 'collections', 'Fabric features');
mkdirSync(join(dir, '.resources'), { recursive: true });
for (const f of readdirSync(dir)) if (f.endsWith('.request.yaml') && !/^(2a|4[a-e]|11[a-e])\./.test(f)) rmSync(join(dir, f));

const q = (s: string) => JSON.stringify(s);
const block = (lines: string[], pad: string) => lines.map((l) => pad + l).join('\n');

type Opts = { key?: boolean; header?: Record<string, string>; body?: object; test?: string[] };
function req(order: number, name: string, method: string, path: string, desc: string, o: Opts = {}) {
  const { key = true, header = {}, body, test } = o;
  const h = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(path.includes('/v1/') ? { 'anthropic-version': '2023-06-01' } : {}), ...(key ? { 'fg-api-key': '{{fabricKey}}' } : {}), ...header };
  const y = ['$kind: http-request', `description: ${q(desc)}`, `url: ${q('{{fabricUrl}}' + path)}`, `method: ${method}`];
  if (Object.keys(h).length) y.push('headers:', ...Object.entries(h).map(([k, v]) => `  ${k}: ${q(v)}`));
  if (body) y.push('body:', '  type: json', '  content: |-', block(JSON.stringify(body, null, 2).split('\n'), '    '));
  if (test) y.push('scripts:', '  - type: afterResponse', '    code: |-', block(test, '      '), '    language: text/javascript');
  y.push(`order: ${order}`);
  writeFileSync(join(dir, `${name}.request.yaml`), y.join('\n') + '\n');
}

const MSG = (model: string, content = 'Say hi', extra = {}) => ({ model, max_tokens: 40, messages: [{ role: 'user', content }], ...extra });
const status = (code: number) => [`pm.test('HTTP ${code}', () => pm.response.to.have.status(${code}));`];
const modelIs = (re: string, label: string) => [
  `pm.test('${label}', () => pm.expect(pm.response.json().model).to.match(${re}));`,
  `pm.test('HTTP 200', () => pm.response.to.have.status(200));`,
];

// 1. Entry point and authentication
req(1000, '1a. Entry point - valid gateway key', 'GET', '/anthropic/v1/models', 'The caller holds only a Fabric gateway key (fg-api-key). Fabric holds the real Anthropic key in its vault and adds it upstream. Expect 200.', { test: status(200) });
req(1100, '1b. Entry point - no key is refused', 'GET', '/anthropic/v1/models', 'Same call without a key. Fabric refuses it before it reaches Anthropic. Expect 401.', { key: false, test: status(401) });
req(1200, '1c. Entry point - Bearer is not accepted on LLM routes', 'GET', '/anthropic/v1/models', 'LLM routes read the key from fg-api-key only; Authorization: Bearer gives 401. A common first mistake, worth knowing.', { key: false, header: { Authorization: 'Bearer {{fabricKey}}' }, test: status(401) });
req(1300, '1d. Entry point - an internal API behind the same key', 'GET', '/api/orders', 'The Orders API through the Fabric route /api. Same gateway key; Fabric adds the API key upstream. The agent and any other client get one way in.', { test: status(200) });

// 2. Model control (2a is hand-written)
req(2150, '2b. Transformer - streaming also works', 'POST', '/anthropic-economy/v1/messages', 'Route anthropic-economy has a Transformer plugin (body_set model = claude-haiku-4-5-20251001), matched on POST /anthropic-economy/v1/messages only. Streaming requests are rewritten too: see the model in the message_start event.', { body: MSG('claude-opus-5-5', 'Count from 1 to 5.', { stream: true }), test: ['pm.test("HTTP 200", () => pm.response.to.have.status(200));', 'pm.test("Served by Haiku", () => pm.expect(pm.response.text()).to.include("claude-haiku-4-5"));'] });

// 3. Model allowlist
req(3000, '3a. Allowlist - Haiku is allowed', 'POST', '/anthropic-select/v1/messages', 'Route anthropic-select only lets the service models in its allowlist through. Haiku and Sonnet pass.', { body: MSG('claude-haiku-4-5-20251001'), test: status(200) });
req(3100, '3b. Allowlist - Opus is refused', 'POST', '/anthropic-select/v1/messages', 'Same route, a model that is not in the allowlist. Fabric answers 400 and nothing reaches Anthropic: cost control and governance by route.', { body: MSG('claude-opus-4-5'), test: status(400) });

// 5. Cost side by side
const costTest = (label: string) => [
  'const r = pm.response.json(); const u = r.usage || {};',
  'const P = [["claude-haiku-4-5", 1, 5], ["claude-sonnet-4-5", 3, 15]]; // USD per million tokens (list price)',
  'const p = P.find(x => String(r.model).startsWith(x[0]));',
  'const cost = p ? (u.input_tokens * p[1] + u.output_tokens * p[2]) / 1e6 : null;',
  `pm.collectionVariables.set("cost_${label}", JSON.stringify({ route: "${label}", model: r.model, inTok: u.input_tokens, outTok: u.output_tokens, cost }));`,
  'pm.test("HTTP 200", () => pm.response.to.have.status(200));',
];
const PROMPT = 'Explain in about 150 words why an API gateway helps when many teams call the same LLM.';
req(5000, '5a. Cost - same prompt, anthropic route (Sonnet 4.5)', 'POST', '/anthropic/v1/messages', 'The same prompt on three routes. This one is the baseline: Sonnet 4.5.', { body: MSG('claude-sonnet-4-5', PROMPT, { max_tokens: 300 }), test: costTest('anthropic') });
req(5100, '5b. Cost - same prompt, economy route (Haiku 4.5)', 'POST', '/anthropic-economy/v1/messages', 'Same prompt and the same request body asking for Sonnet; the Transformer rewrites it to Haiku. No client change.', { body: MSG('claude-sonnet-4-5', PROMPT, { max_tokens: 300 }), test: costTest('anthropic-economy') });
req(5200, '5c. Cost - compare', 'GET', '/anthropic/v1/models', 'Run 5a and 5b first, then open Visualize. Prices are list prices (Sonnet 4.5 $3/$15, Haiku 4.5 $1/$5 per million tokens), the same estimate Fabric shows in Traces.', {
  test: [
    'const rows = ["anthropic", "anthropic-economy"].map(k => { try { return JSON.parse(pm.collectionVariables.get("cost_" + k)); } catch (e) { return null; } }).filter(Boolean);',
    'const base = rows[0];',
    'const tr = rows.map(x => `<tr><td>${x.route}</td><td>${x.model}</td><td>${x.inTok}</td><td>${x.outTok}</td><td>$${x.cost == null ? "?" : x.cost.toFixed(5)}</td><td>${base && base.cost && x.cost != null ? ((x.cost / base.cost - 1) * 100).toFixed(0) + "%" : ""}</td></tr>`).join("");',
    'pm.visualizer.set(`<style>body{font-family:sans-serif;font-size:14px}td,th{padding:4px 12px;text-align:right}th:first-child,td:first-child{text-align:left}</style><h3>Same prompt, two routes</h3><table><tr><th>Route</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th><th>vs baseline</th></tr>${tr}</table>`);',
  ],
});


// 6. Rate limit (needs a route with the rate-limit plugin: 1 request per minute)
req(6000, '6a. Rate limit - first request passes', 'POST', '{{rateLimitRoute}}/v1/messages', 'Route anthropic-ratelimit has the rate-limit plugin: 1 request per 60 s, counted per consumer (key). The first call is served. If you get 429 here, wait a minute: the window is rolling. Tested 2026-10-21: calls 2+ get 429 (the plugin took a few seconds to apply after saving).', { body: MSG('claude-haiku-4-5-20251001'), test: status(200) });
req(6100, '6b. Rate limit - second request is refused', 'POST', '{{rateLimitRoute}}/v1/messages', 'Send it right after 6a. Fabric answers 429 and the call never reaches Anthropic. Wait a minute and it passes again. The counter is not exact: with a limit of 1 per minute, the second call has passed in some runs (once the first two both passed and the third got the 429). In a live demo, send 6b again until it is refused.', { body: MSG('claude-haiku-4-5-20251001'), test: status(429) });

// 7. Token budget (llm-rate-limit on route anthropic-tokenlimit: 200 tokens per 60 s)
const LONG = 'Write about 150 words on why gateways help teams.';
req(7000, '7a. Token budget - first call passes', 'POST', '/anthropic-tokenlimit/v1/messages', 'Route anthropic-tokenlimit has the llm-rate-limit plugin: a budget of 200 tokens per 60 s. This answer uses most of it. Wait a minute between demos.', { body: MSG('claude-haiku-4-5-20251001', LONG, { max_tokens: 300 }), test: status(200) });
req(7100, '7b. Token budget - the next call is refused', 'POST', '/anthropic-tokenlimit/v1/messages', 'Right after 7a. The budget is spent, so Fabric answers 429 "Token budget exhausted" with retry_after, and nothing reaches Anthropic. A cap on spend, not just on request count.', { body: MSG('claude-haiku-4-5-20251001', LONG, { max_tokens: 300 }), test: ['pm.test("HTTP 429", () => pm.response.to.have.status(429));', 'pm.test("Says the token budget is exhausted", () => pm.expect(pm.response.text()).to.include("Token budget exhausted"));'] });

// 8. Required header (validator on route anthropic-validated)
req(8000, '8a. Validator - missing X-Team header is refused', 'POST', '/anthropic-validated/v1/messages', 'Route anthropic-validated has the validator plugin: every request must carry an X-Team header, so each call can be charged to a team. Without it Fabric answers 422.', { body: MSG('claude-haiku-4-5-20251001'), test: status(422) });
req(8100, '8b. Validator - with X-Team it passes', 'POST', '/anthropic-validated/v1/messages', 'Same request with X-Team: payments. Expect 200.', { header: { 'X-Team': 'payments' }, body: MSG('claude-haiku-4-5-20251001'), test: status(200) });

// 9. PII redaction (pii-redaction on route anthropic-pii, default action Mask)
const PII = 'In one short sentence, say what domain the email address in this text uses and what the last four digits of the card are. Text: contact ana@example.com, card 4111 1111 1111 1111.';
req(9000, '9a. PII - without redaction the model sees the data', 'POST', '/anthropic/v1/messages', 'Control: a normal route. The model reads the email and the card number: "example.com" and "1111".', { body: MSG('claude-haiku-4-5-20251001', PII, { max_tokens: 80 }), test: ['pm.test("HTTP 200", () => pm.response.to.have.status(200));', 'pm.test("Model saw the real values", () => pm.expect(pm.response.text()).to.include("example.com"));'] });
req(9100, '9b. PII - with redaction the model never sees it', 'POST', '/anthropic-pii/v1/messages', 'Same prompt through anthropic-pii (pii-redaction plugin, Mask). Fabric replaces the email and the card number with [EMAIL] and [CREDIT_CARD] before the request leaves, so the model says it only sees placeholders.', { body: MSG('claude-haiku-4-5-20251001', PII, { max_tokens: 80 }), test: ['pm.test("HTTP 200", () => pm.response.to.have.status(200));', 'pm.test("The real email never reached the model", () => pm.expect(pm.response.text()).to.not.include("example.com"));'] });

// 10. Fallback (llm-router, mode fallback, on route anthropic-fallback: anthropic-broken first, then anthropic)
req(10000, '10a. Fallback - the broken provider on its own', 'POST', '/anthropic-broken/v1/messages', 'Service anthropic-broken has an invalid Anthropic key, standing in for a provider outage. Called directly it returns 401 invalid x-api-key.', { body: MSG('claude-haiku-4-5-20251001'), test: status(401) });
req(10100, '10b. Fallback - same call through the fallback route', 'POST', '/anthropic-fallback/v1/messages', 'Route anthropic-fallback has the llm-router plugin in fallback mode: it tries anthropic-broken first, gets 401 and moves to anthropic. The caller gets a 200 and never sees the failure. Open the trace to see both attempts.', { body: MSG('claude-haiku-4-5-20251001'), test: status(200) });

writeFileSync(join(dir, '.resources', 'definition.yaml'), [
  '$kind: collection',
  'description: >-',
  '  Fabric features, with no agent involved: one entry point and one gateway key, model control with the Transformer plugin, a model allowlist,',
  '  the adaptive model router, cost side by side, traces, and rate limiting. Set fabricKey (a Fabric consumer key) and run the requests in order.',
  '  Each request has a test, so the Collection Runner shows what Fabric did. MCP route and tool control will be added once the plugin is available.',
  'variables:',
  '  fabricUrl: https://david-esp-s-fabric-team.dp.fabricgateway.ai',
  '  fabricKey: ""',
  '  rateLimitRoute: /anthropic-ratelimit',
  '  cost_anthropic: ""',
  '  cost_anthropic-economy: ""',
].join('\n') + '\n');
console.log('written', dir);
