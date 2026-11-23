// 跑准确率测试题：启动一个独立的测试客户端，逐题新建对话、发问、等做完，再自动判分。
// 用法（在 aidesk-desktop 目录）：
//   EVAL_ACCOUNT=测试账号 EVAL_PASSWORD=密码 node eval/run.mjs [--model "DeepSeek V4.1 Flash"] [--only fix-cart,csv-sum] [--compare eval/results/xxx.json] [--label 说明]
// 用的是线上服务和平台模型，会扣测试账号的额度。所有操作都设成「全部自动执行」，只在临时文件夹里做。
// 结果写到 eval/results/<时间>-<模型>.json，并打印一张表。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { tasks } from './tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = '') => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const MODEL = arg('model', 'DeepSeek V4.1 Flash');
const ONLY = arg('only') ? arg('only').split(',') : null;
const COMPARE = arg('compare');
const LABEL = arg('label');
const PORT = Number(arg('port', '9351'));
const PROFILE = arg('profile', path.join(os.homedir(), '.shuttle-eval-profile'));
const TASK_TIMEOUT = Number(arg('timeout', '300')) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 启动测试客户端，连上调试端口 ----------
const child = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
  cwd: ROOT,
  env: { ...process.env, AGENT_USER_DATA: PROFILE },
  stdio: 'ignore',
  detached: true,
});
const quit = () => {
  try {
    process.kill(-child.pid);
  } catch {}
};
process.on('exit', quit);
process.on('SIGINT', () => (quit(), process.exit(130)));

