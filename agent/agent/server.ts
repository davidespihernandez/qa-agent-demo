/**
 * HTTP front door for the fraud agent, so it can be called from a Postman collection (or curl).
 *
 *   bun agent/agent/server.ts            # from the repo root, so .env is loaded; PORT defaults to 8787
 *
 *   GET  /health
 *   GET  /arms                           what each arm changes
 *   POST /review {"arm":"B","live":false,"maxSteps":40}
 *
 * `live: false` (default) never calls the webhook. Set DEMO_API_KEY to require `x-demo-key` on /review.
 */

import { ARMS, armConfig, isArm, runReview } from './review';

const port = Number(process.env.PORT ?? 8787);
const demoKey = process.env.DEMO_API_KEY || undefined;
let busy = false; // one review at a time: keeps traces readable and cost predictable

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

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
      try {
        const { record, truth } = await runReview(arm, cfg, { live: body.live === true, maxSteps: Number(body.maxSteps ?? 40) });
        return json({ ...ARMS[arm], ...record, truth });
      } finally {
        busy = false;
      }
    }
    return json({ error: 'Not found. Try GET /arms or POST /review' }, 404);
  },
});

console.log(`Fraud agent HTTP server on :${port}  (POST /review, GET /arms)`);
