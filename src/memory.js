// 长期记忆：跨对话记住用户的偏好和背景（只存在本机 userData/memory.json，用户可在设置里查看、删除）
const fs = require('fs');
const path = require('path');

const MAX_ITEMS = 50;
const MAX_LEN = 200;
let file = null;

function init(dir) {
  file = path.join(dir, 'memory.json');
}
function list() {
  if (!file) return [];
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a.filter((x) => x && x.id && x.text) : [];
  } catch {
    return [];
  }
}
function save(items) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 1));
}
// 密码、密钥、证件号之类不记
const SECRET_RE = /(sk-[a-z0-9_-]{8,}|密码|口令|password|passwd|api[ _-]?key|secret|token|身份证|银行卡|\b\d{15,19}\b)/i;
function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
}
function nextId(items) {
  let n = 0;
  for (const x of items) n = Math.max(n, Number(String(x.id).replace(/\D/g, '')) || 0);
  return 'm' + (n + 1);
}
/** 返回 { ok, item?, error? }；error：empty | secret | full | notFound */
function add(text) {
  const t = clean(text);
  if (!t) return { ok: false, error: 'empty' };
  if (SECRET_RE.test(t)) return { ok: false, error: 'secret' };
  const items = list();
  const same = items.find((x) => x.text === t);
  if (same) return { ok: true, item: same };
  if (items.length >= MAX_ITEMS) return { ok: false, error: 'full' };
  const item = { id: nextId(items), text: t, at: Date.now() };
  items.push(item);
  save(items);
  return { ok: true, item };
}
function update(id, text) {
  const t = clean(text);
  if (!t) return { ok: false, error: 'empty' };
  if (SECRET_RE.test(t)) return { ok: false, error: 'secret' };
  const items = list();
  const item = items.find((x) => x.id === id);
  if (!item) return { ok: false, error: 'notFound' };
  item.text = t;
  item.at = Date.now();
  save(items);
  return { ok: true, item };
}
function remove(id) {
  const items = list();
  const rest = items.filter((x) => x.id !== id);
  if (rest.length === items.length) return { ok: false, error: 'notFound' };
  save(rest);
  return { ok: true };
}
function clear() {
  if (file) save([]);
  return { ok: true };
}

module.exports = { init, list, add, update, remove, clear, MAX_ITEMS, MAX_LEN };
