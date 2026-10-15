/**
 * HTTP front door for the fraud agent, so it can be called from a Postman collection (or curl).
 *
 *   bun agent/agent/server.ts            # from the repo root, so .env is loaded; PORT defaults to 8787
 *
 *   GET  /health
 *   GET  /arms                           what each arm changes
 *   POST /review {"arm":"B","live":false,"maxSteps":40}   -> 202 {runId, statusUrl}; a review takes 20-60 s,
 *                                                             longer than gateways and proxies wait, so it runs in the background
 *   GET  /runs/{runId}                                       -> {status:"running"} or the finished result
 *   (add "wait": true to POST /review to hold the connection and get the result directly, for local use)
 *
 * `live: false` (default) never calls the webhook. Set DEMO_API_KEY to require `x-demo-key` on /review.
 */

import { randomUUID } from 'node:crypto';
import { ARMS, armConfig, isArm, runReview } from './review';

const port = Number(process.env.PORT ?? 8787);
const demoKey = process.env.DEMO_API_KEY || undefined;
let busy = false; // one review at a time: keeps traces readable and cost predictable
const runs = new Map<string, any>(); // finished and running reviews, in memory

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

Bun.serve({
  port,
  idleTimeout: 255, // seconds; a review takes 20-60 s
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'GET' && pathname === '/health') return json({ ok: true });
    if (req.method === 'GET' && pathname === '/arms') {
      return json(
        Object.entries(ARMS).map(([arm, a]) => ({ arm, ...a, configured: arm === 'A' || !!process.env[a.env!] })),
      );
    }
    if (req.method === 'POST' && pathname === '/review') {
      if (demoKey && req.headers.get('x-demo-key') !== demoKey) return json({ error: 'Missing or wrong x-demo-key' }, 401);
      const body: any = await req.json().catch(() => ({}));
      const arm = String(body.arm ?? 'A');
      if (!isArm(arm)) return json({ error: `Unknown arm "${arm}". Use one of: ${Object.keys(ARMS).join(', ')}` }, 400);
      let cfg;
      try {
        cfg = armConfig(arm);
      } catch (e: any) {
        return json({ error: e.message }, 400);
      }
      if (busy) return json({ error: 'A review is already running, try again in a minute.' }, 409);
      busy = true;
      const id = randomUUID();
      const work = (async () => {
        try {
          const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Review timed out after 240 s')), 240_000));
          const { record, truth } = await Promise.race([runReview(arm, cfg, { live: body.live === true, maxSteps: Number(body.maxSteps ?? 40) }), timeout]);
          return { ...ARMS[arm], ...record, truth, status: 'done', runId: id };
        } catch (e: any) {
          return { arm, status: 'error', error: String(e?.message ?? e), runId: id };
        } finally {
          busy = false;
        }
      })();
      runs.set(id, { status: 'running', arm });
      work.then((r) => runs.set(id, r));
      if (body.wait === true) return json(await work);
      return json({ runId: id, arm, status: 'running', statusUrl: `/runs/${id}` }, 202);
    }
    if (req.method === 'GET' && pathname === '/diag') {
      // Times each network hop from wherever this server runs (useful on Astro, where we cannot curl from the pod).
      if (demoKey && req.headers.get('x-demo-key') !== demoKey) return json({ error: 'Missing or wrong x-demo-key' }, 401);
      const hop = async (name: string, url: string | undefined, init: RequestInit = {}) => {
        if (!url) return { name, skipped: true };
        const t = Date.now();
        try {
          const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
          return { name, status: r.status, ms: Date.now() - t };
        } catch (e: any) {
          return { name, error: String(e?.message ?? e), ms: Date.now() - t };
        }
      };
      const key = process.env.FABRIC_GATEWAY_KEY ?? '';
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'diag', version: '0' } } };
      const api = process.env.API_BASE_URL || 'https://18-157-170-15.nip.io';
      return json(await Promise.all([
        hop('orders api /health', api + '/health'),
        hop('fabric mcp initialize', process.env.MCP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', [process.env.FABRIC_KEY_HEADER || 'fg-api-key']: key }, body: JSON.stringify(init) }),
        hop('fabric llm route (no auth, expect 401/404)', process.env.LLM_BASE_URL ? process.env.LLM_BASE_URL + '/v1/models' : undefined),
        hop('anthropic direct (expect 401)', 'https://api.anthropic.com/v1/models'),
      ]));
    }
    const m = pathname.match(/^\/runs\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      if (demoKey && req.headers.get('x-demo-key') !== demoKey) return json({ error: 'Missing or wrong x-demo-key' }, 401);
      const r = runs.get(m[1]);
      return r ? json(r) : json({ error: 'Unknown run id' }, 404);
    }
    return json({ error: 'Not found. Try GET /arms or POST /review' }, 404);
  },
});

console.log(`Fraud agent HTTP server on :${port}  (POST /review, GET /arms)`);
