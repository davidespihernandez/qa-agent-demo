// MCP server for the Orders / Users / Payments APIs, over plain HTTP (stateless JSON-RPC, MCP "streamable HTTP" without SSE).
// It stands in for Fabric's mcp-http-bridge: each OpenAPI operation becomes one MCP tool, and a tool call becomes the HTTP call.
//   POST /mcp           all 21 tools
//   POST /mcp/readonly  only the GET tools (8)
//   GET  /health
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 80);
const API_BASE_URL = (process.env.API_BASE_URL || 'https://18-157-170-15.nip.io').replace(/\/+$/, '');
// When set, callers must send it in the x-api-key header (Fabric adds it as the connection's upstream credential).
const MCP_API_KEY = process.env.MCP_API_KEY ?? '';

// bridge-tools.json: tool names, descriptions and input schemas. demo-apis.json: the OpenAPI spec they were built from.
type Tool = { name: string; description: string; inputSchema: any };
const tools: Tool[] = JSON.parse(readFileSync(join(import.meta.dir, 'specs', 'bridge-tools.json'), 'utf8'));
const spec = JSON.parse(readFileSync(join(import.meta.dir, 'specs', 'demo-apis.json'), 'utf8'));
const ops = new Map<string, { path: string; method: string }>();
for (const [path, item] of Object.entries<any>(spec.paths ?? {}))
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const id = item?.[method]?.operationId;
    if (id) ops.set(id, { path, method });
  }
const readOnly = tools.filter((t) => ops.get(t.name)?.method === 'get');
const known = tools.filter((t) => ops.has(t.name));

/** Turn one tool call into the HTTP call: {id} goes in the path, the rest is the query (GET) or the JSON body. */
async function callTool(name: string, args: Record<string, any>, allowed: Tool[]) {
  const op = ops.get(name);
  if (!op || !allowed.some((t) => t.name === name)) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  const rest = { ...args };
  const url = op.path.replace(/\{(\w+)\}/g, (_, k) => {
    const v = rest[k];
    delete rest[k];
    return encodeURIComponent(String(v));
  });
  const isGet = op.method === 'get';
  const qs = isGet && Object.keys(rest).length ? '?' + new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])) : '';
  const res = await fetch(API_BASE_URL + url + qs, {
    method: op.method.toUpperCase(),
    headers: isGet || op.method === 'delete' ? undefined : { 'Content-Type': 'application/json' },
    body: isGet || op.method === 'delete' ? undefined : JSON.stringify(rest),
  });
  const text = await res.text();
  console.log(`tools/call ${name} -> HTTP ${res.status}`);
  return { isError: !res.ok, content: [{ type: 'text', text: res.ok ? text : `HTTP ${res.status}: ${text}` }] };
}

async function rpc(msg: any, allowed: Tool[]) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'orders-mcp', version: '1.0.0' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: allowed });
    case 'tools/call':
      return reply(await callTool(msg.params?.name, msg.params?.arguments ?? {}, allowed));
    default:
      return msg.id === undefined ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/health') return Response.json({ ok: true, tools: known.length, readOnlyTools: readOnly.length, apiBaseUrl: API_BASE_URL });
    const allowed = pathname === '/mcp' ? known : pathname === '/mcp/readonly' ? readOnly : null;
    if (req.method !== 'POST' || !allowed) return Response.json({ error: 'Not found' }, { status: 404 });
    if (MCP_API_KEY && req.headers.get('x-api-key') !== MCP_API_KEY) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body: any = await req.json().catch(() => null);
    if (!body) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
    const out = Array.isArray(body) ? (await Promise.all(body.map((m) => rpc(m, allowed)))).filter(Boolean) : await rpc(body, allowed);
    return out === null || (Array.isArray(out) && !out.length) ? new Response(null, { status: 202 }) : Response.json(out);
  },
});
console.log(`orders-mcp on :${PORT}, ${known.length} tools (${readOnly.length} read-only), API ${API_BASE_URL}, auth ${MCP_API_KEY ? 'on' : 'off'}`);
