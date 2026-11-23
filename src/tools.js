// 本地工具：模型只负责"决定调用哪个工具"，真正读写文件、执行命令的是这里的代码。
// 所有路径都被限制在用户选择的工作目录内。
const fs = require('fs');
const { squeeze } = require('./squeeze');
const path = require('path');
const { exec } = require('child_process');
const { t } = require('./i18n');
const docs = require('./docs');

let lang = 'zh';
const T = (key, vars) => t(lang, key, vars);
function setLang(l) {
  lang = l;
  docs.setLang(l);
}

const DEFAULT_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.idea', '.DS_Store'];
// 单次读文件最多返回 64KB：读出来的内容之后每一步都要重新发给模型，太大很费 token，大文件让模型分段读
const MAX_READ = 64 * 1024;
// PDF / Office 文档体积大但提取出的文字少，上限放宽到 50MB
const MAX_DOC_SIZE = 50 * 1024 * 1024;

const definitions = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出目录内容。path 为相对工作目录的路径，"." 表示根目录。depth 为递归深度（默认 2）。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, depth: { type: 'integer' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取文本文件，返回带行号的内容。可选 start_line / end_line 只读一部分。也支持 .pdf / .docx / .xlsx / .pptx：返回提取出的文字（PDF、PPT 按页标注，Excel 每个工作表输出为 Markdown 表格，Word 表格也转为 Markdown 表格），行号和 start_line / end_line 针对提取后的文字。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        '按内容搜索（代替 grep），返回 文件:行号: 内容 和匹配总数。pattern 是正则，literal=true 按普通文字；path 限定目录或文件；glob 过滤文件名如 "*.java"；ignore_case 忽略大小写；context 带前后几行（0～5）。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          glob: { type: 'string' },
          ignore_case: { type: 'boolean' },
          literal: { type: 'boolean' },
          context: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description:
        '按文件名找文件（代替 find），返回相对路径。pattern 不带通配符时匹配「文件名包含这段文字」（不分大小写），也可用 "*.sql"、"src/**/test_*.py"；path 限定目录。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '修改已有文件：把 old_string 精确替换为 new_string。old_string 必须在文件中唯一出现（包含足够上下文），且与原文完全一致（包括缩进）。修改前务必先 read_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建新文件或整体覆盖文件。修改已有文件的局部内容时请优先用 edit_file。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在工作目录下执行 shell 命令（如运行测试、git status）。有超时限制。',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function safePath(root, p) {
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(T('pathEscape', { p }));
  }
  return abs;
}

function listDir(root, p, depth = 2, ignore = DEFAULT_IGNORE) {
  const IGNORE = new Set(ignore);
  const base = safePath(root, p);
  const lines = [];
  const walk = (dir, level, prefix) => {
    if (lines.length > 500) return;
    let entries = fs.readdirSync(dir, { withFileTypes: true });
    entries = entries.filter((e) => !IGNORE.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory() && level < depth) walk(path.join(dir, e.name), level + 1, prefix + '  ');
    }
  };
  walk(base, 1, '');
  return lines.join('\n') || T('emptyDir');
}

// 文本文件同步返回字符串；PDF / Office 文档返回 Promise（调用方 executeTool 会 await）
function readFile(root, p, start, end) {
  return readFileAt(safePath(root, p), start, end);
}
// 不做工作目录检查：只用于用户自己拖进来 / 选择的附件
function readFileAt(abs, start, end) {
  const stat = fs.statSync(abs);
  if (docs.isDocument(abs)) {
    if (stat.size > MAX_DOC_SIZE) throw new Error(T('tooLarge'));
    return docs
      .readDocument(abs)
      .catch((e) => {
        throw new Error(T('docReadFailed', { msg: e.message }));
      })
      .then((text) => numberLines(text.split('\n'), start, end));
  }
  if (stat.size > MAX_READ * 5) throw new Error(T('tooLarge'));
  return numberLines(fs.readFileSync(abs, 'utf8').split('\n'), start, end);
}

