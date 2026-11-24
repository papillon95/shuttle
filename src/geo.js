// AI 可见度监测（GEO）：拿潜在客户会问的问题去问多个大模型，看回答里有没有推荐你的品牌、排第几、怎么评价、推荐了哪些竞品、引用了哪些来源。
// 每次监测存成 ai-visibility/<项目>/runs/<时间>.json，并重新生成 report.html（带历次趋势），全部在本地。
// 依赖由 main.js 注入（调模型、确认框、进度），这里不碰 Electron。
const fs = require('fs');
const path = require('path');

// 常用模型的简称 → 平台模型（按顺序取第一个存在的）
const MODEL_ALIASES = {
  deepseek: ['deepseek:deepseek-v4-1-flash-economy', 'deepseek:'],
  doubao: ['doubao:doubao-seed-2-1-lite', 'doubao:'],
  qwen: ['qwen:qwen-plus', 'qwen:qwen-max', 'qwen:'],
  kimi: ['kimi:'],
  ernie: ['qianfan:ernie-5.5-flash', 'qianfan:ernie'],
  glm: ['glm:glm-4-flash', 'glm:'],
};
const DEFAULT_MODELS = ['deepseek', 'doubao', 'qwen', 'kimi', 'ernie'];
const MAX_CALLS = 300;

const slug = (s) => String(s || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const norm = (s) => String(s || '').toLowerCase().replace(/[\s·・\-_.（）()【】\[\]「」"'“”]/g, '');

/** 把用户写的模型（简称或完整 value）解析成平台模型 */
function resolveModels(wanted, platformModels, level) {
  const list = (wanted && wanted.length ? wanted : DEFAULT_MODELS).map((w) => String(w).trim()).filter(Boolean);
  const out = [];
  const skipped = [];
  for (const w of list) {
    const key = w.toLowerCase();
    let m = platformModels.find((x) => x.value === w);
    if (!m) {
      const prefixes = MODEL_ALIASES[key] || [key.includes(':') ? key : key + ':'];
      for (const p of prefixes) {
        m = platformModels.find((x) => x.value.toLowerCase().startsWith(p) && !/@agent$/.test(x.value) && !/coder/i.test(x.value));
        if (m) break;
      }
    }
    if (!m) skipped.push({ name: w, why: 'notFound' });
    else if ((m.minPlanLevel || 0) > level) skipped.push({ name: m.label || w, why: 'plan' });
    else if (!out.some((x) => x.value === m.value)) out.push(m);
  }
  return { models: out, skipped };
}

/** 找名字在文本里第一次出现的位置（品牌 + 别名），没有返回 -1 */
function findName(text, names) {
  const t = norm(text);
  let best = -1;
  for (const n of names) {
    const k = norm(n);
    if (k.length < 2) continue;
    const i = t.indexOf(k);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}
/** 规则判断：回答里列了几条推荐、品牌在第几条（没有编号列表时按出现顺序） */
function ruleAnalyze(answer, brandNames, competitors) {
  const lines = String(answer || '').split('\n');
  const items = [];
  for (const l of lines) if (/^\s*(\d+[.、)）]|[-*•]|#{2,4}\s|\*\*\d)/.test(l)) items.push(l);
  const pos = (names) => {
    if (findName(answer, names) < 0) return null;
    const i = items.findIndex((l) => findName(l, names) >= 0);
    return i >= 0 ? i + 1 : 0; // 0 = 提到了但不在列表里
  };
  return {
    mentioned: findName(answer, brandNames) >= 0,
    position: pos(brandNames),
    competitors: competitors.map((c) => ({ name: c, position: pos([c]) })).filter((c) => c.position !== null),
  };
}

const ANALYZE_PROMPT = (brand, aliases, competitors, question, answer) => `下面是一个 AI 助手对用户问题的回答。请分析并只输出一个 JSON 对象，不要输出其他内容。

用户问题：${question}
要关注的品牌：${brand}${aliases.length ? `（也叫：${aliases.join('、')}）` : ''}
竞品：${competitors.length ? competitors.join('、') : '无'}

JSON 字段：
- recommended: 回答里推荐或列举的品牌 / 公司 / 产品名，按出现顺序，最多 10 个，字符串数组
- brand_mentioned: 是否提到了要关注的品牌（含别名），true / false
- brand_position: 要关注的品牌在 recommended 里是第几个（从 1 开始），没提到就是 null
- sentiment: 回答对「要关注的品牌」本身的态度，"positive" / "neutral" / "negative"，没提到就是 null。只看直接针对这个品牌的句子，别的品牌（包括竞品）的好坏评价不要算进来
- brand_summary: 回答里直接描述「要关注的品牌」的话，概括成一句（30 字内），没提到就是 ""。不要把描述其他品牌的话安到它头上；如果回答把这个名字理解成了别的东西（比如同名的其他公司、产品或工具），照实写出来
- sources: 回答里提到的信息来源（网址、网站或平台名，如 知乎、某公众号、官网），字符串数组，没有就是 []

回答：
"""
${String(answer).slice(0, 6000)}
"""`;

function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

async function pool(items, n, fn, signal) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) await fn(items[i++]);
  }));
}

