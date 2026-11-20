// 技能（Agent Skills）：一个文件夹，里面有 SKILL.md（开头的 name / description + 正文说明），可能还带脚本和参考资料。
//
// 工作方式（渐进加载）：
//   1. 每次对话只把已启用技能的「名字 + 一句话简介」放进系统提示；
//   2. 模型判断用得上时调用 load_skill 读取完整说明，需要时再读技能里的其他文件；
//   3. 说明里要执行的脚本 / 命令照常走 run_command（会请用户确认）。
//
// 技能放在哪：
//   - Shuttle 自己安装的：userData/skills/<名字>/（可删除）
//   - 只读 Shuttle 自己的目录。不扫描 ~/.claude/skills、~/.agents/skills 等其他工具的目录：
//     那里常有公司内部技能（含内网地址、库连接信息），自动带进对话会泄露给模型。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
let managedDir = path.join(os.homedir(), '.shuttle-skills');

function init({ dir }) {
  if (dir) managedDir = dir;
}

// ---------- SKILL.md 解析 ----------
// 只解析开头 --- 之间常用的简单 YAML：key: value、引号、以及 > / | 多行
function parseFrontmatter(text) {
  const m = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) parts.push(lines[++i].trim());
      v = parts.join(v.startsWith('>') ? ' ' : '\n').trim();
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}
const safeName = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

// ---------- 扫描 ----------
// 一个技能目录里可能嵌套了别的 SKILL.md（子文档），只认最上层那个
function findSkillDirs(root, depth = 0, out = []) {
  if (depth > 4 || out.length > 200) return out;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.isFile() && e.name.toUpperCase() === 'SKILL.MD')) {
    out.push(root);
    return out;
  }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') findSkillDirs(path.join(root, e.name), depth + 1, out);
  return out;
}
function skillFile(dir) {
  const f = fs.readdirSync(dir).find((n) => n.toUpperCase() === 'SKILL.MD');
  return f ? path.join(dir, f) : null;
}
function readSkillMeta(dir, source) {
  try {
    const file = skillFile(dir);
    if (!file) return null;
    const text = fs.readFileSync(file, 'utf8').slice(0, 200000);
    const { meta } = parseFrontmatter(text);
    const name = safeName(meta.name) || safeName(path.basename(dir));
    if (!name) return null;
    let origin = '';
    try {
      origin = fs.readFileSync(path.join(dir, '.shuttle-source'), 'utf8').trim();
    } catch {}
    return { name, title: meta.name || name, description: (meta.description || '').replace(/\s+/g, ' ').slice(0, 600), dir, source, origin };
  } catch {
    return null;
  }
}

/** 所有技能（只含 Shuttle 安装的）。disabled：被停用的名字列表 */
function list(disabled = []) {
  const seen = new Set();
  const out = [];
  const add = (dir, source) => {
    const s = readSkillMeta(dir, source);
    if (!s || seen.has(s.name)) return;
    seen.add(s.name);
    out.push({ ...s, enabled: !disabled.includes(s.name) });
  };
  for (const d of findSkillDirs(managedDir)) add(d, 'shuttle');
  return out;
}

/** 读取技能：默认读 SKILL.md；file 是技能目录里的相对路径 */
function read(name, file, disabled = []) {
  const s = list(disabled).find((x) => x.name === name && x.enabled);
  if (!s) return null;
  const target = file ? path.resolve(s.dir, file) : skillFile(s.dir);
  if (!target || (target !== s.dir && !target.startsWith(s.dir + path.sep))) throw new Error('path outside the skill folder');
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    return { skill: s, path: target, text: fs.readdirSync(target).slice(0, 200).join('\n') };
  }
  const buf = fs.readFileSync(target);
  if (buf.subarray(0, 8000).includes(0)) return { skill: s, path: target, text: `[binary file, ${buf.length} bytes]` };
  const text = buf.toString('utf8');
  return { skill: s, path: target, text: text.length > 64000 ? text.slice(0, 64000) + '\n…(truncated)' : text };
}
/** 技能目录里的文件清单（相对路径，给模型参考） */
function files(dir, max = 80) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= max || e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  try {
    walk(dir, '');
  } catch {}
  return out;
}

// ---------- 安装 ----------
const MAX_FILES = 600;
const MAX_BYTES = 30 * 1024 * 1024;

