// Builds the comparison from the results the arm requests stored in collection variables (res_<arm>).
const get = k => { try { return JSON.parse(pm.collectionVariables.get('res_' + k)); } catch (e) { return null; } };
const reqNo = { A: 1, F: 2, 'F-eco': 3, 'F-cheap': 4, B: 5, C: 6 };
const scenarios = [
  { title: 'Scenario 1: same agent, same task, 21 tools. What changes is the path and the model', base: 'A',
    arms: [['A', 'Direct to Anthropic (baseline)'], ['F', 'Through Fabric, same model'], ['F-eco', 'Through Fabric, cheaper model (economy route)'], ['F-cheap', 'Through Fabric, model "cheap" chosen per request']] },
  { title: 'Scenario 2: same agent, same task, a big tool catalog (Orders + GitHub, 67 tools). What changes is how the tools reach the model', base: 'B',
    arms: [['B', 'All 67 tools sent to the model on every step (baseline)'], ['C', 'Tool Search: the model sees 3 tools and searches for the rest']] },
];
const money = c => c == null ? 'n/a' : '$' + c.toFixed(3);
const kt = n => n == null ? '' : (n / 1000).toFixed(1) + 'k';
let html = '<style>body{font-family:sans-serif;font-size:14px}h3{margin:18px 0 6px}table{border-collapse:collapse}td,th{padding:5px 12px;text-align:right;border-bottom:1px solid #ddd}th:first-child,td:first-child,td.l,th.l{text-align:left}.bar{background:#ff6c37;height:12px;border-radius:2px}.good{color:#1a7f37;font-weight:bold}.same{color:#666}.bad{color:#b42318;font-weight:bold}small{color:#666}</style><h2>What does each change cost? Worst to best, per scenario</h2>';
const all = {};
scenarios.forEach(s => {
  const rows = s.arms.map(([key, what]) => ({ key, what, r: get(key) }));
  rows.forEach(x => { all[x.key] = x.r; });
  const base = (rows.find(x => x.key === s.base) || {}).r;
  const done = rows.filter(x => x.r && x.r.cost != null).sort((a, b) => b.r.cost - a.r.cost);
  const max = done.length ? done[0].r.cost : 1;
  html += `<h3>${s.title}</h3><table><tr><th class="l">Arm</th><th class="l">What it is</th><th>Tools the model sees</th><th>Input tokens</th><th>Steps</th><th>Time</th><th>Correct?</th><th class="l">Cost per review</th><th>Saving vs baseline</th></tr>`;
  done.forEach(x => {
    const r = x.r, d = base && base.cost ? (1 - r.cost / base.cost) * 100 : null;
    const sv = x.key === s.base ? '<span class="same">baseline</span>' : d == null ? '' : Math.abs(d) < 5 ? '<span class="same">about the same</span>' : d > 0 ? `<span class="good">${d.toFixed(0)}% cheaper</span>` : `<span class="bad">${(-d).toFixed(0)}% more</span>`;
    html += `<tr><td><b>${x.key}</b></td><td class="l">${x.what}</td><td>${r.tools}</td><td>${kt(r.inTok)}</td><td>${r.steps}</td><td>${r.sec}s</td><td>${r.verdict === 'pass' ? 'yes' : '<span class="bad">NO</span>'}</td><td class="l"><div class="bar" style="width:${Math.max(4, Math.round(r.cost / max * 140))}px"></div>${money(r.cost)}</td><td>${sv}</td></tr>`;
  });
  rows.filter(x => !x.r).forEach(x => { html += `<tr><td><b>${x.key}</b></td><td class="l">${x.what}</td><td colspan="7" class="l"><small>not run yet: send request ${reqNo[x.key]}</small></td></tr>`; });
  html += '</table>';
});
html += '<p><small>Cost = the agent\'s own estimate from the tokens of each model call, at list prices (Sonnet $3/$15, Haiku $1/$5 per million tokens). Rows are sorted from most to least expensive inside each scenario: the two scenarios are different workloads, so compare rows inside a scenario, not across.</small></p>';
pm.visualizer.set(html);

const ran = Object.values(all).filter(Boolean);
pm.test('At least one arm has run (send requests 1 to 6 first)', () => pm.expect(ran.length).to.be.above(0));
pm.test('Every arm that ran flagged exactly the right orders', () => ran.forEach(r => pm.expect(r.verdict).to.eql('pass')));
if (all.A && all.F) pm.test('Scenario 1: Fabric alone costs about the same as direct (within 10%)', () => pm.expect(Math.abs(all.F.cost / all.A.cost - 1)).to.be.below(0.1));
if (all.A && all['F-eco']) pm.test('Scenario 1: the economy route is cheaper than direct', () => pm.expect(all['F-eco'].cost).to.be.below(all.A.cost));
if (all.B && all.C) pm.test('Scenario 2: Tool Search is cheaper than sending all the tools', () => pm.expect(all.C.cost).to.be.below(all.B.cost));
