// 对话云端同步（设置 → 数据 →「云端同步对话」打开后才工作）。
//
// 对话内容存在我们的私有腾讯云 COS 存储桶里（默认加密），服务端只存索引（标题、版本、是否删除）。
// 上传 / 下载用服务端签发的临时链接，客户端直连 COS，内容不经过我们的服务器。
//
// 版本 = 本机对话文件的修改时间（毫秒）。同一个对话以版本大的为准；下载下来的文件把修改时间设成云端版本，
// 这样两边版本一致，不会来回传。删除会在云端留下「墓碑」，其他设备同步时也删掉。
// 本机的同步进度存在对话目录下的 .syncstate（since：上次拉取到的服务端时间；pushed：已上传的版本）。
const fs = require('fs');
const path = require('path');

let o = null; // init 传进来的依赖
let timer = null;
let pushTimer = null;
const dirty = new Set();
const deletes = new Set();
let running = null; // 正在进行的同步（Promise），避免并发
let status = { lastSync: 0, count: 0, limit: 0, error: '', busy: false };

const ID_RE = /^[a-z0-9]{1,32}$/;
const PULL_EVERY = 5 * 60 * 1000;

/**
 * opts: {
 *   dir(): 当前用户的对话目录
 *   api(pathname, {method, body}): 带登录凭证的服务端请求，返回 {ok, data, error}
 *   enabled(): 是否打开了云端同步（且已登录）
 *   busy(id): 这个对话是否正在运行（运行中的不覆盖）
 *   onPulled(ids): 从云端更新 / 删除了哪些对话（界面刷新列表；当前打开的对话被更新时重新打开）
 *   onStatus(status): 同步状态变化
 * }
 */
function init(opts) {
  o = opts;
}

const stateFile = () => path.join(o.dir(), '.syncstate');
function loadState() {
  try {
    return { since: 0, pushed: {}, ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) };
  } catch {
    return { since: 0, pushed: {} };
  }
}
function saveState(st) {
  fs.mkdirSync(o.dir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(st));
}
const fileOf = (id) => path.join(o.dir(), id + '.json');
function localVer(id) {
  try {
    return Math.floor(fs.statSync(fileOf(id)).mtimeMs);
  } catch {
    return 0;
  }
}
function setStatus(patch) {
  status = { ...status, ...patch };
  o?.onStatus?.(status);
}

// ---------- 上传 ----------
async function pushOne(id, st) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return;
  const ver = localVer(id);
  if (st.pushed[id] === ver) return; // 这个版本传过了
  const body = fs.readFileSync(file);
  let meta;
  try {
    meta = JSON.parse(body.toString('utf8'));
  } catch {
    return;
  }
  if (!meta.messages?.length) return;
  const up = await o.api('/aidesk/conv-sync/upload', { method: 'POST', body: { id, ver } });
  if (!up.ok) {
    if (up.error === 'conflict') return pullOne(id, up.data.ver, st); // 云端更新：以云端为准
    throw new Error(up.error || 'upload');
  }
  const res = await fetch(up.data.url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('cos_' + res.status);
  const c = await o.api('/aidesk/conv-sync/commit', { method: 'POST', body: { id, title: meta.title || '', ver, archived: !!meta.archived } });
  if (!c.ok) throw new Error(c.error || 'commit');
  st.pushed[id] = ver;
}

