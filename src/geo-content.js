// GEO 内容生成：根据 AI 可见度监测的结果（哪些问题下 AI 没提到你、AI 更常推荐谁、AI 对你的误解），
// 按用户提供的真实信息，为每个问题写适合发到知乎、百家号、头条、小红书的文章，外加官网 FAQ 页（含结构化数据）和 llms.txt。
// 只生成内容存到本地，不替用户发布；不编造数据、评价和案例，缺的信息用【待补充：…】标出来。
// 依赖由 main.js 注入（调模型、确认框、进度），这里不碰 Electron。
const fs = require('fs');
const path = require('path');
const geo = require('./geo');

const PLATFORMS = {
  zhihu: { zh: '知乎回答', en: 'Zhihu answer', words: '1200～1800 字', note: 'DeepSeek、千问、Kimi 联网时常引用' },
  baijiahao: { zh: '百家号文章', en: 'Baijiahao article', words: '1000～1500 字', note: '文心一言（百度）常引用' },
  toutiao: { zh: '头条文章', en: 'Toutiao article', words: '1000～1500 字', note: '豆包常引用头条、抖音' },
  xiaohongshu: { zh: '小红书笔记', en: 'Xiaohongshu note', words: '400～700 字', note: '年轻用户搜索多，豆包、千问也会引用' },
};
const DEFAULT_PLATFORMS = ['zhihu', 'baijiahao', 'xiaohongshu'];
const MAX_ARTICLES = 40;

const slug = (s) => String(s || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const RULES = `写作规则（必须遵守）：
1. 只使用下面「品牌真实信息」里给出的事实。不要编造数据、价格、年份、奖项、资质、学员 / 客户数量、用户评价、具体案例或人物经历。确实需要但没给出的信息，写成【待补充：需要什么】，让品牌方自己填。
2. 不要以消费者身份写「我买了 / 我家孩子上了」这类亲身体验，也不要虚构对话和好评——这属于虚假测评。用客观科普、选购攻略或品牌方介绍的口吻。
3. 品牌全称在开头两段内出现，后文自然地再出现两三次；不要每句都提。
4. 要直接回答标题里的问题，给出判断标准和具体信息（地址、适合谁、怎么选、价格区间等有就写），结构清楚，方便 AI 摘取引用。
5. 可以客观提到其他选择，但不要贬低、点名攻击竞品。
6. 遵守广告法：不用「最」「第一」「顶级」「唯一」「100%」等绝对化用语，不承诺效果。
7. 直接输出正文，第一行写「标题：……」，第二行开始是正文（Markdown）。不要输出其他说明。`;

function factsBlock(c) {
  return `品牌：${c.brand}${c.aliases.length ? `（也叫：${c.aliases.join('、')}）` : ''}
${c.website ? `官网：${c.website}\n` : ''}品牌真实信息：
${c.facts}`;
}
function contextBlock(c) {
  const L = [];
  if (c.aiRecommends.length) L.push(`AI 在回答这类问题时常推荐：${c.aiRecommends.join('、')}。可以客观说明${c.brand}和它们的区别、适合什么人。`);
  if (c.aiDescriptions.length) L.push(`AI 目前对${c.brand}的描述：${c.aiDescriptions.map((x) => `「${x}」`).join(' ')}。如果有误解（比如当成了同名的其他品牌），文中要明确写清楚${c.brand}具体是什么，避免混淆。`);
  return L.length ? '\n参考（来自 AI 可见度监测）：\n' + L.join('\n') : '';
}

const ARTICLE_PROMPT = (c, platform, question) => {
  const p = PLATFORMS[platform];
  const style = {
    zhihu: `以知乎回答的形式写，标题就是这个问题本身。先用两三句话直接给结论，再分点展开判断标准和选择建议，${c.brand}作为其中一个具体选项给出理由。语气专业、客观。`,
    baijiahao: '写一篇百家号攻略 / 科普文章。标题包含问题里的关键词（可以改写得更像文章标题），开头一段总结要点，正文用小标题分段。',
    toutiao: '写一篇头条文章。标题包含问题里的关键词，口语化、信息密度高，用小标题分段，结尾有简短总结。',
    xiaohongshu: '写一篇小红书笔记。标题不超过 20 个字，可以带一两个 emoji；正文分短段、要点清晰，可适量用 emoji；最后一行写 5～8 个话题标签（#xxx）。用品牌方或科普博主的口吻，不要伪装成消费者。',
  }[platform];
  return `请为「${c.brand}」写一篇用于发布在${p.zh.replace(/回答|文章|笔记/, '')}的内容，回答这个用户常问的问题：

问题：${question}

${style}
篇幅：${p.words}。

${factsBlock(c)}
${contextBlock(c)}

${RULES}`;
};

const FAQ_PROMPT = (c, questions) => `请为「${c.brand}」的官网 FAQ 页面，逐条回答下面的问题。每条回答 80～200 字，第一句直接给答案，客观、具体，提到${c.brand}。

${factsBlock(c)}
${contextBlock(c)}

${RULES.split('\n').slice(0, 7).join('\n')}
只输出一个 JSON 数组，不要输出其他内容，格式：[{"q":"问题原文","a":"回答"}]

问题：
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

function parseArticle(text, fallbackTitle) {
  let t = String(text || '').trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
  let title = fallbackTitle;
  const m = /^(?:#+\s*)?(?:\*\*)?标题(?:\*\*)?[:：]\s*(.+)$/m.exec(t.split('\n').slice(0, 3).join('\n'));
  if (m) {
    title = m[1].replace(/\*\*/g, '').trim();
    t = t.slice(t.indexOf(m[0]) + m[0].length).trim();
  } else {
    const h = /^#\s+(.+)$/m.exec(t.split('\n')[0] || '');
    if (h) {
      title = h[1].trim();
      t = t.split('\n').slice(1).join('\n').trim();
    }
  }
  return { title, body: t };
}
function parseJsonArray(text) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  if (!m) return null;
  try {
    const a = JSON.parse(m[0]);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
}
const countChars = (s) => String(s || '').replace(/\s|[#*>`\-]/g, '').length;
const placeholders = (s) => (String(s || '').match(/【待补充[：:][^】]*】/g) || []);