/**
 * 跑一次监测。deps: { platformModels, level, ask(model, messages, maxTokens) → {text, error}, analyzeModel, confirm(info) → bool,
 *   progress(text), signal, scheduled, lang }
 */
async function run(args, root, deps) {
  const zh = deps.lang !== 'en';
  const base = path.join(root, 'ai-visibility');
  // 重新跑已保存的项目：只给 project 就用上次的配置
  let cfg = { brand: args.brand, aliases: args.aliases, competitors: args.competitors, questions: args.questions, models: args.models, repeats: args.repeats };
  const projSlug = slug(args.project || args.brand);
  const projDir = path.join(base, projSlug);
  const cfgFile = path.join(projDir, 'config.json');
  if (!cfg.brand || !Array.isArray(cfg.questions) || !cfg.questions.length) {
    if (!fs.existsSync(cfgFile)) return { error: zh ? '请提供 brand（品牌名）和 questions（要问的问题）；或者用 project 指定一个已经监测过的项目。' : 'Provide brand and questions, or project for a saved project.' };
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    cfg = { ...saved, ...Object.fromEntries(Object.entries(cfg).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) };
  }
  const brand = String(cfg.brand).trim().slice(0, 60);
  const aliases = (cfg.aliases || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
  const competitors = (cfg.competitors || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
  const questions = [...new Set((cfg.questions || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 30);
  const repeats = Math.max(1, Math.min(3, Number(cfg.repeats) || 2));
  const { models, skipped } = resolveModels(cfg.models, deps.platformModels, deps.level);
  if (!models.length) return { error: (zh ? '没有可用的模型。' : 'No usable model. ') + skipped.map((s) => `${s.name}（${s.why === 'plan' ? (zh ? '需要更高会员' : 'needs a higher plan') : zh ? '平台没有' : 'not available'}）`).join('、') };
  const calls = questions.length * models.length * repeats;
  if (calls > MAX_CALLS) return { error: zh ? `这次要问 ${calls} 次，超过单次上限 ${MAX_CALLS}，请减少问题、模型或重复次数。` : `${calls} calls exceeds the limit of ${MAX_CALLS}.` };

  // 开始前确认（定时任务里不弹，用户设定时已经同意过）
  const estTokens = Math.round(models.reduce((s, m) => s + (m.multiplier || 1), 0) * questions.length * repeats * 1800 + calls * 400);
  if (!deps.scheduled) {
    const ok = await deps.confirm({
      title: zh ? `AI 可见度监测「${brand}」：${questions.length} 个问题 × ${models.length} 个模型 × ${repeats} 次 = ${calls} 次提问，预计约 ${(estTokens / 10000).toFixed(0)} 万 token` : `AI visibility check "${brand}": ${calls} questions in total, about ${(estTokens / 1000).toFixed(0)}K tokens`,
      body: (zh ? '模型：' : 'Models: ') + models.map((m) => m.label).join('、') + (skipped.length ? (zh ? '\n跳过：' : '\nSkipped: ') + skipped.map((s) => s.name).join('、') : '') + (competitors.length ? (zh ? '\n竞品：' : '\nCompetitors: ') + competitors.join('、') : '') + '\n\n' + questions.map((q, i) => `${i + 1}. ${q}`).join('\n'),
    });
    if (!ok) return { rejected: true };
  }
  fs.mkdirSync(path.join(projDir, 'runs'), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ brand, aliases, competitors, questions, models: models.map((m) => m.value), repeats }, null, 2));

  // 1. 提问：像普通用户一样直接问，不加系统提示
  const tasks = [];
  for (const q of questions) for (const m of models) for (let r = 0; r < repeats; r++) tasks.push({ q, m, r });
  const answers = [];
  let done = 0;
  const brandNames = [brand, ...aliases];
  await pool(tasks, 2, async (t) => {
    const res = await deps.ask(t.m.value, [{ role: 'user', content: t.q }], 1500);
    done++;
    deps.progress(zh ? `正在问 AI ${done}/${calls}…` : `Asking ${done}/${calls}…`);
    answers.push({ question: t.q, model: t.m.value, modelLabel: t.m.label, round: t.r + 1, answer: res.text || '', error: res.error || null });
  }, deps.signal);
  if (deps.signal?.aborted) return { error: zh ? '已停止' : 'Stopped' };

  // 2. 逐条分析：规则判断 + 便宜模型抽取推荐名单、态度、来源
  let ad = 0;
  const ok = answers.filter((a) => a.answer && !a.error);
  await pool(ok, 2, async (a) => {
    const rule = ruleAnalyze(a.answer, brandNames, competitors);
    let llm = null;
    if (deps.analyzeModel) {
      const r = await deps.ask(deps.analyzeModel, [{ role: 'user', content: ANALYZE_PROMPT(brand, aliases, competitors, a.question, a.answer) }], 600);
      llm = parseJson(r.text);
    }
    ad++;
    deps.progress(zh ? `正在分析回答 ${ad}/${ok.length}…` : `Analyzing ${ad}/${ok.length}…`);
    // 规则判断「有没有提到」最可靠（直接搜名字）；排名、推荐名单、态度用模型抽取的，抽取失败用规则的
    a.mentioned = rule.mentioned || !!llm?.brand_mentioned;
    a.position = a.mentioned ? (Number.isInteger(llm?.brand_position) ? llm.brand_position : rule.position || null) : null;
    a.recommended = Array.isArray(llm?.recommended) ? llm.recommended.map(String).slice(0, 10) : [];
    a.sentiment = a.mentioned ? (['positive', 'neutral', 'negative'].includes(llm?.sentiment) ? llm.sentiment : 'neutral') : null;
    a.summary = a.mentioned ? String(llm?.brand_summary || '').slice(0, 80) : '';
    a.sources = Array.isArray(llm?.sources) ? llm.sources.map(String).slice(0, 10) : [];
    a.competitorHits = rule.competitors;
  }, deps.signal);

  // 3. 汇总
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const fileStamp = stamp.replace(/[: ]/g, '-') + '-' + pad(now.getSeconds());
  const runData = { at: new Date().toISOString(), stamp, brand, aliases, competitors, questions, repeats, models: models.map((m) => ({ value: m.value, label: m.label })), answers };
  runData.summary = summarize(runData);
  fs.writeFileSync(path.join(projDir, 'runs', fileStamp + '.json'), JSON.stringify(runData, null, 2));
  const history = fs.readdirSync(path.join(projDir, 'runs')).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(projDir, 'runs', f), 'utf8'));
      return { stamp: d.stamp, summary: d.summary };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const reportFile = path.join(projDir, 'report.html');
  fs.writeFileSync(reportFile, renderReport(runData, history, zh));
  return { runData, history, reportFile, projDir, skipped };
}

