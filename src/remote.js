// 手机网页远程控制这台电脑（设置 →「远程控制」里打开，默认关闭）。
//
// 流程：电脑长轮询服务端 /aidesk/remote/poll 拿命令 → 执行 → 结果、进度通过 /aidesk/remote/events 发回网页。
// 服务端只做同一账号内的转发；能不能控制这台电脑由这里决定：
//   - 网页第一次连接要「配对」：电脑上弹窗，核对手机上显示的验证码，允许后记住这个网页（remoteTrusted）
//     按「手机浏览器」认（wid：网页登录时带的设备 id，服务端从登录会话里取，网页没法冒充），
//     所以同一部手机退出再登录、登录过期重登都不用再确认；只有在手机上点「取消授权」或电脑上移除才需要重新确认
//   - 没配对的网页只能发 ping / pair
//   - 远程发起的任务里，改文件、执行命令一律要确认（手机上点允许，或在电脑上点）
//   - 只把进度发给最近 3 分钟内活跃的已配对网页
const crypto = require('crypto');

// 手机网页在前台时每 60 秒 ping 一次；超过 2 分钟没动静就算它走了（切后台、关掉、断网）
let ACTIVE_MS = 2 * 60 * 1000;
const RECHECK_MS = 15 * 1000;
const FLUSH_MS = 250;
const TEXT_LIMIT = 4000;

let o = null; // init 传进来的依赖
let running = false; // 轮询循环是否在跑
let loopId = 0;
let status = { enabled: false, online: false, error: '', active: [] };
const lastSeen = new Map(); // 网页会话 sid -> 最近一次发命令的时间
let queue = [];
let flushTimer = null;
const pairing = new Set(); // 正在等电脑确认的 sid
let recheckTimer = null; // 定时重算「手机已连接」：手机走了也没有消息过来，靠这个把状态收起来
let lastActiveKey = '';

/**
 * opts: {
 *   api(path, {method, body, timeout}) -> {ok, data, error}
 *   enabled(): 设置里打开了远程控制且已登录
 *   name(): 在手机上显示的电脑名
 *   trusted(): [{sid, name, ip, at}]；setTrusted(list)
 *   askPair({name, ip, code}) -> Promise<boolean>：电脑上弹窗确认
 *   handlers: { ping, list_convs, get_conv, list_workspaces, send, stop, confirm, fetch_file }（返回数据或抛错）
 *   onStatus(status)
 * }
 */
function init(opts) {
  o = opts;
  if (opts.activeMs) ACTIVE_MS = opts.activeMs; // 测试用
}

function setStatus(patch) {
  status = { ...status, ...patch };
  lastActiveKey = o ? activeSids().join(',') : '';
  o?.onStatus?.(getStatus());
}
function startRecheck() {
  clearInterval(recheckTimer);
  recheckTimer = setInterval(() => {
    // 过期的手机清掉；活跃的手机列表变了才通知界面
    const now = Date.now();
    for (const [sid, t] of lastSeen) if (now - t >= ACTIVE_MS) lastSeen.delete(sid);
    if (activeSids().join(',') !== lastActiveKey) setStatus({});
  }, RECHECK_MS);
}
function activeSids() {
  const now = Date.now();
  const trusted = new Set(o.trusted().map((t) => t.sid));
  return [...lastSeen].filter(([sid, t]) => trusted.has(sid) && now - t < ACTIVE_MS).map(([sid]) => sid);
}
function getStatus() {
  const names = new Map(o ? o.trusted().map((t) => [t.sid, t.name]) : []);
  return { ...status, active: o ? activeSids().map((sid) => names.get(sid) || '') : [] };
}

// ---------- 开关 ----------
async function start() {
  if (!o?.enabled()) return stop(false);
  const r = await o.api('/aidesk/remote/hello', { method: 'POST', body: { enabled: true, name: o.name?.() } });
  if (!r.ok) return setStatus({ enabled: true, online: false, error: r.error || 'hello' });
  setStatus({ enabled: true, online: true, error: '' });
  startRecheck();
  if (!running) loop(++loopId);
}
async function stop(tellServer = true) {
  running = false;
  loopId++;
  lastSeen.clear();
  clearInterval(recheckTimer);
  recheckTimer = null;
  if (tellServer) await o?.api('/aidesk/remote/hello', { method: 'POST', body: { enabled: false } }).catch(() => {});
  setStatus({ enabled: false, online: false, error: '' });
}

async function loop(id) {
  running = true;
  let backoff = 1000;
  while (running && id === loopId && o.enabled()) {
    const r = await o.api('/aidesk/remote/poll', { timeout: 35000 });
    if (id !== loopId) return;
    if (!r.ok) {
      if (r.error === 'not_enabled') {
        // 服务端重启过：重新上线
        const h = await o.api('/aidesk/remote/hello', { method: 'POST', body: { enabled: true, name: o.name?.() } });
        if (!h.ok) setStatus({ online: false, error: h.error || 'hello' });
      } else setStatus({ online: false, error: r.error || 'network' });
      if (r.error === 'unauthorized') break;
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }
    backoff = 1000;
    if (!status.online || status.error) setStatus({ online: true, error: '' });
    for (const c of r.data.commands || []) handle(c).catch((e) => console.warn('[remote]', e.message));
  }
  if (id === loopId) running = false;
}