// ---------- 下载 ----------
async function pullOne(id, ver, st) {
  if (o.busy(id)) return false;
  const r = await o.api('/aidesk/conv-sync/download?id=' + id);
  if (!r.ok) return false;
  const res = await fetch(r.data.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('cos_' + res.status);
  const text = await res.text();
  JSON.parse(text); // 内容坏了就不写
  if (o.busy(id)) return false;
  fs.mkdirSync(o.dir(), { recursive: true });
  const file = fileOf(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  const v = r.data.ver || ver;
  fs.utimesSync(file, new Date(), new Date(v));
  st.pushed[id] = localVer(id);
  return true;
}

// ---------- 一次完整的同步 ----------
// full：从头对一遍（第一次打开、点「立即同步」）；否则只拉上次之后的变化，并上传有改动的
async function syncOnce(full) {
  if (!o || !o.enabled()) return;
  o.beforeSync?.(); // 还没写盘的对话先写掉，免得上传旧的、或下载的被本机旧内容覆盖
  const st = loadState();
  const changed = [];
  setStatus({ busy: true, error: '' });
  try {
    // 1. 先把本机的删除告诉云端
    if (deletes.size) {
      const ids = [...deletes];
      const r = await o.api('/aidesk/conv-sync/delete', { method: 'POST', body: { ids, ver: Date.now() } });
      if (!r.ok) throw new Error(r.error || 'delete');
      ids.forEach((id) => {
        deletes.delete(id);
        delete st.pushed[id];
      });
    }
    // 2. 拉取云端的变化
    const r = await o.api('/aidesk/conv-sync' + (full || !st.since ? '' : '?since=' + st.since));
    if (!r.ok) throw new Error(r.error || 'list');
    const remote = new Map();
    for (const it of r.data.items || []) {
      if (!ID_RE.test(it.id)) continue;
      remote.set(it.id, it);
      const lv = localVer(it.id);
      if (it.deleted) {
        if (lv && lv <= it.ver && !o.busy(it.id)) {
          fs.rmSync(fileOf(it.id), { force: true });
          changed.push(it.id);
        }
        delete st.pushed[it.id];
      } else if (it.ver > lv) {
        if (await pullOne(it.id, it.ver, st)) changed.push(it.id);
      } else if (lv > it.ver) dirty.add(it.id);
      else st.pushed[it.id] = lv;
    }
    // 3. 上传：完整同步时把本机所有对话都对一遍（云端没有或比云端新的才传）
    if (full && fs.existsSync(o.dir())) {
      for (const f of fs.readdirSync(o.dir())) {
        const m = /^([a-z0-9]{1,32})\.json$/.exec(f);
        if (!m) continue;
        const it = remote.get(m[1]);
        if (!it || (!it.deleted && localVer(m[1]) > it.ver) || (it.deleted && localVer(m[1]) > it.ver)) dirty.add(m[1]);
      }
    }
    let added = 0; // 新传上去的对话（用来更新「云端 n 个」）
    for (const id of [...dirty]) {
      if (o.busy(id)) continue; // 运行结束保存时会再标记
      dirty.delete(id);
      try {
        const known = remote.get(id) || (!full && st.pushed[id]);
        await pushOne(id, st);
        if (!known || remote.get(id)?.deleted) added++;
      } catch (e) {
        if (/conv_limit|too_large/.test(e.message)) setStatus({ error: e.message });
        else {
          dirty.add(id);
          throw e;
        }
      }
    }
    st.since = r.data.serverTime || Date.now();
    st.lastSync = Date.now();
    saveState(st);
    setStatus({ busy: false, lastSync: Date.now(), count: (r.data.count ?? status.count) + added, limit: r.data.limit ?? status.limit });
  } catch (e) {
    saveState(st);
    setStatus({ busy: false, error: e.message || String(e) });
  }
  if (changed.length) o.onPulled?.(changed);
}
function sync(full = false) {
  if (running) return running.then(() => (full ? sync(true) : undefined));
  running = syncOnce(full).finally(() => (running = null));
  return running;
}

// ---------- 对外 ----------
/** 对话保存 / 改名 / 归档后调用：几秒后上传 */
function changed(id) {
  if (!o?.enabled() || !ID_RE.test(String(id))) return;
  dirty.add(id);
  deletes.delete(id);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(false), 3000);
}
/** 本机删除了对话 */
function removed(ids) {
  if (!o?.enabled()) return;
  for (const id of ids) {
    if (!ID_RE.test(String(id))) continue;
    dirty.delete(id);
    deletes.add(id);
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => sync(false), 1000);
}
/** 登录后 / 打开同步时：先完整同步一次，之后每 5 分钟拉一次 */
function start() {
  stop();
  if (!o?.enabled()) return;
  sync(true);
  timer = setInterval(() => sync(false), PULL_EVERY);
}
function stop() {
  clearInterval(timer);
  clearTimeout(pushTimer);
  timer = null;
  dirty.clear();
  deletes.clear();
}
/** 关闭同步：本机的同步进度清掉，下次打开重新完整对一遍（云端内容保留） */
function reset() {
  stop();
  try {
    fs.rmSync(stateFile(), { force: true });
  } catch {}
  status = { lastSync: 0, count: 0, limit: 0, error: '', busy: false };
}
const getStatus = () => ({ ...status, enabled: !!o?.enabled(), lastSync: status.lastSync || loadStateSafe().lastSync || 0 });
function loadStateSafe() {
  try {
    return o ? loadState() : {};
  } catch {
    return {};
  }
}

module.exports = { init, start, stop, reset, sync, changed, removed, getStatus };
