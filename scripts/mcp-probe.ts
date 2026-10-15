/**
 * Probe a Fabric MCP route without touching any file: lists the tools it serves and, optionally, runs a tool search.
 *   bun --env-file=.env scripts/mcp-probe.ts <mcp-url> ["search query"]
 * Tool Search routes show only meta-tools (search_tool, get_tool, execute_tool); a query exercises the embedder.
 */
const U = process.argv[2], Q = process.argv[3], K = process.env.FABRIC_GATEWAY_KEY!;
if (!U) throw new Error('usage: mcp-probe.ts <mcp-url> ["query"]');
async function post(body: any, sid?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'fg-api-key': K };
  if (sid) h['mcp-session-id'] = sid;
  const r = await fetch(U, { method: 'POST', headers: h, body: JSON.stringify(body) });
  let t = await r.text();
  if (t.includes('data:')) t = t.split('\n').find((l) => l.startsWith('data:'))!.slice(5);
  return { status: r.status, sid: r.headers.get('mcp-session-id') ?? sid, json: t ? JSON.parse(t) : null };
}
const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid!);
const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sid!);
const tools = list.json?.result?.tools ?? [];
console.log(`${tools.length} tools:`, tools.map((t: any) => t.name).join(', ').slice(0, 400), list.json?.error ?? '');
if (Q) {
  const meta = tools.find((t: any) => /search/i.test(t.name));
  if (!meta) throw new Error('No search tool on this route');
  const res = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: meta.name, arguments: { query: Q } } }, init.sid!);
  console.log(JSON.stringify(res.json, null, 1).slice(0, 1500));
}
process.exit(0);
