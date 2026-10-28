// Deterministic decision service for Fabric's adaptive-model-router.
// It speaks the Jev "decisions" shape (state + questions in, typed answers out) but decides with plain rules, no LLM.
// Every request is logged (and kept in memory) so we can see exactly what the plugin sends.
const PORT = Number(process.env.PORT ?? 80);
const DEBUG_KEY = process.env.DEBUG_KEY ?? '';
const seen: any[] = [];
// Debug only: force individual answers ({tier, deep_reasoning, underspecified, blast_radius}) to see what the plugin reacts to. Reset with {}.
let override: Record<string, any> = {};

type Tier = 'fast' | 'balanced' | 'advanced' | 'reasoning';
const REASONING_WORDS = ['prove', 'step by step', 'multi-step', 'trade-off', 'tradeoff', 'plan the'];
const ADVANCED_WORDS = ['architecture', 'design a', 'refactor', 'migrate'];
const BALANCED_WORDS = ['review', 'fraud', 'analy', 'orders', 'report', 'summar', 'classif', 'extract', 'flag'];

/** What the router sends in `state`: the request text plus a few facts about it. */
function read(state: any) {
  const text = typeof state === 'string' ? state : String(state?.request ?? JSON.stringify(state ?? ''));
  const c = typeof state === 'object' && state ? state.context ?? {} : {};
  return { text: text.toLowerCase(), c };
}

/** Pick a tier from plain rules, no LLM: the same prompt always gets the same tier. */
export function pickTier(state: any): Tier {
  const { text, c } = read(state);
  // Never return 'reasoning': the plugin maps it to a fourth model that the demo workspace cannot call. 'advanced' is Opus.
  if (text.length > 8000 || REASONING_WORDS.some((w) => text.includes(w))) return 'advanced';
  if (c.has_code || c.is_long_context || ADVANCED_WORDS.some((w) => text.includes(w))) return 'advanced';
  if (c.needs_structured_output || c.has_tools || text.length > 400 || BALANCED_WORDS.some((w) => text.includes(w))) return 'balanced';
  return 'fast';
}

function answer(key: string, q: any, state: any) {
  const tier: Tier = override.tier ?? pickTier(state);
  if (q?.type === 'choice') {
    const options = Object.keys(q.criteria ?? {});
    const choice = options.includes(tier) ? tier : options[0];
    return { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 1 : 0])) };
  }
  if (q?.type === 'score') {
    const points: string[] = Array.isArray(q.criteria) ? q.criteria : [];
    const idx = override[key] ?? Math.min({ fast: 0, balanced: 1, advanced: 2, reasoning: 2 }[tier], Math.max(points.length - 1, 0));
    return {
      type: 'score',
      score: idx,
      confidence: 1,
      probabilities: Object.fromEntries(points.map((_, i) => [String(i), i === idx ? 1 : 0])),
      legend: Object.fromEntries(points.map((p, i) => [String(i), p])),
    };
  }
  // yes/no questions: only deep_reasoning follows the tier, nothing else is ever "underspecified"
  if (override[key] !== undefined) return { type: 'noul', noul: override[key] };
  const yes = key === 'deep_reasoning' ? (tier === 'reasoning' ? 0.95 : tier === 'advanced' ? 0.5 : 0.05) : 0.05;
  return { type: 'noul', noul: yes };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    if (url.pathname === '/debug/override' && req.method === 'POST') {
      if (DEBUG_KEY && req.headers.get('x-debug-key') !== DEBUG_KEY) return new Response('forbidden', { status: 403 });
      override = await req.json();
      return Response.json(override);
    }
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
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, answer(k, q, body.state)]));
    // Exactly the documented Jev response: model, answers, usage (no extra fields, a strict parser may reject them).
    const reply = { model: body.model ?? 'rules-1', answers, usage: { input_tokens: 0, output_tokens: 0 } };
    entry.reply = reply;
    return Response.json(reply);
  },
});
console.log('decision-service listening on', PORT);