function summarize(d) {
  const valid = d.answers.filter((a) => a.answer && !a.error);
  const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
  const byModel = d.models.map((m) => {
    const as = valid.filter((a) => a.model === m.value);
    const hit = as.filter((a) => a.mentioned);
    const ranked = hit.filter((a) => a.position > 0);
    return {
      model: m.label, total: as.length, mentioned: hit.length, rate: pct(hit.length, as.length),
      avgPos: ranked.length ? +(ranked.reduce((s, a) => s + a.position, 0) / ranked.length).toFixed(1) : null,
      top3: pct(ranked.filter((a) => a.position <= 3).length, as.length),
      errors: d.answers.filter((a) => a.model === m.value && a.error).length,
    };
  });
  // 问题里本身带了品牌名的（「XX 怎么样」）一定会提到品牌，单独算，不计入总提及率
  const names = [d.brand, ...(d.aliases || [])];
  const byQuestion = d.questions.map((q) => {
    const as = valid.filter((a) => a.question === q);
    return { question: q, rate: pct(as.filter((a) => a.mentioned).length, as.length), brandQ: findName(q, names) >= 0 };
  });
  const isBrandQ = new Set(byQuestion.filter((q) => q.brandQ).map((q) => q.question));
  const generic = valid.filter((a) => !isBrandQ.has(a.question));
  const rateBase = generic.length ? generic : valid;
  // 被推荐最多的名字（看看 AI 把客户推给了谁）
  const count = new Map();
  for (const a of valid) for (const n of new Set((a.recommended || []).map((x) => x.trim()).filter(Boolean))) count.set(n, (count.get(n) || 0) + 1);
  const topRecommended = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => ({ name, n, rate: pct(n, valid.length) }));
  const comp = d.competitors.map((c) => ({ name: c, rate: pct(valid.filter((a) => (a.competitorHits || []).some((h) => h.name === c) || (a.recommended || []).some((r) => norm(r).includes(norm(c)))).length, valid.length) }));
  const srcCount = new Map();
  for (const a of valid) for (const s of new Set(a.sources || [])) srcCount.set(s, (srcCount.get(s) || 0) + 1);
  const sources = [...srcCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => ({ name, n }));
  const hits = valid.filter((a) => a.mentioned);
  const sent = { positive: hits.filter((a) => a.sentiment === 'positive').length, neutral: hits.filter((a) => a.sentiment === 'neutral').length, negative: hits.filter((a) => a.sentiment === 'negative').length };
  const descriptions = [...new Set(hits.map((a) => a.summary).filter(Boolean))].slice(0, 8);
  if (isBrandQ.size && generic.length) for (const m of byModel) {
    const as = generic.filter((a) => d.models.find((x) => x.label === m.model)?.value === a.model);
    const hit = as.filter((a) => a.mentioned);
    const ranked = hit.filter((a) => a.position > 0);
    Object.assign(m, { total: as.length, mentioned: hit.length, rate: pct(hit.length, as.length),
      avgPos: ranked.length ? +(ranked.reduce((x, a) => x + a.position, 0) / ranked.length).toFixed(1) : null, top3: pct(ranked.filter((a) => a.position <= 3).length, as.length) });
  }
  const brandHits = valid.filter((a) => isBrandQ.has(a.question) && a.mentioned);
  const brandQs = isBrandQ.size ? {
    count: isBrandQ.size,
    answers: valid.filter((a) => isBrandQ.has(a.question)).length,
    sentiment: { positive: brandHits.filter((a) => a.sentiment === 'positive').length, neutral: brandHits.filter((a) => a.sentiment === 'neutral').length, negative: brandHits.filter((a) => a.sentiment === 'negative').length },
    descriptions: [...new Set(brandHits.map((a) => a.summary).filter(Boolean))].slice(0, 8),
  } : null;
  return { total: valid.length, errors: d.answers.length - valid.length, mentioned: hits.length, rate: pct(rateBase.filter((a) => a.mentioned).length, rateBase.length), rateTotal: rateBase.length, brandQs, byModel, byQuestion, topRecommended, competitors: comp, sources, sentiment: sent, descriptions };
}