// 按 start/end 截取并加行号，总长度受 MAX_READ 限制
function numberLines(lines, start, end) {
  const s = Math.max(1, start || 1);
  const e = Math.min(lines.length, end || lines.length);
  let out = '';
  for (let i = s; i <= e; i++) {
    out += `${String(i).padStart(5)}  ${lines[i - 1]}\n`;
    if (out.length > MAX_READ) {
      out += T('truncated', { n: lines.length });
      break;
    }
  }
  return out;
}

// ---------- 搜索内容 / 按文件名找文件 ----------
// 都是异步的：大文件夹里搜索不会卡住界面。电脑上装了 ripgrep（rg）就用它，快很多；没装用下面的 Node 实现，结果格式一样。
const SEARCH_FULL_HITS = 50; // 匹配不超过这么多处：全部列出（带上下文）
const SEARCH_PREVIEW_HITS = 20; // 超过时：列每个文件的匹配数，再给前这么多处
const SEARCH_MAX_FILES_LISTED = 100;
const SEARCH_MAX_CHARS = 24 * 1024;
const FIND_MAX = 200;
const MAX_FILES_SCANNED = 60000;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|7z|rar|jar|war|class|so|dylib|dll|exe|bin|o|a|pyc|woff2?|ttf|otf|eot|mp[34]|mov|avi|wav|flac|ogg|sqlite|db|psd|ai|sketch|xlsx?|docx?|pptx?)$/i;

// 通配符转正则：** 跨目录，* 和 ? 不跨目录，{a,b} 多选一；不带 / 的只和文件名比
function globToRegExp(glob, ignoreCase = true) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') i++, (re += '(?:.*/)?');
        else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', ignoreCase ? 'i' : '');
}
function globMatcher(glob) {
  if (!glob) return () => true;
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(g);
  return g.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.slice(rel.lastIndexOf('/') + 1));
}
// 遍历目录（跳过忽略的目录），对每个文件调用 onFile(绝对路径, 相对路径)；返回 false 停止
async function walkFiles(root, start, ignore, onFile) {
  const IGNORE = new Set(ignore);
  let count = 0;
  let stop = false;
  const visit = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (stop) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile()) {
        if (++count > MAX_FILES_SCANNED || (await onFile(full, path.relative(root, full).split(path.sep).join('/'))) === false) stop = true;
      }
    }
  };
  const st = await fs.promises.stat(start);
  if (st.isFile()) await onFile(start, path.relative(root, start).split(path.sep).join('/'));
  else await visit(start);
  return count;
}

let rgPath; // undefined = 还没找过；null = 没装
function findRg() {
  if (rgPath !== undefined) return rgPath;
  const names = process.platform === 'win32' ? ['rg.exe'] : ['rg'];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  rgPath = null;
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      try {
        if (fs.statSync(p).isFile()) return (rgPath = p);
      } catch {}
    }
  }
  return rgPath;
}

