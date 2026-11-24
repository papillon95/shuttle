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

const ANALYZE_PROMPT = (brand, aliases, competitors, question, answer) => `下面是一个 AI 助手对用户问题的回答。请分析并只输出一个 JSON 对象，不要输出其他内容。所有内容都必须来自回答原文，原文没有的不要写。

用户问题：${question}
要关注的品牌：${brand}${aliases.length ? `（也叫：${aliases.join('、')}）` : ''}
竞品：${competitors.length ? competitors.join('、') : '无'}

JSON 字段：
- recommended: 回答里推荐或列举的品牌 / 公司 / 产品名（照原文抄，不要添加回答里没有的名字），按出现顺序，最多 10 个，字符串数组
- same_entity: 如果回答原文里出现了「要关注的品牌」的名字，说的是不是这个品牌本身（true）；如果说的是同名或近似名字的其他公司、产品、品牌（比如把它当成了别的知名品牌），填 false；原文没出现这个名字就填 null
- brand_quote: 回答原文里直接描述「要关注的品牌」的一句话，一字不改地照抄（不超过 80 字）；没有就是 ""。不要抄描述其他品牌的句子
- sentiment: 这句话对「要关注的品牌」的态度，"positive" / "neutral" / "negative"；没有 brand_quote 就是 null
- brand_unknown: 回答是否表示不了解 / 查不到 / 不确定这个品牌（只给通用建议、或说「可能是」「需要确认是哪家」），true / false
- sources: 回答原文里明确写出的信息来源（网址、网站或平台名），照原文抄，字符串数组，没有就是 []

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

// 分析结果的版本：口径变了就加 1，历史监测会按新口径用保存的原始回答重算
const ANALYSIS_VERSION = 4;

/**
 * 把一条回答的分析落到原文上：分析模型只是帮忙抽取，最后只采用原文里能找到依据的部分。
 * - 「提到」：原文里出现品牌名才算；分析模型只能否决（判断是同名的其他东西 → 记为「同名混淆」），不能凭空认定提到
 * - 推荐名单、信息来源：只保留原文里出现的名字
 * - 描述：必须是原文里一字不差的句子；态度跟着这句话走，没有原文依据就记中性
 */
const UNKNOWN_RE = /(暂未|暂时没有|没有|未能|无法|没能|并未)(查询到|查到|找到|检索到|获取到?|搜索到)|(公开|相关|可查)的?(详细)?(信息|资料)(相对|比较|非常)?(有限|较少|很少|不多)|可能是(指|一个|一家|某)|(需要|请|建议)(先)?(明确|确认|核实)(具体|一下)?(是)?哪(一)?家|不(太)?确定(是|指)|不(太)?了解(这|该)|没有(找到|关于)(该|这)|(未|没有)(收录|掌握)|(无法|不能)(直接|实时)?(给出|获取|判断|评价|确认|核实)|由于(其|它|该品牌|该公司)?可能|可能对应不同|(具体)?指的?是哪(一)?家|名称(存在)?(近似|相近)/;

function groundAnswer(a, llm, ctx) {
  const { brandNames, competitors, zh } = ctx;
  a.llm = llm || null;
  a.analyzed = !!llm;
  const rule = ruleAnalyze(a.answer, brandNames, competitors);
  const text = norm(a.answer);
  const inText = (n) => {
    const k = norm(String(n).replace(/[（(].*?[）)]/g, ''));
    return k.length >= 2 && text.includes(k);
  };
  a.confused = rule.mentioned && llm?.same_entity === false;
  a.mentioned = rule.mentioned && !a.confused;
  a.recommended = Array.isArray(llm?.recommended) ? llm.recommended.map((x) => String(x).trim()).filter(inText).slice(0, 10) : [];
  const llmPos = a.recommended.findIndex((n) => findName(n, brandNames) >= 0);
  a.position = a.mentioned ? (llmPos >= 0 ? llmPos + 1 : rule.position || null) : null;
  const quote = String(llm?.brand_quote || llm?.brand_summary || '').trim();
  const brandQ = findName(a.question, brandNames) >= 0;
  // 原话必须在原文里，并且说的是品牌本身（出现品牌名，或者问的就是这个品牌、句子以「它 / 该品牌 / 这家」开头）
  const aboutBrand = findName(quote, brandNames) >= 0 || (brandQ && /^[“"「]?(它|该品牌|该公司|该店|这家|这个品牌)/.test(quote));
  const quoteOk = a.mentioned && norm(quote).length >= 4 && text.includes(norm(quote)) && aboutBrand;
  // 「不了解这个品牌」：分析模型的判断，加上原文里的典型说法（小模型经常漏判）
  a.unknown = a.mentioned && (!!llm?.brand_unknown || UNKNOWN_RE.test(a.answer));
  a.quote = quoteOk && !a.unknown ? quote.slice(0, 120) : '';
  a.sentiment = a.mentioned ? (a.quote && ['positive', 'neutral', 'negative'].includes(llm?.sentiment) ? llm.sentiment : 'neutral') : null;
  a.summary = a.unknown ? (zh ? 'AI 表示不了解 / 查不到这个品牌' : 'AI says it does not know this brand') : a.quote;
  a.sources = Array.isArray(llm?.sources) ? llm.sources.map((x) => String(x).trim()).filter(inText).slice(0, 10) : [];
  a.competitorHits = rule.competitors;
  return a;
}

/** 旧口径的监测记录按当前口径重算（用保存的原始回答；没存分析原文的老记录，用当时抽取的字段当作分析结果再核对一遍） */
function regroundRun(d, zh = true) {
  if (!d || d.analysisVersion === ANALYSIS_VERSION) return d;
  const ctx = { brandNames: [d.brand, ...(d.aliases || [])], competitors: d.competitors || [], zh };
  for (const a of d.answers || []) {
    if (!a.answer || a.error) continue;
    const llm = a.llm !== undefined ? a.llm : { recommended: a.recommended, sentiment: a.sentiment, brand_summary: a.summary, sources: a.sources, same_entity: null };
    groundAnswer(a, llm, ctx);
  }
  d.summary = summarize(d);
  d.regrounded = true;
  return d;
}

/** 同一组问题和模型才能放进同一条趋势线 */
const configKey = (d) => JSON.stringify([[...(d.questions || [])].sort(), (d.models || []).map((m) => m.value || m).sort(), d.repeats || 0]);

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
  // 额度用完 / 登录失效就整体停下（再问也是失败，白等）；某个模型没权限就跳过它剩下的提问
  const stop = new AbortController();
  const sig = deps.signal ? AbortSignal.any([deps.signal, stop.signal]) : stop.signal;
  let stopReason = null;
  const deadModels = new Map();
  await pool(tasks, 2, async (t) => {
    if (deadModels.has(t.m.value)) {
      answers.push({ question: t.q, model: t.m.value, modelLabel: t.m.label, round: t.r + 1, answer: '', error: deadModels.get(t.m.value), skipped: true });
      return;
    }
    const res = await deps.ask(t.m.value, [{ role: 'user', content: t.q }], 1500);
    done++;
    deps.progress(zh ? `正在问 AI ${done}/${calls}…` : `Asking ${done}/${calls}…`);
    if (res.code === 'quota_exceeded' || res.code === 'unauthorized') {
      stopReason = res.error;
      stop.abort();
    } else if (res.code === 'plan_required' || res.code === 'model_not_found') deadModels.set(t.m.value, res.error);
    answers.push({ question: t.q, model: t.m.value, modelLabel: t.m.label, round: t.r + 1, answer: res.text || '', error: res.error || null });
  }, sig);
  if (deps.signal?.aborted) return { error: zh ? '已停止' : 'Stopped' };
  if (stopReason && !answers.some((a) => a.answer)) return { error: stopReason };

  // 2. 逐条分析：便宜模型帮忙抽取，再用原文核对（见 groundAnswer）；抽取失败重试一次，还失败就只按原文判断提没提到
  let ad = 0;
  const ok = answers.filter((a) => a.answer && !a.error);
  const ctx = { brandNames, competitors, zh };
  await pool(ok, 2, async (a) => {
    let llm = null;
    if (deps.analyzeModel && !stopReason) {
      for (let i = 0; i < 2 && !llm; i++) {
        const r = await deps.ask(deps.analyzeModel, [{ role: 'user', content: ANALYZE_PROMPT(brand, aliases, competitors, a.question, a.answer) }], 700);
        if (r.code === 'quota_exceeded' || r.code === 'unauthorized') {
          stopReason = r.error;
          break;
        }
        llm = parseJson(r.text);
      }
    }
    ad++;
    deps.progress(zh ? `正在分析回答 ${ad}/${ok.length}…` : `Analyzing ${ad}/${ok.length}…`);
    groundAnswer(a, llm, ctx);
  }, deps.signal);

  // 3. 汇总
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const fileStamp = stamp.replace(/[: ]/g, '-') + '-' + pad(now.getSeconds());
  const runData = { at: new Date().toISOString(), stamp, analysisVersion: ANALYSIS_VERSION, brand, aliases, competitors, questions, repeats, models: models.map((m) => ({ value: m.value, label: m.label })), answers, stopReason };
  runData.summary = summarize(runData);
  fs.writeFileSync(path.join(projDir, 'runs', fileStamp + '.json'), JSON.stringify(runData, null, 2));
  const history = fs.readdirSync(path.join(projDir, 'runs')).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try {
      const d = regroundRun(JSON.parse(fs.readFileSync(path.join(projDir, 'runs', f), 'utf8')), zh);
      return { stamp: d.stamp, summary: d.summary, key: configKey(d), regrounded: !!d.regrounded };
    } catch {
      return null;
    }
  }).filter(Boolean);
  // 趋势只比较问题和模型都相同的几次，其余的单独说明
  const key = configKey(runData);
  const comparable = history.filter((h) => h.key === key);
  const reportFile = path.join(projDir, 'report.html');
  const res = { runData, history: comparable, otherRuns: history.length - comparable.length, regrounded: comparable.filter((h) => h.regrounded).length, reportFile, projDir, skipped };
  fs.writeFileSync(reportFile, renderReport(runData, comparable, zh, qualityNotes(res, zh)));
  return res;
}

// 每个比例都带上样本数；少于这个数的比例只作参考
const MIN_SAMPLE = 6;

function summarize(d) {
  const valid = d.answers.filter((a) => a.answer && !a.error);
  const pct = (n, t) => (t ? Math.round((n / t) * 100) : null);
  // 问题里本身带了品牌名的（「XX 怎么样」）一定会提到品牌，单独算，不计入提及率
  const names = [d.brand, ...(d.aliases || [])];
  const isBrandQ = new Set(d.questions.filter((q) => findName(q, names) >= 0));
  const generic = valid.filter((a) => !isBrandQ.has(a.question));
  const rateBase = generic.length ? generic : valid;
  const stat = (as) => {
    const hit = as.filter((a) => a.mentioned);
    const ranked = hit.filter((a) => a.position > 0);
    return {
      total: as.length, mentioned: hit.length, rate: pct(hit.length, as.length), low: as.length < MIN_SAMPLE,
      avgPos: ranked.length ? +(ranked.reduce((x, a) => x + a.position, 0) / ranked.length).toFixed(1) : null,
      top3: pct(ranked.filter((a) => a.position <= 3).length, as.length),
    };
  };
  const byModel = d.models.map((m) => {
    const failed = d.answers.filter((a) => a.model === m.value && a.error);
    return { model: m.label, ...stat(rateBase.filter((a) => a.model === m.value)), errors: failed.length, errorReason: failed[0]?.error || null };
  });
  const byQuestion = d.questions.map((q) => {
    const as = valid.filter((a) => a.question === q);
    return { question: q, ...stat(as), brandQ: isBrandQ.has(q) };
  });
  // AI 把客户推给了谁（只统计原文里出现的名字）
  const count = new Map();
  for (const a of valid) for (const n of new Set((a.recommended || []).filter((x) => findName(x, names) < 0))) count.set(n, (count.get(n) || 0) + 1);
  const topRecommended = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => ({ name, n, rate: pct(n, valid.length) }));
  const comp = d.competitors.map((c) => ({ name: c, rate: pct(rateBase.filter((a) => (a.competitorHits || []).some((h) => h.name === c)).length, rateBase.length) ?? 0 }));
  const srcCount = new Map();
  for (const a of valid) for (const x of new Set(a.sources || [])) srcCount.set(x, (srcCount.get(x) || 0) + 1);
  const sources = [...srcCount.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => ({ name, n }));
  const hits = valid.filter((a) => a.mentioned);
  const sentOf = (as) => ({ positive: as.filter((a) => a.sentiment === 'positive').length, neutral: as.filter((a) => a.sentiment === 'neutral').length, negative: as.filter((a) => a.sentiment === 'negative').length });
  const quotesOf = (as) => [...new Set(as.map((a) => a.quote).filter(Boolean))].slice(0, 8);
  const brandHits = hits.filter((a) => isBrandQ.has(a.question));
  const brandQs = isBrandQ.size ? {
    count: isBrandQ.size,
    answers: valid.filter((a) => isBrandQ.has(a.question)).length,
    sentiment: sentOf(brandHits),
    descriptions: quotesOf(brandHits),
    unknown: brandHits.filter((a) => a.unknown).length,
    confused: valid.filter((a) => isBrandQ.has(a.question) && a.confused).length,
  } : null;
  const genericHits = hits.filter((a) => !isBrandQ.has(a.question));
  const errs = d.answers.filter((a) => a.error);
  const errorReasons = [...new Set(errs.map((a) => a.error))].slice(0, 3);
  return {
    total: valid.length, errors: errs.length, errorReasons, asked: d.answers.length,
    analysisFailed: valid.filter((a) => !a.analyzed).length,
    confused: valid.filter((a) => a.confused).length,
    mentioned: hits.length, rate: pct(rateBase.filter((a) => a.mentioned).length, rateBase.length) ?? 0, rateTotal: rateBase.length, low: rateBase.length < MIN_SAMPLE * 2,
    brandQs, byModel, byQuestion, topRecommended, competitors: comp, sources,
    sentiment: sentOf(genericHits), descriptions: quotesOf(genericHits),
    confusedQuotes: [...new Set(valid.filter((a) => a.confused).map((a) => { const t = a.answer.replace(/\s+/g, ' '); const i = Math.min(...names.map((n) => t.indexOf(n)).filter((x) => x >= 0)); return Number.isFinite(i) ? t.slice(Math.max(0, i - 20), i + 60) : ''; }).filter(Boolean))].slice(0, 3),
    stopReason: d.stopReason || null,
  };
}

/** 数据可信度说明（报告和给模型的摘要共用） */
function qualityNotes(res, zh = true) {
  const s = res.runData.summary;
  const N = [];
  if (s.stopReason) N.push(zh ? `中途停止：${s.stopReason}，只统计了已经拿到的回答` : `Stopped early: ${s.stopReason}`);
  if (s.errors) N.push(zh ? `${s.errors}/${s.asked} 次提问失败（${s.errorReasons.join('；')}），失败的不计入统计` : `${s.errors}/${s.asked} calls failed (${s.errorReasons.join('; ')})`);
  for (const m of s.byModel) if (!m.total && m.errors) N.push(zh ? `${m.model} 全部失败，不代表它没提到品牌` : `${m.model} failed entirely; that is not a 0% result`);
  if (s.analysisFailed) N.push(zh ? `${s.analysisFailed} 条回答自动分析失败，这些只按原文判断了有没有提到，排名、态度、推荐名单没统计` : `${s.analysisFailed} answers could not be analyzed; only mentions were counted`);
  if (s.confused) N.push(zh ? `${s.confused} 条回答里出现了品牌名，但说的是同名或近似名字的其他东西，没算作提到${s.confusedQuotes.length ? '，例：' + s.confusedQuotes.map((x) => `「…${x}…」`).join(' ') : ''}` : `${s.confused} answers used the name for a different entity and were not counted`);
  if (s.low) N.push(zh ? `用来算提及率的回答只有 ${s.rateTotal} 条，比例波动会比较大` : `Only ${s.rateTotal} answers behind the mention rate; treat it as rough`);
  else if (s.byModel.some((m) => m.total && m.low)) N.push(zh ? `部分模型的回答少于 ${MIN_SAMPLE} 条（${s.byModel.filter((m) => m.total && m.low).map((m) => `${m.model} ${m.total} 条`).join('、')}），单个模型的比例只作参考` : `Some models have fewer than ${MIN_SAMPLE} answers`);
  if (res.regrounded) N.push(zh ? `有 ${res.regrounded} 次历史监测是按旧口径统计的，已用保存的原始回答按现在的口径重算` : `${res.regrounded} past checks were recalculated with the current method`);
  if (res.otherRuns) N.push(zh ? `另有 ${res.otherRuns} 次监测的问题或模型不同，没放进趋势对比` : `${res.otherRuns} other checks used different questions or models and are not in the trend`);
  N.push(zh ? '「提到」只按回答原文里有没有出现品牌名来算；AI 的描述只采用原文里一字不差的句子' : 'Mentions are counted only when the brand name appears in the answer text; descriptions are verbatim quotes');
  N.push(zh ? '这是通过接口直接问模型的结果（没有联网搜索），反映的是模型自身的印象，和 App 里打开联网搜索时的回答可能不同' : 'Answers come from the API without web search and may differ from the apps');
  return N;
}

const fmtRate = (r, zh) => (r == null ? (zh ? '无数据' : 'n/a') : r + '%');

/** 给模型看的文字摘要 */
function textSummary(res, zh = true) {
  const d = res.runData;
  const s = d.summary;
  const L = [];
  if (zh) {
    L.push(`AI 可见度监测「${d.brand}」完成（${d.stamp}）：问了 ${s.asked} 次，有效回答 ${s.total} 条。`);
    L.push(`提及率（不带品牌名的问题里，AI 主动提到品牌的比例）：${s.rate}%（${s.rateTotal} 条回答里 ${s.byQuestion.filter((q) => !q.brandQ || !s.byQuestion.some((x) => !x.brandQ)).reduce((x, q) => x + q.mentioned, 0)} 条提到）。`);
    if (s.brandQs) {
      const b = s.brandQs;
      L.push(`直接问品牌的问题 ${b.count} 个，${b.answers} 条回答（不计入提及率）：${b.unknown} 条表示不了解或查不到这个品牌${b.confused ? `，${b.confused} 条把它当成了同名的其他东西` : ''}；态度 正面 ${b.sentiment.positive}、中性 ${b.sentiment.neutral}、负面 ${b.sentiment.negative}。${b.descriptions.length ? 'AI 原话：' + b.descriptions.map((x) => `「${x}」`).join(' ') : ''}`);
    }
    L.push('\n各模型（不带品牌名的问题）：');
    for (const m of s.byModel) L.push(`- ${m.model}：${m.total ? `提及率 ${m.rate}%（${m.mentioned}/${m.total}${m.low ? '，样本少' : ''}）${m.avgPos ? `，提到时平均排第 ${m.avgPos}` : ''}` : '没有有效回答'}${m.errors ? `，失败 ${m.errors} 次（${m.errorReason}）` : ''}`);
    L.push('\n各问题：');
    for (const q of s.byQuestion) L.push(`- ${q.brandQ ? '（品牌词）' : fmtRate(q.rate, zh) + `（${q.mentioned}/${q.total}）`}  ${q.question}`);
    if (s.competitors.length) L.push('\n竞品出现率：' + s.competitors.map((c) => `${c.name} ${c.rate}%`).join('，'));
    if (s.topRecommended.length) L.push('AI 推荐最多的名字（原文出现次数）：' + s.topRecommended.slice(0, 10).map((r) => `${r.name}（${r.n}）`).join('，'));
    if (s.descriptions.length) L.push('行业问题里 AI 提到品牌时的原话：' + s.descriptions.map((x) => `「${x}」`).join(' '));
    L.push(s.sources.length ? 'AI 回答里写出的信息来源：' + s.sources.map((x) => `${x.name}（${x.n}）`).join('，') : 'AI 回答里没有写出具体的信息来源。');
    if (res.history.length > 1) L.push('\n同一组问题的历次提及率：' + res.history.slice(-8).map((h) => `${h.stamp.slice(5)} ${h.summary.rate}%`).join(' → '));
    if (res.skipped?.length) L.push('跳过的模型：' + res.skipped.map((x) => `${x.name}（${x.why === 'plan' ? '需要更高会员' : '平台没有'}）`).join('、'));
    L.push('\n数据可信度：\n' + qualityNotes(res, zh).map((x) => '- ' + x).join('\n'));
    L.push('\n完整报告（每条原始回答都在里面，品牌名已高亮）：' + path.relative(path.dirname(path.dirname(res.projDir)), res.reportFile));
    L.push(`\n解读要求：