let ws;
let seq = 0;
const pend = {};
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((p) => p.type === 'page' && /renderer\/index\.html/.test(p.url));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          pend[d.id]?.(d);
        };
        return;
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error('测试客户端没有启动起来');
}
async function ev(expr) {
  const id = ++seq;
  const d = await new Promise((r) => {
    pend[id] = r;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  delete pend[id];
  if (d.result?.exceptionDetails) throw new Error(d.result.exceptionDetails.exception?.description || d.result.exceptionDetails.text);
  return d.result?.result?.value;
}

// ---------- 主流程 ----------
await connect();
await sleep(4000);
// 登录：没登录或中途被顶掉（免费账号只能一台设备在线）时重新登录
async function ensureLogin(force) {
  const st = force ? null : await ev(`window.api.authStatus()`);
  if (st?.user) return;
  if (!process.env.EVAL_ACCOUNT || !process.env.EVAL_PASSWORD) throw new Error('测试客户端没登录：请设置 EVAL_ACCOUNT / EVAL_PASSWORD');
  const r = await ev(`window.api.login(${JSON.stringify(process.env.EVAL_ACCOUNT)}, ${JSON.stringify(process.env.EVAL_PASSWORD)})`);
  if (r?.error) throw new Error('登录失败：' + r.error);
  await ev(`location.reload(), 1`);
  await sleep(5000);
}
await ensureLogin();
const models = await ev(`(settings.platformModels || []).map((m) => ({ value: m.value, label: m.label }))`);
const model = models.find((m) => m.label === MODEL || m.value === MODEL) || models.find((m) => m.label.includes(MODEL));
if (!model) throw new Error(`找不到模型「${MODEL}」，可选：${models.map((m) => m.label).join('、')}`);
await ev(`window.api.saveSettings({ approval: 'all', chatExpert: '', useOwnKey: false, platformModel: ${JSON.stringify(model.value)}, effort: 'standard', suggestNext: false }).then((s) => ((settings = s), renderModelSel(), 1))`);
console.log(`模型：${model.label}（${model.value}）  测试题：${ONLY ? ONLY.length : tasks.length} 道\n`);

const results = [];
const LOGIN_LOST = /登录已失效|请先登录|重新登录|log in again|sign in again/i;
for (const t of tasks) {
  if (ONLY && !ONLY.includes(t.id)) continue;
  for (let attempt = 0; attempt < 2; attempt++) {
  const dir = t.folder === false ? '' : fs.mkdtempSync(path.join(os.tmpdir(), `shuttle-eval-${t.id}-`));
  if (dir) t.setup(dir);
  const t0 = Date.now();
  let timedOut = false;
  await ev(`(async () => { ${dir ? `await newChatIn(${JSON.stringify(dir)});` : `document.getElementById('newBtn').click(); await new Promise((r) => setTimeout(r, 400)); settings = await window.api.setWorkspace(''); renderWorkspace();`} await new Promise((r) => setTimeout(r, 300)); const ta = document.getElementById('input'); ta.value = ${JSON.stringify(t.prompt)}; ta.dispatchEvent(new Event('input')); document.getElementById('sendBtn').click(); return 1; })()`);
  await sleep(1500);
  while ((await ev(`running`)) === true) {
    if (Date.now() - t0 > TASK_TIMEOUT) {
      timedOut = true;
      await ev(`window.api.stop(currentConvId), 1`);
      await sleep(2000);
      break;
    }
    await sleep(1000);
  }
  await sleep(800);
  const info = await ev(`(async () => {
    const c = currentConvId ? await window.api.openConv(currentConvId) : null;
    const msgs = c ? c.messages : [];
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user');
    const turn = msgs.slice(lastUser + 1);
    const names = {};
    for (const m of turn) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) names[tc.function.name] = (names[tc.function.name] || 0) + 1;
    const answer = [...turn].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())?.content || '';
    const usage = document.getElementById('usage')?.textContent || '';
    const errors = [...document.querySelectorAll('#log .msg.error')].map((e) => e.innerText.slice(0, 200));
    return { answer, calls: turn.filter((m) => m.role === 'assistant').length, tools: names, usage, errors };
  })()`);
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  const tokens = Number((/([\d,]+)\s*tokens/.exec(info.usage) || [])[1]?.replace(/,/g, '') || 0);
  let verdict;
  try {
    verdict = timedOut ? { pass: false, reason: '超时' } : await t.check({ dir, answer: info.answer });
  } catch (e) {
    verdict = { pass: false, reason: '判分出错：' + e.message };
  }
  if (attempt === 0 && !info.calls && info.errors.some((e) => LOGIN_LOST.test(e))) {
    console.log(`  （${t.id}：登录掉了，重新登录后重跑）`);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    await ensureLogin(true);
    await ev(`window.api.saveSettings({ approval: 'all', chatExpert: '', useOwnKey: false, platformModel: ${JSON.stringify(model.value)}, effort: 'standard', suggestNext: false }).then((s) => ((settings = s), renderModelSel(), 1))`);
    continue;
  }
  const toolCount = Object.values(info.tools).reduce((a, b) => a + b, 0);
  const row = { id: t.id, category: t.category, pass: verdict.pass, reason: verdict.reason || (info.errors[0] || ''), secs, calls: info.calls, toolCount, tools: info.tools, tokens, answer: info.answer.slice(0, 600), errors: info.errors };
  results.push(row);
  console.log(`${verdict.pass ? '✓' : '✗'} ${t.id.padEnd(14)} ${String(secs).padStart(6)}s  调用 ${String(info.calls).padStart(2)}  工具 ${String(toolCount).padStart(2)}  ${String(tokens).padStart(7)} tokens  ${verdict.pass ? '' : row.reason.slice(0, 80)}`);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  break;
  }
}

// ---------- 汇总 ----------
const sum = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);
const byCat = {};
for (const x of results) (byCat[x.category] ||= []).push(x);
console.log('\n分类        通过     平均耗时   平均 tokens');
for (const [c, a] of Object.entries(byCat)) console.log(`${c.padEnd(8)}  ${a.filter((x) => x.pass).length}/${a.length}   ${(sum(a, 'secs') / a.length).toFixed(1).padStart(7)}s   ${Math.round(sum(a, 'tokens') / a.length).toString().padStart(8)}`);
const passN = results.filter((x) => x.pass).length;
console.log(`合计        ${passN}/${results.length}   ${(sum(results, 'secs') / results.length).toFixed(1).padStart(7)}s   ${Math.round(sum(results, 'tokens') / results.length).toString().padStart(8)}`);

const outDir = path.join(ROOT, 'eval', 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace(/[:T]/g, '-');
const out = path.join(outDir, `${stamp}-${model.label.replace(/[^\w一-龥.-]+/g, '_')}.json`);
const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
fs.writeFileSync(out, JSON.stringify({ model, label: LABEL, appVersion, at: new Date().toISOString(), pass: passN, total: results.length, results }, null, 2));
console.log(`\n结果：${path.relative(ROOT, out)}`);

if (COMPARE) {
  const old = JSON.parse(fs.readFileSync(path.resolve(COMPARE), 'utf8'));
  const om = Object.fromEntries(old.results.map((x) => [x.id, x]));
  console.log(`\n和 ${path.basename(COMPARE)}（${old.pass}/${old.total}）对比：`);
  for (const x of results) {
    const o = om[x.id];
    if (!o) continue;
    const flag = o.pass === x.pass ? ' ' : x.pass ? '↑' : '↓';
    console.log(`${flag} ${x.id.padEnd(14)} ${o.pass ? '✓' : '✗'}→${x.pass ? '✓' : '✗'}  ${o.secs}s→${x.secs}s  工具 ${o.toolCount}→${x.toolCount}  tokens ${o.tokens}→${x.tokens}`);
  }
}
quit();
process.exit(0);
