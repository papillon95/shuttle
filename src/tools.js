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
      description: '在工作目录中按正则搜索文件内容，返回 文件:行号: 内容。可选 glob 后缀过滤，如 ".js"。',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, ext: { type: 'string' } },
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

function search(root, pattern, ext, ignore = DEFAULT_IGNORE) {
  const IGNORE = new Set(ignore);
  const re = new RegExp(pattern);
  const results = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= 100) return;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (!ext || e.name.endsWith(ext)) {
        let text;
        try {
          if (fs.statSync(full).size > 1024 * 1024) continue;
          text = fs.readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // 跳过二进制
        text.split('\n').forEach((line, i) => {
          if (results.length < 100 && re.test(line)) {
            results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    }
  };
  walk(root);
  return results.join('\n') || T('noMatch');
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

module.exports = { setLang, DEFAULT_IGNORE, definitions, safePath, listDir, readFile, readFileAt, search, makeEditPreview, backup, runCommand };