// 搜索结果先按文件收集，再统一排版：匹配不多就全列出；太多就列每个文件的匹配数和前几处，让模型缩小范围再搜
function newAcc() {
  return { files: new Map(), hits: 0 };
}
function accAdd(acc, rel, kind, lineNo, text) {
  let f = acc.files.get(rel);
  if (!f) acc.files.set(rel, (f = { count: 0, lines: [] }));
  if (kind === ':') {
    f.count++;
    acc.hits++;
  }
  // 只留够排版用的行（每个文件最多 60 行），匹配再多也不占内存
  if (f.lines.length < 60) f.lines.push({ kind, no: lineNo, text: text.replace(/\r$/, '').trim().slice(0, 300) });
}
function formatSearch(acc, ctx) {
  if (!acc.hits) return T('noMatch');
  const files = [...acc.files.entries()].filter(([, f]) => f.count);
  const head = T('searchSummary', { n: acc.hits, files: files.length });
  const render = (limitHits) => {
    const out = [];
    let shown = 0;
    let chars = 0;
    for (const [rel, f] of files) {
      let last = -2;
      for (const l of f.lines) {
        if (l.kind === ':' && shown >= limitHits) break;
        if (ctx && last >= 0 && l.no > last + 1) out.push('--');
        const s = `${rel}${l.kind}${l.no}: ${l.text}`;
        out.push(s);
        chars += s.length + 1;
        last = l.no;
        if (l.kind === ':') shown++;
      }
      if (ctx) out.push('--');
      if (shown >= limitHits || chars > SEARCH_MAX_CHARS) break;
    }
    while (out[out.length - 1] === '--') out.pop();
    return out.join('\n');
  };
  if (acc.hits <= SEARCH_FULL_HITS) return head + '\n' + render(SEARCH_FULL_HITS);
  const list = files.slice(0, SEARCH_MAX_FILES_LISTED).map(([rel, f]) => `${rel} (${f.count})`).join('\n');
  return head + T('searchTooMany', { n: SEARCH_PREVIEW_HITS }) + '\n' + list + (files.length > SEARCH_MAX_FILES_LISTED ? '\n…' : '') + '\n\n' + render(SEARCH_PREVIEW_HITS);
}

// opts: { path, glob, ext, ignore_case, literal, context }
async function search(root, pattern, opts = {}, ignore = DEFAULT_IGNORE) {
  if (!pattern) throw new Error(T('noPattern'));
  const start = safePath(root, opts.path || '.');
  if (!fs.existsSync(start)) throw new Error(T('notExist', { path: opts.path }));
  const ctx = Math.max(0, Math.min(5, Number(opts.context) || 0));
  const glob = opts.glob || (opts.ext ? '*' + (opts.ext.startsWith('.') ? opts.ext : '.' + opts.ext) : '');
  let re;
  try {
    re = new RegExp(opts.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, opts.ignore_case ? 'i' : '');
  } catch (e) {
    throw new Error(T('badPattern', { err: e.message }));
  }
  const rg = findRg();
  if (rg) {
    try {
      return formatSearch(await searchRg(rg, root, start, pattern, { ...opts, glob, ctx }, ignore), ctx);
    } catch {
      // rg 出错（版本太旧、参数不支持等）就用 Node 实现
    }
  }
  const match = globMatcher(glob);
  const acc = newAcc();
  await walkFiles(root, start, ignore, async (full, rel) => {
    if (!match(rel) || BINARY_EXT.test(rel)) return;
    let text;
    try {
      const st = await fs.promises.stat(full);
      if (st.size > 2 * 1024 * 1024) return;
      text = await fs.promises.readFile(full, 'utf8');
    } catch {
      return;
    }
    if (text.includes('\u0000')) return; // 二进制
    const lines = text.split('\n');
    const idx = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) idx.push(i);
    if (!idx.length) return;
    const isHit = new Set(idx);
    let last = -1;
    for (const i of idx) {
      for (let k = Math.max(i - ctx, last + 1); k <= Math.min(lines.length - 1, i + ctx); k++) {
        accAdd(acc, rel, isHit.has(k) ? ':' : '-', k + 1, lines[k]);
        last = k;
      }
    }
  });
  return formatSearch(acc, ctx);
}

function searchRg(rg, root, start, pattern, o, ignore) {
  const { spawn } = require('child_process');
  const args = ['--line-number', '--no-heading', '--color', 'never', '--hidden', '--max-columns', '300', '--max-columns-preview', '--max-filesize', '2M'];
  if (o.ignore_case) args.push('-i');
  if (o.literal) args.push('-F');
  if (o.ctx) args.push('-C', String(o.ctx));
  if (o.glob) args.push('--iglob', o.glob.includes('/') ? o.glob : '**/' + o.glob);
  for (const d of ignore) args.push('--glob', '!' + d);
  args.push('-e', pattern, '--', path.relative(root, start) || '.');
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd: root });
    const acc = newAcc();
    let buf = '';
    let err = '';
    const take = (line) => {
      const m = /^(.+?)([:-])(\d+)[:-](.*)$/.exec(line || '');
      if (m) accAdd(acc, m[1].replace(/^\.\//, '').split(path.sep).join('/'), m[2], Number(m[3]), m[4]);
    };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(take);
      if (acc.hits > 5000) child.kill(); // 匹配太多：已经够说明问题了
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      take(buf);
      if (code === 2 && !acc.hits) return reject(new Error(err || 'rg failed'));
      resolve(acc);
    });
  });
}

