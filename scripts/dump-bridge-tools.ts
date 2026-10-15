/**
 * Save the tool list Fabric's MCP HTTP bridge exposes (name, description, input schema) to
 * agent/agent/specs/bridge-tools.json. Arm A builds its in-process tools from that file so every arm
 * shows the model identical tool definitions.   bun --env-file=.env scripts/dump-bridge-tools.ts
 */
import { writeFileSync } from 'node:fs';
const U = process.env.MCP_URL!, K = process.env.FABRIC_GATEWAY_KEY!;
async function post(body: any, sid?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [process.env.FABRIC_KEY_HEADER || 'fg-api-key']: K };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(U, { method: 'POST', headers: h, body: JSON.stringify(body) });
  let t = await r.text();
  if (t.includes('data:')) t = t.split('\n').find((l) => l.startsWith('data:'))!.slice(5);
  return { sid: r.headers.get('mcp-session-id') ?? sid, json: t ? JSON.parse(t) : null };
}
const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid!);
const { json } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid!);
const tools = json.result.tools;
writeFileSync('agent/agent/specs/bridge-tools.json', JSON.stringify(tools, null, 1));
console.log(tools.length, 'tools; total chars', JSON.stringify(tools).length);
for (const t of tools.filter((x: any) => ['createOrder', 'getUser', 'listOrders'].includes(x.name))) console.log(JSON.stringify(t).slice(0, 700));
process.exit(0);
