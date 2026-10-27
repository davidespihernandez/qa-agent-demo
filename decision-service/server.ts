// Deterministic decision service for Fabric's adaptive-model-router.
// It speaks the Jev "decisions" shape (state + questions in, typed answers out) but decides with plain rules, no LLM.
// Every request is logged (and kept in memory) so we can see exactly what the plugin sends.
const PORT = Number(process.env.PORT ?? 80);
const DEBUG_KEY = process.env.DEBUG_KEY ?? '';
const seen: unknown[] = [];

const OPUS_WORDS = ['architecture', 'design a', 'refactor', 'prove', 'step by step', 'migrate', 'trade-off'];
const SONNET_WORDS = ['review', 'fraud', 'analy', 'orders', 'report', 'summar', 'classif', 'extract', 'code', 'flag'];

/** Pick haiku, sonnet or opus from the text of the request. */
export function pickModel(text: string): 'haiku' | 'sonnet' | 'opus' {
  const t = text.toLowerCase();
  if (t.length > 8000 || OPUS_WORDS.some((w) => t.includes(w))) return 'opus';
  if (t.length > 400 || SONNET_WORDS.some((w) => t.includes(w))) return 'sonnet';
  return 'haiku';
}

function answer(q: any, text: string) {
  if (q?.type === 'choice') {
    const options = Object.keys(q.criteria ?? {});
    const wanted = pickModel(text);
    const choice = options.includes(wanted) ? wanted : options[0];
    const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0]));
    return { type: 'choice', choice, confidence: 1, probabilities };
  }
  if (q?.type === 'score') {
    const points: string[] = Array.isArray(q.criteria) ? q.criteria : [];
    const idx = pickModel(text) === 'haiku' ? 0 : pickModel(text) === 'sonnet' ? Math.min(1, points.length - 1) : points.length - 1;
    return {
      type: 'score',
      score: Math.max(idx, 0),
      confidence: 1,
      probabilities: Object.fromEntries(points.map((_, i) => [String(i), i === idx ? 1 : 0])),
      legend: Object.fromEntries(points.map((p, i) => [String(i), p])),
    };
  }
  return { type: 'noul', noul: pickModel(text) === 'haiku' ? 0 : 1 };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/debug/requests') {
      if (DEBUG_KEY && req.headers.get('x-debug-key') !== DEBUG_KEY) return new Response('forbidden', { status: 403 });
      return Response.json(seen);
    }
    const raw = await req.text();
    const headers = Object.fromEntries([...req.headers].filter(([k]) => !/^(authorization|x-api-key|cookie)$/i.test(k)));
    let body: any = null;
    try { body = JSON.parse(raw); } catch { /* keep raw */ }
    const entry = { at: new Date().toISOString(), method: req.method, path: url.pathname + url.search, headers, body: body ?? raw };
    seen.push(entry);
    if (seen.length > 50) seen.shift();
    console.log(JSON.stringify(entry));
    if (!body?.questions) return Response.json({ error: 'expected {state, questions}' }, { status: 400 });
    const text = typeof body.state === 'string' ? body.state : JSON.stringify(body.state ?? '');
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answer(q, text)]));
    return Response.json({
      id: 'gen-dec-' + crypto.randomUUID(),
      model: body.model ?? 'rules-1',
      provider: 'rules',
      answers,
      usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
    });
  },
});
console.log('decision-service listening on', PORT);