async function pool(items, n, fn, signal) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) await fn(items[i++]);
  }));
}

/** 读项目最近一次监测，挑出 AI 提及率低的问题 */
function loadLatestRun(projDir) {
  const dir = path.join(projDir, 'runs');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort().pop();
  if (!f) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * deps: { platformModels, level, ask(model, messages, maxTokens) → {text, error}, confirm(info) → bool, progress(text), signal, scheduled, lang }
 */
async function run(args, root, deps) {
  const zh = deps.lang !== 'en';
  const base = path.join(root, 'ai-visibility');
  const projSlug = slug(args.project || args.brand);
  const projDir = path.join(base, projSlug);
  const cfgFile = path.join(projDir, 'config.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {}
  const brand = String(args.brand || saved.brand || '').trim().slice(0, 60);
  if (!brand) return { error: zh ? '请提供 brand（品牌名），或者用 project 指定一个已经做过 AI 可见度监测的项目。' : 'Provide brand, or project of a monitored project.' };
  const facts = String(args.facts || saved.facts || '').trim().slice(0, 4000);
  if (facts.length < 30) {
    return {
      needFacts: true,
      error: zh
        ? '缺少品牌真实信息（facts）。内容只能基于真实信息写，请先向用户问清楚：品牌 / 公司是做什么的、主要产品或服务、面向谁、所在城市和地址、价格区间、和别家的区别、能公开的资质或数据、联系方式等，再把整理好的文字作为 facts 传进来（会保存，下次不用再问）。'
        : 'Missing facts. Ask the user for real brand information (what they do, products, audience, location, price range, differentiators, verifiable credentials, contact), then pass it as facts.',
    };
  }
  const aliases = (args.aliases || saved.aliases || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 10);
  const website = String(args.website || saved.website || '').trim().slice(0, 200);
  const last = loadLatestRun(projDir);

  // 选问题：用户指定的优先；否则取最近一次监测里提及率最低的
  let questions = (args.questions || []).map((s) => String(s).trim()).filter(Boolean);
  let fromRun = false;
  if (!questions.length && last?.summary?.byQuestion?.length) {
    const sorted = [...last.summary.byQuestion].sort((a, b) => a.rate - b.rate);
    const weak = sorted.filter((q) => q.rate < 60);
    questions = (weak.length ? weak : sorted).map((q) => q.question);
    fromRun = true;
  }
  if (!questions.length && Array.isArray(saved.questions)) questions = saved.questions;
  questions = [...new Set(questions)].slice(0, Math.max(1, Math.min(20, Number(args.limit) || 8)));
  if (!questions.length) return { error: zh ? '没有可写的问题：请传 questions，或者先用 ai_visibility 监测一次。' : 'No questions: pass questions or run ai_visibility first.' };

  const platforms = [...new Set((args.platforms && args.platforms.length ? args.platforms : DEFAULT_PLATFORMS).map((p) => String(p).toLowerCase()).filter((p) => PLATFORMS[p]))];
  if (!platforms.length) return { error: (zh ? '平台只能是：' : 'Platforms: ') + Object.keys(PLATFORMS).join('、') };
  const withSite = args.site !== false;
  const total = questions.length * platforms.length;
  if (total > MAX_ARTICLES) return { error: zh ? `一次要写 ${total} 篇，超过上限 ${MAX_ARTICLES}，请减少问题或平台。` : `${total} articles exceeds the limit of ${MAX_ARTICLES}.` };

  const { models, skipped } = geo.resolveModels([args.model || 'deepseek', 'doubao', 'glm'], deps.platformModels, deps.level);
  const model = models[0];
  if (!model) return { error: (zh ? '没有可用的写作模型。' : 'No writing model available. ') + skipped.map((s) => s.name).join('、') };

  const c = {
    brand, aliases, website, facts,
    aiRecommends: (last?.summary?.topRecommended || []).map((r) => r.name).filter((n) => !aliases.concat(brand).some((b) => n.includes(b) || b.includes(n))).slice(0, 6),
    aiDescriptions: (last?.summary?.descriptions || []).slice(0, 4),
  };
  const mult = model.multiplier || 1;
  const estTokens = Math.round((platforms.reduce((s, p) => s + (p === 'xiaohongshu' ? 2200 : 4000), 0) * questions.length + (withSite ? 1500 + questions.length * 400 : 0)) * mult);
  if (!deps.scheduled) {
    const ok = await deps.confirm({
      title: zh
        ? `GEO 内容生成「${brand}」：${questions.length} 个问题 × ${platforms.length} 个平台 = ${total} 篇${withSite ? ' + 官网 FAQ' : ''}，预计约 ${(estTokens / 10000).toFixed(1)} 万 token`
        : `GEO content for "${brand}": ${total} articles${withSite ? ' + site FAQ' : ''}, about ${(estTokens / 1000).toFixed(0)}K tokens`,
      body: (zh ? '写作模型：' : 'Model: ') + model.label + (zh ? '\n平台：' : '\nPlatforms: ') + platforms.map((p) => PLATFORMS[p][zh ? 'zh' : 'en']).join('、') +
        (fromRun ? (zh ? '\n（问题取自最近一次监测里 AI 提及率最低的）' : '\n(questions with the lowest mention rate in the last check)') : '') +
        '\n\n' + questions.map((q, i) => `${i + 1}. ${q}`).join('\n') +
        (zh ? '\n\n依据的品牌信息（文章只会用这些，有不对或多出来的请取消后更正）：\n' : '\n\nBrand facts used (cancel and correct if anything is wrong):\n') + facts +
        (zh ? '\n\n只生成到本地，不会替你发布。' : '\n\nContent is saved locally only; nothing is published.'),
    });
    if (!ok) return { rejected: true };
  }
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ ...saved, brand, aliases, website, facts }, null, 2));

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const outDir = path.join(projDir, 'content', stamp.replace(/[: ]/g, '-') + '-' + pad(now.getSeconds()));
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 文章
  const tasks = [];
  questions.forEach((q, qi) => platforms.forEach((p) => tasks.push({ q, qi, p })));
  const articles = [];
  let done = 0;
  const steps = total + (withSite ? 1 : 0);
  await pool(tasks, 2, async (t) => {
    const r = await deps.ask(model.value, [{ role: 'user', content: ARTICLE_PROMPT(c, t.p, t.q) }], t.p === 'xiaohongshu' ? 1500 : 3000);
    done++;
    deps.progress(zh ? `正在写内容 ${done}/${steps}…` : `Writing ${done}/${steps}…`);
    if (r.error || !r.text) {
      articles.push({ ...t, error: r.error || 'empty' });
      return;
    }
    const { title, body } = parseArticle(r.text, t.q);
    const file = `${pad(t.qi + 1)}-${t.p}.md`;
    fs.writeFileSync(path.join(outDir, file), `# ${title}\n\n${body}\n`);
    articles.push({ ...t, title, body, file, chars: countChars(body), todo: placeholders(body) });
  }, deps.signal);
  if (deps.signal?.aborted) return { error: zh ? '已停止' : 'Stopped' };
  articles.sort((a, b) => a.qi - b.qi || platforms.indexOf(a.p) - platforms.indexOf(b.p));

  // 2. 官网 FAQ + 结构化数据 + llms.txt
  let faq = [];
  if (withSite) {
    const r = await deps.ask(model.value, [{ role: 'user', content: FAQ_PROMPT(c, questions) }], Math.min(4000, 600 + questions.length * 350));
    done++;
    deps.progress(zh ? `正在写内容 ${done}/${steps}…` : `Writing ${done}/${steps}…`);
    const arr = parseJsonArray(r.text) || [];
    faq = arr.filter((x) => x && x.q && x.a).map((x) => ({ q: String(x.q).trim(), a: String(x.a).trim() })).slice(0, questions.length);
    if (faq.length) {
      const siteDir = path.join(outDir, 'site');
      fs.mkdirSync(siteDir, { recursive: true });
      const ld = faqJsonLd(c, faq);
      fs.writeFileSync(path.join(siteDir, 'faq-schema.json'), JSON.stringify(ld, null, 2));
      fs.writeFileSync(path.join(siteDir, 'faq.html'), faqHtml(c, faq, ld, zh));
      fs.writeFileSync(path.join(siteDir, 'llms.txt'), llmsTxt(c, faq));
    }
  }

  const res = { brand, outDir, projDir, model: model.label, platforms, questions, articles, faq, fromRun, hasRun: !!last, stamp };
  fs.writeFileSync(path.join(outDir, 'content.json'), JSON.stringify({ ...res, facts }, null, 2));
  res.indexFile = path.join(outDir, 'index.html');
  fs.writeFileSync(res.indexFile, renderIndex(res, zh));
  return res;
}