// https://github.com/owner/repo[/tree/branch/path]  或  owner/repo[/path]
function parseGithub(src) {
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/.exec(src);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] || null, path: (m[4] || '').replace(/\/SKILL\.md$/i, '').replace(/\/$/, '') };
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/.exec(src);
  if (m && !src.includes(':')) return { owner: m[1], repo: m[2], branch: null, path: (m[3] || '').replace(/\/$/, '') };
  return null;
}
async function getJson(u) {
  const r = await fetch(u, { headers: { 'User-Agent': 'Shuttle', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  return r.json();
}
async function download(u, dest) {
  const r = await fetch(u, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}
// 只下载 SKILL.md 所在目录的文件（不拉整个仓库）
async function fetchGithub(g, tmp, onProgress) {
  const info = g.branch ? null : await getJson(`https://api.github.com/repos/${g.owner}/${g.repo}`);
  const branch = g.branch || info.default_branch;
  const tree = await getJson(`https://api.github.com/repos/${g.owner}/${g.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const prefix = g.path ? g.path + '/' : '';
  const blobs = (tree.tree || []).filter((t) => t.type === 'blob' && (prefix ? t.path.startsWith(prefix) : true));
  if (!blobs.some((b) => /(^|\/)SKILL\.md$/i.test(b.path))) throw new Error('no SKILL.md found at this location');
  if (blobs.length > MAX_FILES) throw new Error(`too many files (${blobs.length})`);
  let total = 0;
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i];
    total += b.size || 0;
    if (total > MAX_BYTES) throw new Error('skill is too large');
    const rel = prefix ? b.path.slice(prefix.length) : b.path;
    const raw = `https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(branch)}/${b.path.split('/').map(encodeURIComponent).join('/')}`;
    await download(raw, path.join(tmp, ...rel.split('/')));
    onProgress?.({ done: i + 1, total: blobs.length });
  }
}
function extractZip(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => execFile(tar, ['-xf', file, '-C', dest], { windowsHide: true }, (e, _o, err) => (e ? reject(new Error('extract failed: ' + (err || e.message))) : resolve())));
}

/**
 * 安装技能。source：
 *   GitHub 地址（仓库 / 子目录）、owner/repo[/path]、https://…/xxx.zip、https://…/SKILL.md、本地文件夹或 .zip
 * 一个来源里有多个技能（多个 SKILL.md）会全部安装。返回装好的技能名列表。
 */
async function install(source, onProgress) {
  const src = String(source || '').trim();
  if (!src) throw new Error('empty source');
  fs.mkdirSync(managedDir, { recursive: true });
  const tmp = path.join(managedDir, '.tmp-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const gh = parseGithub(src);
    if (/^https?:\/\//i.test(src) && /\.zip(\?|$)/i.test(src)) {
      const f = path.join(tmp, 'skill.zip');
      await download(src, f);
      await extractZip(f, path.join(tmp, 'x'));
      fs.rmSync(f);
    } else if (/^https?:\/\//i.test(src) && /SKILL\.md(\?|$)/i.test(src) && !/github\.com\//i.test(src)) {
      await download(src, path.join(tmp, 'x', 'SKILL.md'));
    } else if (gh) {
      await fetchGithub(gh, path.join(tmp, 'x'), onProgress);
    } else if (fs.existsSync(src)) {
      if (fs.statSync(src).isDirectory()) fs.cpSync(src, path.join(tmp, 'x'), { recursive: true });
      else if (/\.zip$/i.test(src)) await extractZip(src, path.join(tmp, 'x'));
      else throw new Error('unsupported file');
    } else throw new Error('unsupported source');

    const dirs = findSkillDirs(path.join(tmp, 'x'));
    if (!dirs.length) throw new Error('no SKILL.md found');
    const names = [];
    for (const d of dirs.slice(0, 50)) {
      const meta = readSkillMeta(d, 'shuttle');
      if (!meta) continue;
      const dest = path.join(managedDir, meta.name);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(d, dest, { recursive: true });
      // 记下来源，方便以后更新
      fs.writeFileSync(path.join(dest, '.shuttle-source'), src);
      names.push(meta.name);
    }
    if (!names.length) throw new Error('no valid skill found');
    return names;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 删除 Shuttle 安装的技能（外部目录里的不动） */
function remove(name) {
  const s = list().find((x) => x.name === name && x.source === 'shuttle');
  if (!s) return false;
  fs.rmSync(s.dir, { recursive: true, force: true });
  return true;
}

module.exports = { init, list, read, files, install, remove, parseFrontmatter, parseGithub };