/** 给模型看的文字摘要 */
function textSummary(res, zh = true) {
  const d = res.runData;
  const s = d.summary;
  const L = [];
  L.push(zh ? `AI 可见度监测「${d.brand}」完成（${d.stamp}）：有效回答 ${s.total} 条${s.errors ? `，失败 ${s.errors} 条` : ''}，提到品牌 ${s.mentioned} 条；${s.brandQs ? '不带品牌名的问题里' : ''}AI 主动提到品牌的比例（提及率）${s.rate}%。` : `AI visibility check for "${d.brand}" done: ${s.total} answers, mention rate ${s.rate}%${s.brandQs ? ' (questions without the brand name)' : ''}.`);
  if (s.brandQs) {
    const b = s.brandQs;
    L.push(zh
      ? `直接问品牌的问题 ${b.count} 个（${b.answers} 条回答，不计入提及率）：态度 正面 ${b.sentiment.positive}、中性 ${b.sentiment.neutral}、负面 ${b.sentiment.negative}${b.descriptions.length ? '；AI 这样介绍它：' + b.descriptions.map((x) => `「${x}」`).join(' ') : ''}`
      : `Brand-name questions: ${b.count} (${b.answers} answers, excluded from the mention rate); sentiment +${b.sentiment.positive} =${b.sentiment.neutral} -${b.sentiment.negative}${b.descriptions.length ? '; AI describes it as: ' + b.descriptions.join(' | ') : ''}`);
  }
  L.push(zh ? '\n各模型：' : '\nBy model:');
  for (const m of s.byModel) L.push(`- ${m.model}：${zh ? '提及率' : 'mention'} ${m.rate}%（${m.mentioned}/${m.total}）${m.avgPos ? (zh ? `，平均排第 ${m.avgPos}，前三 ${m.top3}%` : `, avg #${m.avgPos}`) : ''}${m.errors ? (zh ? `，失败 ${m.errors}` : `, ${m.errors} failed`) : ''}`);
  L.push(zh ? '\n各问题提及率：' : '\nBy question:');
  for (const q of s.byQuestion) L.push(`- ${q.brandQ ? (zh ? '（品牌词）' : '(brand) ') : q.rate + '%  '}${q.question}`);
  if (s.competitors.length) L.push((zh ? '\n竞品出现率：' : '\nCompetitors: ') + s.competitors.map((c) => `${c.name} ${c.rate}%`).join('，'));
  if (s.topRecommended.length) L.push((zh ? '\nAI 推荐最多的名字：' : '\nMost recommended: ') + s.topRecommended.slice(0, 10).map((r) => `${r.name}（${r.n}）`).join('，'));
  if (s.mentioned) L.push((zh ? `\n对品牌的态度：正面 ${s.sentiment.positive}，中性 ${s.sentiment.neutral}，负面 ${s.sentiment.negative}` : `\nSentiment: +${s.sentiment.positive} =${s.sentiment.neutral} -${s.sentiment.negative}`));
  if (s.descriptions.length) L.push((zh ? 'AI 对品牌的描述：' : 'How AI describes it: ') + s.descriptions.map((x) => `「${x}」`).join(' '));
  if (s.sources.length) L.push((zh ? '\nAI 提到的信息来源：' : '\nSources cited: ') + s.sources.map((x) => `${x.name}（${x.n}）`).join('，'));
  if (res.history.length > 1) L.push((zh ? '\n历次总提及率：' : '\nHistory: ') + res.history.slice(-8).map((h) => `${h.stamp.slice(5)} ${h.summary.rate}%`).join(' → '));
  if (res.skipped?.length) L.push((zh ? '\n跳过的模型：' : '\nSkipped: ') + res.skipped.map((x) => `${x.name}（${x.why === 'plan' ? (zh ? '需要更高会员' : 'plan') : zh ? '平台没有' : 'n/a'}）`).join('、'));
  L.push((zh ? '\n完整报告（每条原始回答都在里面）：' : '\nFull report: ') + path.relative(path.dirname(path.dirname(res.projDir)), res.reportFile));
  L.push(zh
    ? '\n请用通俗的话向用户解读：哪些模型、哪些问题下品牌表现好或差，AI 更常推荐谁，AI 引用了哪些来源；再给 3～5 条具体可做的建议（该在哪些平台发什么样的真实内容、官网要补什么信息），提醒不要发虚假测评。说明这是通过接口直接问模型的结果，和 App 里打开联网搜索时的回答可能不同。最后问用户：要不要用 geo_content 按提及率低的问题生成可发布的内容（需要先向用户要品牌真实信息），以及要不要设成定期监测（用 project 参数即可重复跑同一组问题）。'
    : '\nExplain the results plainly, give 3-5 concrete content suggestions (no fake reviews), note that API answers may differ from the apps with web search, offer geo_content to draft publishable content for weak questions (ask for real brand facts first), and offer to schedule recurring checks (pass project to rerun).');
  return L.join('\n');
}

// ---------- 报告（单个 HTML 文件，图表用内联 SVG，不依赖网络） ----------
function bar(pct, color = 'var(--accent)') {
  return `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></i><span>${pct}%</span></div>`;
}
function trendSvg(history) {
  if (history.length < 2) return '';
  const W = 640, H = 160, P = 28;
  const xs = history.map((_, i) => P + (i * (W - P * 2)) / (history.length - 1));
  const ys = history.map((h) => H - P - (h.summary.rate / 100) * (H - P * 2));
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const sameDay = history.every((h) => h.stamp.slice(0, 10) === history[0].stamp.slice(0, 10));
  return `<svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="trend">
    ${[0, 50, 100].map((v) => { const y = H - P - (v / 100) * (H - P * 2); return `<line x1="${P}" x2="${W - P}" y1="${y}" y2="${y}" class="grid"/><text x="4" y="${y + 4}" class="axis">${v}%</text>`; }).join('')}
    <polyline points="${pts}" class="line"/>
    ${xs.map((x, i) => `<circle cx="${x}" cy="${ys[i]}" r="3.5" class="dot"><title>${esc(history[i].stamp)}：${history[i].summary.rate}%</title></circle>`).join('')}
    ${xs.map((x, i) => (i === 0 || i === xs.length - 1 || history.length <= 8 ? `<text x="${x}" y="${H - 6}" class="axis" text-anchor="middle">${esc(sameDay ? history[i].stamp.slice(11, 16) : history[i].stamp.slice(5, 10))}</text>` : '')).join('')}
  </svg>`;
}
function renderReport(d, history, zh) {
  const s = d.summary;
  const t = zh
    ? { title: 'AI 可见度报告', rate: '总提及率', answers: '有效回答', byModel: '各模型表现', model: '模型', mention: '提及率', avg: '平均排名', top3: '进前三', byQ: '各问题提及率', rec: 'AI 推荐最多的名字', comp: '竞品出现率', src: 'AI 提到的信息来源', desc: 'AI 怎么描述你', sent: '态度', pos: '正面', neu: '中性', neg: '负面', trend: '历次总提及率', raw: '全部原始回答', none: '无', note: '说明：通过接口直接提问各模型（没有打开联网搜索），和在 App 里提问的结果可能不同。每个问题问了多次，按统计结果看更可靠。', yes: '提到', no: '没提到', pos2: '第 {n} 位' }
    : { title: 'AI Visibility Report', rate: 'Mention rate', answers: 'Answers', byModel: 'By model', model: 'Model', mention: 'Mention', avg: 'Avg rank', top3: 'Top 3', byQ: 'By question', rec: 'Most recommended', comp: 'Competitors', src: 'Sources cited', desc: 'How AI describes you', sent: 'Sentiment', pos: 'Positive', neu: 'Neutral', neg: 'Negative', trend: 'Mention rate over time', raw: 'All answers', none: 'None', note: 'Answers come from the model APIs without web search and may differ from the apps.', yes: 'Mentioned', no: 'Not mentioned', pos2: '#{n}' };
  const answersHtml = d.questions.map((q) => {
    const as = d.answers.filter((a) => a.question === q);
    return `<details><summary>${esc(q)} <em>${as.filter((a) => a.mentioned).length}/${as.filter((a) => a.answer).length}</em></summary>${as.map((a) => `
      <div class="ans"><div class="ah"><b>${esc(a.modelLabel)}</b> #${a.round} <span class="tag ${a.mentioned ? 'ok' : ''}">${a.error ? esc(a.error) : a.mentioned ? t.yes + (a.position ? ' · ' + t.pos2.replace('{n}', a.position) : '') : t.no}</span></div>
      ${a.recommended?.length ? `<div class="rec">${a.recommended.map((r) => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
      <pre>${esc(a.answer)}</pre></div>`).join('')}</details>`;
  }).join('');
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.brand)} · ${t.title}</title><style>
:root{--bg:#f7f6f3;--card:#fff;--text:#222;--muted:#6b6b6b;--border:#e5e2db;--accent:#c96442;--ok:#2f8f5b;--warn:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--text:#ecebe8;--muted:#a19f99;--border:#3a3935;--accent:#d97757;--ok:#5cc28a;--warn:#ff7a6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:20px 16px}
main{max-width:920px;margin:0 auto}h1{font-size:22px;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi,.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px}.kpi b{display:block;font-size:26px}.kpi>span{color:var(--muted);font-size:12px}
.card{margin-bottom:14px}.card h2{font-size:15px;margin:0 0 10px}table{width:100%;border-collapse:collapse}td,th{padding:6px 4px;border-bottom:1px solid var(--border);text-align:left;font-size:13px}th{color:var(--muted);font-weight:500}
.bar{position:relative;background:var(--bg);border-radius:6px;height:20px;min-width:120px}.bar i{display:block;height:100%;border-radius:6px;opacity:.85}.bar span{position:absolute;right:6px;top:0;font-size:12px;line-height:20px}
.chips span,.rec span{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:1px 9px;margin:0 6px 6px 0;font-size:12px}
.trend{width:100%;height:auto}.trend .grid{stroke:var(--border)}.trend .axis{fill:var(--muted);font-size:10px}.trend .line{fill:none;stroke:var(--accent);stroke-width:2}.trend .dot{fill:var(--accent)}
details{border-top:1px solid var(--border);padding:8px 0}summary{cursor:pointer;font-weight:600}summary em{font-style:normal;color:var(--muted);font-weight:400;margin-left:6px}
.ans{margin:10px 0 0 12px;padding-left:10px;border-left:2px solid var(--border)}.ah{font-size:13px}.tag{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--bg);color:var(--muted);margin-left:6px}.tag.ok{color:var(--ok)}
pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.55 inherit;background:var(--bg);border-radius:8px;padding:8px 10px;max-height:260px;overflow:auto;margin:6px 0}
.note{color:var(--muted);font-size:12px}.neg{color:var(--warn)}.posi{color:var(--ok)}
</style></head><body><main>
<h1>${esc(d.brand)} · ${t.title}</h1><div class="sub">${esc(d.stamp)} · ${d.models.map((m) => esc(m.label)).join(' / ')} · ${d.questions.length} × ${d.repeats}</div>
<div class="kpis"><div class="kpi"><b>${s.rate}%</b><span>${t.rate}</span></div><div class="kpi"><b>${s.mentioned}/${s.total}</b><span>${t.answers}</span></div>
<div class="kpi"><b><span class="posi">${s.sentiment.positive}</span> / ${s.sentiment.neutral} / <span class="neg">${s.sentiment.negative}</span></b><span>${t.sent}：${t.pos} / ${t.neu} / ${t.neg}</span></div></div>
${history.length > 1 ? `<div class="card"><h2>${t.trend}</h2>${trendSvg(history)}</div>` : ''}
<div class="card"><h2>${t.byModel}</h2><table><tr><th>${t.model}</th><th>${t.mention}</th><th>${t.avg}</th><th>${t.top3}</th></tr>
${s.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td>${bar(m.rate)}</td><td>${m.avgPos ?? '—'}</td><td>${m.top3}%</td></tr>`).join('')}</table></div>
<div class="card"><h2>${t.byQ}</h2><table>${s.byQuestion.map((q) => `<tr><td>${esc(q.question)}${q.brandQ ? ` <span class="tag">${zh ? '品牌词，不计入提及率' : 'brand name, excluded'}</span>` : ''}</td><td style="width:200px">${bar(q.rate, q.brandQ ? 'var(--muted)' : undefined)}</td></tr>`).join('')}</table></div>
${s.competitors.length ? `<div class="card"><h2>${t.comp}</h2><table><tr><td>${esc(d.brand)}</td><td style="width:240px">${bar(s.rate)}</td></tr>${s.competitors.map((c) => `<tr><td>${esc(c.name)}</td><td>${bar(c.rate, 'var(--muted)')}</td></tr>`).join('')}</table></div>` : ''}
<div class="card"><h2>${t.rec}</h2><div class="chips">${s.topRecommended.length ? s.topRecommended.map((r) => `<span>${esc(r.name)} · ${r.n}</span>`).join('') : t.none}</div></div>
${s.descriptions.length ? `<div class="card"><h2>${t.desc}</h2><ul>${s.descriptions.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
<div class="card"><h2>${t.src}</h2><div class="chips">${s.sources.length ? s.sources.map((x) => `<span>${esc(x.name)} · ${x.n}</span>`).join('') : t.none}</div></div>
<div class="card"><h2>${t.raw}</h2>${answersHtml}</div>
<p class="note">${t.note}</p></main></body></html>`;
}

module.exports = { run, textSummary, resolveModels, ruleAnalyze, summarize, renderReport, DEFAULT_MODELS };