function faqJsonLd(c, faq) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', name: c.brand, ...(c.aliases.length ? { alternateName: c.aliases } : {}), ...(c.website ? { url: c.website } : {}), description: c.facts.split('\n')[0].slice(0, 200) },
      { '@type': 'FAQPage', mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) },
    ],
  };
}
function llmsTxt(c, faq) {
  return `# ${c.brand}\n\n> ${c.facts.split('\n')[0].slice(0, 200)}\n\n## 关于${c.brand}\n\n${c.facts}\n${c.website ? `\n官网：${c.website}\n` : ''}\n## 常见问题\n\n${faq.map((x) => `### ${x.q}\n\n${x.a}\n`).join('\n')}`;
}
function faqHtml(c, faq, ld, zh) {
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(c.brand)} · ${zh ? '常见问题' : 'FAQ'}</title><meta name="description" content="${esc(c.facts.split('\n')[0].slice(0, 120))}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>body{margin:0;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;background:#fff;padding:24px 16px}main{max-width:760px;margin:0 auto}h1{font-size:24px}h2{font-size:17px;margin:24px 0 6px}p{margin:0;color:#444}</style>
</head><body><main><h1>${esc(c.brand)} · ${zh ? '常见问题' : 'FAQ'}</h1>
${faq.map((x) => `<section><h2>${esc(x.q)}</h2><p>${esc(x.a)}</p></section>`).join('\n')}
</main></body></html>`;
}

/** 给模型看的文字摘要 */
function textSummary(res, zh = true) {
  const ok = res.articles.filter((a) => !a.error);
  const bad = res.articles.filter((a) => a.error);
  const todo = [...new Set(ok.flatMap((a) => a.todo))];
  const rel = (f) => path.relative(path.dirname(path.dirname(res.projDir)), f);
  const L = [];
  if (!zh) {
    L.push(`GEO content for "${res.brand}" done: ${ok.length} articles${bad.length ? `, ${bad.length} failed` : ''}${res.faq.length ? `, site FAQ with ${res.faq.length} Q&As (faq.html with schema.org JSON-LD, llms.txt)` : ''}. Folder: ${rel(res.outDir)}`);
    if (todo.length) L.push('Placeholders to fill: ' + todo.slice(0, 12).join(' '));
    L.push('Tell the user: review and fill placeholders before publishing, publish under their own accounts (Zhihu for DeepSeek/Qwen/Kimi, Baijiahao for ERNIE, Toutiao/Douyin for Doubao), put faq.html content and JSON-LD on their site and llms.txt at the site root, never post fake reviews, and re-run ai_visibility with project in 2-4 weeks to compare.');
    return L.join('\n');
  }
  L.push(`GEO 内容生成「${res.brand}」完成：写好 ${ok.length} 篇${bad.length ? `，失败 ${bad.length} 篇` : ''}（模型 ${res.model}）${res.faq.length ? `；官网 FAQ ${res.faq.length} 条（faq.html 含 schema.org 结构化数据、faq-schema.json、llms.txt）` : ''}。`);
  L.push('文件夹：' + rel(res.outDir) + '（index.html 汇总了全部内容，可一键复制）');
  for (const q of res.questions) {
    const as = ok.filter((a) => a.q === q);
    L.push(`- ${q}：` + as.map((a) => `${PLATFORMS[a.p].zh}《${a.title}》${a.chars}字`).join('；'));
  }
  if (bad.length) L.push('失败：' + bad.map((a) => `${a.q}（${PLATFORMS[a.p].zh}：${a.error}）`).join('；'));
  if (todo.length) L.push(`\n文中有 ${todo.length} 处需要品牌方补充的信息：` + todo.slice(0, 12).join(' '));
  L.push('\n请向用户简要说明：');
  L.push('1. 发布前逐篇看一遍，把【待补充】填上真实信息，删掉不准确的内容；');
  L.push('2. 用自己的账号发布：知乎（DeepSeek、千问、Kimi 联网常引用）、百家号（文心常引用）、头条 / 抖音（豆包常引用）、小红书；同一篇不要在同一平台重复发，也不要批量注册账号刷内容；');
  L.push('3. 官网：把 faq.html 的内容和里面的 JSON-LD 结构化数据放到官网的常见问题页，llms.txt 放到网站根目录；');
  L.push('4. 不要发虚假测评或冒充用户的好评；');
  L.push(`5. 发布后 2～4 周，用 ai_visibility（传 project「${path.basename(res.projDir)}」）再测一次，对比提及率变化。${res.hasRun ? '' : '这个项目还没做过监测，建议现在先测一次作为基线。'}`);
  return L.join('\n');
}

function renderIndex(res, zh) {
  const ok = res.articles.filter((a) => !a.error);
  const tips = Object.entries(PLATFORMS).filter(([k]) => res.platforms.includes(k)).map(([, p]) => `<li><b>${p.zh}</b>：${p.note}</li>`).join('');
  const item = (title, body, meta, file) => `<details class="card"><summary><b>${esc(title)}</b><span class="meta">${meta}</span></summary>
