// 错误上报：程序报错、界面崩溃、AI 回复失败等自动发给服务端，后台「错误统计」按出现次数排序。
// 只发错误信息、出错位置和少量上下文（模型、版本、系统），不发对话内容、文件内容；
// 用户目录换成 ~，看起来像密钥、令牌、邮箱的都打码。设置里可以关掉（errorReports: false）。
const crypto = require('crypto');
const os = require('os');

const FLUSH_MS = 60 * 1000; // 最多一分钟发一次
const MAX_PENDING = 50; // 一批最多攒这么多种
const MAX_PER_FP = 200; // 同一种错误一次运行最多记这么多次（死循环报错时不刷屏）

let o = null; // { api(pathname, opts), enabled(), loggedIn(), version(), platform() }
const pending = new Map(); // fp -> {fp, kind, message, stack, context, count}
const recentList = []; // 最近 10 条（「有问题」反馈时附上）
const seen = new Map(); // fp -> 本次运行出现次数
let timer = null;
const HOME = os.homedir();

function scrub(s, n) {
  let t = String(s ?? '');
  if (HOME && HOME.length > 3) t = t.split(HOME).join('~').split(HOME.replace(/\\/g, '/')).join('~');
  t = t
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\b(sk|shm|sha|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]+/g, 'eyJ***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***')
    .replace(/([?&](?:key|token|access_token|sig|signature)=)[^&\s]+/gi, '$1***');
  return n && t.length > n ? t.slice(0, n) : t;
}
/** 指纹：去掉数字、引号里的内容、路径，同一类错误归到一起 */
function normalize(msg) {
  return String(msg || '')
    .replace(/(['"`「“]).*?(['"`」”])/g, '_')
    .replace(/(~|[A-Za-z]:)?[\\/][^\s:]+/g, '/_')
    .replace(/\d+/g, '0')
    .slice(0, 200);
}
function topFrame(stack) {
  const lines = String(stack || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at '));
  const own = lines.find((l) => /[\\/](src|renderer)[\\/][\w-]+\.js/.test(l) && !/node_modules/.test(l)) || lines[0] || '';
  return own.replace(/^.*[\\/]((?:renderer[\\/])?[\w-]+\.js):(\d+):\d+.*$/, '$1:$2');
}

/** kind：main / renderer / crash / agent / update；err：Error、字符串或 {message, stack} */
function report(kind, err, context) {
  try {
    if (!o || !o.enabled()) return;
    const message = scrub(err?.message ?? err ?? 'unknown', 500).trim() || 'unknown';
    const stack = err?.stack ? scrub(err.stack, 4000) : '';
    recentList.push({ at: new Date().toISOString().slice(11, 19), kind, message: message.slice(0, 200) });
    if (recentList.length > 10) recentList.shift();
    const fp = crypto.createHash('sha1').update(`${kind}|${normalize(message)}|${topFrame(stack)}`).digest('hex').slice(0, 16);
    const n = (seen.get(fp) || 0) + 1;
    seen.set(fp, n);
    if (n > MAX_PER_FP) return;
    const cur = pending.get(fp);
    if (cur) cur.count++;
    else {
      if (pending.size >= MAX_PENDING) return;
      const ctx = context ? scrub(JSON.stringify(context), 1000) : undefined;
      pending.set(fp, { fp, kind, message, stack: stack || undefined, context: ctx, count: 1 });
    }
    if (!timer) timer = setTimeout(flush, n === 1 && seen.size <= 1 ? 10000 : FLUSH_MS);
  } catch {}
}

async function flush() {
  timer = null;
  if (!pending.size || !o) return;
  if (!o.enabled()) return pending.clear();
  // 还没登录：先攒着，登录后再发
  if (!o.loggedIn()) {
    timer = setTimeout(flush, FLUSH_MS);
    return;
  }
  const batch = [...pending.values()].slice(0, 20);
  for (const e of batch) pending.delete(e.fp);
  try {
    const r = await o.api('/aidesk/client/errors', { method: 'POST', body: { errors: batch, appVersion: o.version(), platform: o.platform() }, timeout: 15000 });
    // 网络不通：放回去下次再发（只放回还有空位的）
    if (!r.ok && (r.error === 'network' || r.error === 'timeout')) for (const e of batch) if (pending.size < MAX_PENDING && !pending.has(e.fp)) pending.set(e.fp, e);
  } catch {}
  if (pending.size && !timer) timer = setTimeout(flush, FLUSH_MS);
}

function init(opts) {
  o = opts;
}

const recent = () => recentList.slice();

module.exports = { init, report, flush, recent, scrub, normalize, topFrame };