// ---------- 命令 ----------
function reply(c, ok, data, error) {
  push({ type: 'reply', id: c.id, ok, data, error }, [c.sid]);
}

/** 这个网页是否已授权；同一部手机换了登录会话（重新登录）时，把记录的会话更新成新的 */
function findTrusted(sid, wid) {
  const list = o.trusted();
  const t = list.find((x) => x.sid === sid) || (wid ? list.find((x) => x.wid === wid) : null);
  if (t && t.sid !== sid) {
    lastSeen.delete(t.sid);
    o.setTrusted(list.map((x) => (x === t ? { ...x, sid } : x)));
  }
  return !!t;
}

async function handle(c) {
  const sid = String(c.sid || '');
  if (!sid) return;
  const wid = String(c.from?.wid || '');
  // 手机走了（关浏览器、锁屏、断开）：马上不再给它转发进度
  if (c.type === 'bye') {
    lastSeen.delete(sid);
    return setStatus({});
  }
  const isTrusted = findTrusted(sid, wid);
  lastSeen.set(sid, Date.now());
  if (activeSids().join(',') !== lastActiveKey) setStatus({}); // 手机刚连上（或回来了）：马上显示「手机已连接」
  if (c.type === 'ping') return reply(c, true, { paired: isTrusted, ...(isTrusted ? await o.handlers.ping() : {}) });
  if (c.type === 'pair') return pair(c, sid, isTrusted);
  if (!isTrusted) return reply(c, false, null, 'not_paired');
  if (c.type === 'unpair') {
    o.setTrusted(o.trusted().filter((t) => t.sid !== sid && !(wid && t.wid === wid)));
    lastSeen.delete(sid);
    setStatus({});
    return reply(c, true);
  }
  const fn = o.handlers[c.type];
  if (!fn) return reply(c, false, null, 'unknown_command');
  setStatus({});
  try {
    reply(c, true, await fn(c.payload || {}, c));
  } catch (e) {
    reply(c, false, null, e.code || e.message || 'error');
  }
}

async function pair(c, sid, isTrusted) {
  if (isTrusted) return reply(c, true, { paired: true });
  if (pairing.has(sid)) return reply(c, false, null, 'pairing');
  const code = String(c.payload?.code || '').replace(/\D/g, '').slice(0, 6);
  if (code.length !== 6) return reply(c, false, null, 'bad_code');
  pairing.add(sid);
  try {
    const ok = await o.askPair({ name: c.from?.name || '', ip: c.from?.ip || '', code });
    if (ok) {
      const wid = String(c.from?.wid || '');
      const list = o.trusted().filter((t) => t.sid !== sid && !(wid && t.wid === wid));
      list.push({ sid, wid, name: c.from?.name || '', ip: c.from?.ip || '', at: Date.now() });
      o.setTrusted(list.slice(-10));
      lastSeen.set(sid, Date.now());
      setStatus({});
    }
    reply(c, ok, { paired: ok }, ok ? undefined : 'rejected');
  } finally {
    pairing.delete(sid);
  }
}

// ---------- 事件转发 ----------
const cut = (s, n = TEXT_LIMIT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `…（共 ${s.length} 字）` : s);
function slim(evt) {
  const e = { ...evt };
  if (e.type === 'tool') {
    e.args = Object.fromEntries(Object.entries(e.args || {}).map(([k, v]) => [k, typeof v === 'string' ? cut(v, 1500) : v]));
    e.result = cut(e.result, 1500);
  }
  if (e.type === 'confirm') {
    e.diff = cut(e.diff, 20000);
    e.command = cut(e.command, 2000);
  }
  return e;
}
/** main.js 的 send() 每个事件都调一下：有活跃的已配对网页时，把对话相关的事件发过去 */
function forward(evt) {
  if (!running || !evt || !evt.convId) return;
  const to = activeSids();
  if (!to.length) return;
  const e = slim(evt);
  // 连续的文字片段合并，减少条数
  const last = queue[queue.length - 1];
  if (e.type === 'assistant-delta' && last && last.e.type === 'assistant-delta' && last.e.convId === e.convId) last.e.text += e.text;
  else queue.push({ e, to });
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}
function push(e, to) {
  queue.push({ e, to });
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}
async function flush() {
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  // 按接收人分组发送
  const groups = new Map();
  for (const { e, to } of batch) {
    const k = to.slice().sort().join(',');
    if (!groups.has(k)) groups.set(k, { to, events: [] });
    groups.get(k).events.push(e);
  }
  for (const { to, events } of groups.values()) {
    for (let i = 0; i < events.length; i += 100) {
      const r = await o.api('/aidesk/remote/events', { method: 'POST', body: { events: events.slice(i, i + 100), to } });
      if (!r.ok && r.error === 'too_large') {
        // 单批太大：逐条再发，还太大的就丢掉
        for (const ev of events.slice(i, i + 100)) await o.api('/aidesk/remote/events', { method: 'POST', body: { events: [ev], to } });
      }
    }
  }
  if (queue.length && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** 远程发起的任务完成等情况：主动通知所有活跃网页 */
function notifyWeb(e) {
  const to = activeSids();
  if (to.length && running) push(e, to);
}

const isActive = () => running && activeSids().length > 0;
const pairCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');

module.exports = { init, start, stop, forward, notifyWeb, getStatus, isActive, pairCode };