<div class="btns"><button data-copy="t">复制标题</button><button data-copy="b">复制正文</button>${file ? `<span class="file">${esc(file)}</span>` : ''}</div>
<textarea hidden class="t">${esc(title)}</textarea><textarea hidden class="b">${esc(body)}</textarea><pre>${esc(body).replace(/【待补充[：:][^】]*】/g, (m) => `<mark>${m}</mark>`)}</pre></details>`;
  const sections = res.questions.map((q, i) => {
    const as = ok.filter((a) => a.q === q);
    return `<h2>${i + 1}. ${esc(q)}</h2>${as.map((a) => item(a.title, a.body, `${PLATFORMS[a.p].zh} · ${a.chars} 字${a.todo.length ? ` · <em>${a.todo.length} 处待补充</em>` : ''}`, a.file)).join('')}`;
  }).join('');
  const faqSec = res.faq.length ? `<h2>官网常见问题（site/faq.html · faq-schema.json · llms.txt）</h2>${item('常见问题', res.faq.map((x) => `${x.q}\n${x.a}`).join('\n\n'), `${res.faq.length} 条`, 'site/faq.html')}` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(res.brand)} · GEO 内容</title><style>
:root{--bg:#f7f6f3;--card:#fff;--text:#222;--muted:#6b6b6b;--border:#e5e2db;--accent:#c96442;--mark:#fde7a8}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--text:#ecebe8;--muted:#a19f99;--border:#3a3935;--accent:#d97757;--mark:#6b5418}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;padding:20px 16px}
main{max-width:920px;margin:0 auto}h1{font-size:22px;margin:0 0 2px}h2{font-size:15px;margin:22px 0 8px}.sub{color:var(--muted);font-size:13px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:8px}summary{cursor:pointer}.meta{color:var(--muted);font-size:12px;margin-left:8px}.meta em{color:var(--accent);font-style:normal}
.tips{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 16px}.tips ul,.tips ol{margin:4px 0;padding-left:20px}
.btns{margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{border:1px solid var(--border);background:var(--bg);color:var(--text);border-radius:8px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px}button.done{color:var(--accent);border-color:var(--accent)}.file{color:var(--muted);font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;font:13px/1.65 inherit;background:var(--bg);border-radius:8px;padding:10px 12px;max-height:420px;overflow:auto;margin:0}mark{background:var(--mark);color:inherit;border-radius:3px}
</style></head><body><main>
<h1>${esc(res.brand)} · GEO 内容</h1><div class="sub">${esc(res.stamp)} · ${ok.length} 篇 · ${esc(res.model)} 生成${res.fromRun ? ' · 问题取自最近一次监测里 AI 提及率最低的' : ''}</div>
<div class="tips"><b>怎么用</b><ol>
<li>逐篇检查，把<mark>【待补充】</mark>填成真实信息，删掉不准确的地方。</li>
<li>用自己的账号发布，同一篇别在同一平台重复发：<ul>${tips}</ul></li>
${res.faq.length ? '<li>官网：faq.html 里的问答和 JSON-LD 结构化数据放到常见问题页，llms.txt 放到网站根目录。</li>' : ''}
<li>不要发虚假测评、冒充用户的好评。</li>
<li>发布 2～4 周后，在 Shuttle 里说「${esc(path.basename(res.projDir))} 再测一次 AI 可见度」，看提及率有没有提升。</li></ol></div>
${sections}${faqSec}
<script>
document.addEventListener('click',async(e)=>{const b=e.target.closest('button[data-copy]');if(!b)return;const v=b.closest('details').querySelector('textarea.'+b.dataset.copy).value;
try{await navigator.clipboard.writeText(v)}catch{const t=document.createElement('textarea');t.value=v;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove()}
const o=b.textContent;b.textContent='已复制';b.classList.add('done');setTimeout(()=>{b.textContent=o;b.classList.remove('done')},1200)});
</script></main></body></html>`;
}

module.exports = { run, textSummary, parseArticle, renderIndex, PLATFORMS, DEFAULT_PLATFORMS };