async function findFiles(root, pattern, sub, ignore = DEFAULT_IGNORE) {
  if (!pattern) throw new Error(T('noPattern'));
  const start = safePath(root, sub || '.');
  if (!fs.existsSync(start)) throw new Error(T('notExist', { path: sub }));
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  const wild = /[*?{]/.test(p);
  const needle = p.toLowerCase();
  const match = wild ? globMatcher(p) : (rel) => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase().includes(needle) || (needle.includes('/') && rel.toLowerCase().includes(needle));
  const found = [];
  await walkFiles(root, start, ignore, (full, rel) => {
    if (match(rel)) found.push(rel);
  });
  found.sort();
  if (!found.length) return T('noFiles');
  return T('findSummary', { n: found.length }) + (found.length > FIND_MAX ? T('findTruncated', { n: FIND_MAX }) : '') + '\n' + found.slice(0, FIND_MAX).join('\n');
}

// 生成一个简单的 diff 预览，供用户确认
function makeEditPreview(root, p, oldStr, newStr) {
  const abs = safePath(root, p);
  const text = fs.readFileSync(abs, 'utf8');
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error(T('notFound'));
  if (count > 1) throw new Error(T('notUnique', { n: count }));
  const startLine = text.slice(0, text.indexOf(oldStr)).split('\n').length;
  const diff = [
    ...oldStr.split('\n').map((l, i) => ({ type: 'del', no: startLine + i, text: l })),
    ...newStr.split('\n').map((l, i) => ({ type: 'add', no: startLine + i, text: l })),
  ];
  return { abs, text, diff, startLine };
}

function backup(backupDir, abs) {
  if (!fs.existsSync(abs)) return;
  const dest = path.join(backupDir, `${Date.now()}_${path.basename(abs)}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(abs, dest);
}

// extraPath：额外加到 PATH 最前面的目录（Shuttle 自己装的 Node.js / uv，技能脚本常用）
function runCommand(root, command, signal, timeoutSec = 60, extraPath = []) {
  return new Promise((resolve) => {
    // Windows 没有 SHELL 环境变量，用系统自带的 cmd.exe；先切到 UTF-8 代码页，否则中文 Windows 上输出是乱码
    const isWin = process.platform === 'win32';
    const shell = isWin ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/zsh';
    const cmd = isWin ? `chcp 65001>nul & ${command}` : command;
    const env = extraPath.length ? { ...process.env, PATH: [...extraPath, process.env.PATH || ''].join(require('path').delimiter) } : process.env;
    const child = exec(cmd, { cwd: root, timeout: timeoutSec * 1000, maxBuffer: 4 * 1024 * 1024, shell, windowsHide: true, env },
      (err, stdout, stderr) => {
        let out = '';
        if (stdout) out += stdout;
        if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
        if (err) out += '\n' + T('exitCode', { code: err.code ?? '?', killed: err.killed ? T('killedTimeout') : '' });
        // 交给模型之前瘦身：去颜色码、进度条、重复行；很长时只留开头、结尾和出错处
        out = squeeze(out, { similar: T('sqSimilar'), repeat: T('sqRepeat'), skipped: T('sqSkipped'), cut: T('midTruncated') }, !!err);
        resolve(out || T('noOutput'));
      });
    signal?.addEventListener('abort', () => child.kill());
  });
}

module.exports = { setLang, DEFAULT_IGNORE, definitions, safePath, listDir, readFile, readFileAt, search, findFiles, globToRegExp, makeEditPreview, backup, runCommand };