1. 只根据上面的数字和 AI 原话下结论，先说结论再说依据，引用数字时带上样本数（比如「20 条里 0 条」）。
2. 样本少、失败多的部分不要下「表现好 / 差」的结论；提及率是 0 就直说 AI 目前不会主动推荐它。
3. AI 原话只代表模型怎么说，不代表事实，也不说明网上已经有相关内容；网上信息少的品牌，AI 说出的具体介绍（年限、规模、价格）很可能是编的，要提醒用户。
4. 再给 3～5 条具体建议（该在哪些平台发什么样的真实内容、官网和工商信息要补什么），提醒不要发虚假测评。
5. 最后问用户：要不要用 geo_content 生成可发布的内容（需要先向用户要品牌真实信息），以及要不要设成定期监测（传 project 即可重复同一组问题）。`);
  } else {
    L.push(`AI visibility check for "${d.brand}" (${d.stamp}): ${s.total}/${s.asked} valid answers. Mention rate (questions without the brand name): ${s.rate}% of ${s.rateTotal}.`);
    for (const m of s.byModel) L.push(`- ${m.model}: ${m.total ? `${m.rate}% (${m.mentioned}/${m.total})` : 'no valid answers'}${m.errors ? `, ${m.errors} failed` : ''}`);
    for (const q of s.byQuestion) L.push(`- ${q.brandQ ? '(brand) ' : fmtRate(q.rate, zh) + ' '}${q.question}`);
    if (s.brandQs) L.push(`Brand-name questions: ${s.brandQs.unknown}/${s.brandQs.answers} say they don't know the brand. Quotes: ${s.brandQs.descriptions.join(' | ')}`);
    if (s.topRecommended.length) L.push('Most recommended: ' + s.topRecommended.slice(0, 10).map((r) => `${r.name} (${r.n})`).join(', '));
    L.push('Data quality:\n' + qualityNotes(res, zh).map((x) => '- ' + x).join('\n'));
    L.push('Report: ' + path.relative(path.dirname(path.dirname(res.projDir)), res.reportFile));
    L.push('Interpret only what the numbers and quotes show, cite sample sizes, do not over-claim on small samples, treat AI descriptions of little-known brands as possibly invented, give 3-5 concrete suggestions (no fake reviews), then offer geo_content (ask for real facts first) and scheduled re-checks.');
  }
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
function renderReport(d, history, zh, notes = []) {
  const s = d.summary;
  const names = [d.brand, ...(d.aliases || [])].filter((n) => n && n.length >= 2).sort((a, b) => b.length - a.length);
  const hl = (text) => { let h = esc(text); for (const n of names) h = h.split(esc(n)).join(`<mark>${esc(n)}</mark>`); return h; };
  const fr = (r) => (r == null ? '—' : bar(r));
  const t = zh
    ? { title: 'AI 可见度报告', rate: '提及率（不带品牌名的问题）', answers: '提到 / 回答数', quality: '数据可信度', brandQ: '直接问品牌时 AI 怎么说', unknown: '表示不了解', confusedT: '同名混淆', lowT: '样本少', failT: '全部失败', n: '{n} 条', byModel: '各模型表现', model: '模型', mention: '提及率', avg: '平均排名', top3: '进前三', byQ: '各问题提及率', rec: 'AI 推荐最多的名字', comp: '竞品出现率', src: 'AI 提到的信息来源', desc: '行业问题里 AI 提到你的原话', sent: '态度', pos: '正面', neu: '中性', neg: '负面', trend: '历次总提及率', raw: '全部原始回答', none: '无', note: '说明：通过接口直接提问各模型（没有打开联网搜索），和在 App 里提问的结果可能不同。每个问题问了多次，按统计结果看更可靠。', yes: '提到', no: '没提到', pos2: '第 {n} 位' }
    : { title: 'AI Visibility Report', rate: 'Mention rate (no brand name in question)', answers: 'Mentioned / answers', quality: 'Data quality', brandQ: 'When asked about the brand directly', unknown: 'Says it does not know', confusedT: 'Different entity', lowT: 'small sample', failT: 'all failed', n: '{n}', byModel: 'By model', model: 'Model', mention: 'Mention', avg: 'Avg rank', top3: 'Top 3', byQ: 'By question', rec: 'Most recommended', comp: 'Competitors', src: 'Sources cited', desc: 'How AI describes you', sent: 'Sentiment', pos: 'Positive', neu: 'Neutral', neg: 'Negative', trend: 'Mention rate over time', raw: 'All answers', none: 'None', note: 'Answers come from the model APIs without web search and may differ from the apps.', yes: 'Mentioned', no: 'Not mentioned', pos2: '#{n}' };
  const answersHtml = d.questions.map((q) => {
    const as = d.answers.filter((a) => a.question === q);
    return `<details><summary>${esc(q)} <em>${as.filter((a) => a.mentioned).length}/${as.filter((a) => a.answer).length}</em></summary>${as.map((a) => `
      <div class="ans"><div class="ah"><b>${esc(a.modelLabel)}</b> #${a.round} <span class="tag ${a.mentioned ? 'ok' : ''}">${a.error ? esc(a.error) : a.confused ? t.confusedT : a.mentioned ? t.yes + (a.position ? ' · ' + t.pos2.replace('{n}', a.position) : '') + (a.unknown ? ' · ' + t.unknown : '') : t.no}</span>${a.answer && a.analyzed === false ? ` <span class="tag">${zh ? '自动分析失败' : 'analysis failed'}</span>` : ''}</div>
      ${a.recommended?.length ? `<div class="rec">${a.recommended.map((r) => `<span>${esc(r)}</span>`).join('')}</div>` : ''}
      ${a.quote ? `<div class="quote">${zh ? 'AI 原话' : 'Quote'}：「${esc(a.quote)}」</div>` : ''}<pre>${hl(a.answer)}</pre></div>`).join('')}</details>`;
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
.note{color:var(--muted);font-size:12px}mark{background:#fde7a8;color:inherit;border-radius:3px}@media (prefers-color-scheme:dark){mark{background:#6b5418}}.quote{font-size:12.5px;margin:4px 0}.q li{margin:2px 0}.warnc{border-color:var(--accent)}.neg{color:var(--warn)}.posi{color:var(--ok)}
</style></head><body><main>
<h1>${esc(d.brand)} · ${t.title}</h1><div class="sub">${esc(d.stamp)} · ${d.models.map((m) => esc(m.label)).join(' / ')} · ${d.questions.length} × ${d.repeats}</div>
<div class="kpis"><div class="kpi"><b>${s.rate}%</b><span>${t.rate}</span></div><div class="kpi"><b>${s.byQuestion.filter((q) => !q.brandQ || !s.byQuestion.some((x) => !x.brandQ)).reduce((x, q) => x + q.mentioned, 0)}/${s.rateTotal}</b><span>${t.answers}</span></div>
<div class="kpi"><b><span class="posi">${s.sentiment.positive}</span> / ${s.sentiment.neutral} / <span class="neg">${s.sentiment.negative}</span></b><span>${t.sent}：${t.pos} / ${t.neu} / ${t.neg}</span></div></div>
<div class="card warnc"><h2>${t.quality}</h2><ul class="q">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>
${s.brandQs ? `<div class="card"><h2>${t.brandQ}</h2><p>${s.brandQs.answers} ${zh ? '条回答' : 'answers'} · ${t.unknown} ${s.brandQs.unknown}${s.brandQs.confused ? ` · ${t.confusedT} ${s.brandQs.confused}` : ''} · ${t.pos} ${s.brandQs.sentiment.positive} / ${t.neu} ${s.brandQs.sentiment.neutral} / ${t.neg} ${s.brandQs.sentiment.negative}</p>${s.brandQs.descriptions.length ? `<ul>${s.brandQs.descriptions.map((x) => `<li>「${esc(x)}」</li>`).join('')}</ul>` : ''}</div>` : ''}
${history.length > 1 ? `<div class="card"><h2>${t.trend}</h2>${trendSvg(history)}</div>` : ''}
<div class="card"><h2>${t.byModel}</h2><table><tr><th>${t.model}</th><th>${t.mention}</th><th>${t.avg}</th><th>${t.top3}</th></tr>
${s.byModel.map((m) => `<tr><td>${esc(m.model)}<br><span class="note">${m.total ? t.n.replace('{n}', m.total) + (m.low ? ' · ' + t.lowT : '') : t.failT}${m.errors ? ` · ${zh ? '失败' : 'failed'} ${m.errors}` : ''}</span></td><td>${m.total ? fr(m.rate) : '—'}</td><td>${m.avgPos ?? '—'}</td><td>${m.top3 == null ? '—' : m.top3 + '%'}</td></tr>`).join('')}</table></div>
<div class="card"><h2>${t.byQ}</h2><table>${s.byQuestion.map((q) => `<tr><td>${esc(q.question)}${q.brandQ ? ` <span class="tag">${zh ? '品牌词，不计入提及率' : 'brand name, excluded'}</span>` : ''}</td><td style="width:200px">${q.rate == null ? '—' : bar(q.rate, q.brandQ ? 'var(--muted)' : undefined)}<span class="note">${t.n.replace('{n}', q.total)}</span></td></tr>`).join('')}</table></div>
${s.competitors.length ? `<div class="card"><h2>${t.comp}</h2><table><tr><td>${esc(d.brand)}</td><td style="width:240px">${bar(s.rate)}</td></tr>${s.competitors.map((c) => `<tr><td>${esc(c.name)}</td><td>${bar(c.rate, 'var(--muted)')}</td></tr>`).join('')}</table></div>` : ''}
<div class="card"><h2>${t.rec}</h2><div class="chips">${s.topRecommended.length ? s.topRecommended.map((r) => `<span>${esc(r.name)} · ${r.n}</span>`).join('') : t.none}</div></div>
${s.descriptions.length ? `<div class="card"><h2>${t.desc}</h2><ul>${s.descriptions.map((x) => `<li>「${esc(x)}」</li>`).join('')}</ul></div>` : ''}
<div class="card"><h2>${t.src}</h2><div class="chips">${s.sources.length ? s.sources.map((x) => `<span>${esc(x.name)} · ${x.n}</span>`).join('') : t.none}</div></div>
<div class="card"><h2>${t.raw}</h2>${answersHtml}</div>
</main></body></html>`;
}

module.exports = { run, textSummary, qualityNotes, resolveModels, ruleAnalyze, groundAnswer, regroundRun, summarize, renderReport, DEFAULT_MODELS, ANALYSIS_VERSION };
