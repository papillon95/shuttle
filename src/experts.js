// 外援：调用这台电脑上装好的 AI 命令行工具（Claude Code、Codex、Gemini CLI……）来回答问题。
//
// 每个工具用一份「配方」描述怎么调用：
//   bins      找程序时用的文件名
//   args      只读时的参数；"{prompt}" 会换成问题，没有 "{prompt}" 就从标准输入传问题
//   editArgs  允许改文件时的参数（没有就不支持改文件）
//   output    回答怎么读：claude-stream / codex（各自的事件格式，能显示进度）、json（取 jsonField 字段）、text（整个输出）
//   readOnly  true：确定只读；'unknown'：没法确认（每次调用前都要用户确认）
// 内置配方按各工具的官方文档写；用户添加的其他工具，由 Shuttle 的模型读它的 --help 生成配方，用户确认、测试通过后保存。
//
// 用的是用户自己的账号和订阅，不扣 Shuttle 的额度，也不经过 Shuttle 的服务器。
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const isWin = process.platform === 'win32';
const TIMEOUT_MS = 15 * 60 * 1000;

const PRESETS = [
  {
    id: 'claude', name: 'Claude Code', bins: ['claude'], login: 'claude', install: 'npm install -g @anthropic-ai/claude-code',
    // 非交互模式下没放行的工具（改文件、执行命令）会被直接拒绝，所以只放行读文件、搜索就是只读
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Grep,Glob'],
    editArgs: ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Grep,Glob,Edit,Write,MultiEdit', '--permission-mode', 'acceptEdits'],
    output: 'claude-stream', readOnly: true,
  },
  {
    id: 'codex', name: 'Codex', bins: ['codex'], login: 'codex login', install: 'npm install -g @openai/codex',
    args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-last-message', '{lastfile}', '-'],
    editArgs: ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--output-last-message', '{lastfile}', '-'],
    output: 'codex', readOnly: true,
  },
  {
    id: 'gemini', name: 'Gemini CLI', bins: ['gemini'], login: 'gemini', install: 'npm install -g @google/gemini-cli',
    // 无界面模式下默认审批：需要确认的工具（改文件、执行命令）不会执行
    args: ['--output-format', 'json', '--approval-mode', 'default'],
    editArgs: ['--output-format', 'json', '--approval-mode', 'auto_edit'],
    output: 'json', jsonField: 'response', readOnly: true,
  },
  {
    id: 'qwen', name: 'Qwen Code', bins: ['qwen'], login: 'qwen', install: 'npm install -g @qwen-code/qwen-code',
    args: ['--output-format', 'json', '--approval-mode', 'default'],
    editArgs: ['--output-format', 'json', '--approval-mode', 'auto-edit'],
    output: 'json', jsonField: 'response', readOnly: true,
  },
  {
    id: 'cursor', name: 'Cursor Agent', bins: ['cursor-agent'], login: 'cursor-agent login', install: 'curl https://cursor.com/install -fsS | bash',
    // 不加 --force 时，改文件只是提议、不会写入
    args: ['-p', '{prompt}', '--output-format', 'text'],
    editArgs: ['-p', '{prompt}', '--output-format', 'text', '--force'],
    output: 'text', readOnly: true,
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', bins: ['copilot'], login: 'copilot', install: 'npm install -g @github/copilot',
    args: ['-p', '{prompt}', '-s', '--deny-tool', 'write', '--deny-tool', 'shell'],
    editArgs: ['-p', '{prompt}', '-s', '--allow-tool', 'write', '--deny-tool', 'shell'],
    output: 'text', readOnly: true,
  },
  {
    id: 'opencode', name: 'OpenCode', bins: ['opencode'], login: 'opencode auth login', install: 'npm install -g opencode-ai',
    // plan 智能体只分析、不改文件
    args: ['run', '--agent', 'plan', '{prompt}'],
    editArgs: ['run', '{prompt}'],
    output: 'text', readOnly: true,
  },
  {
    id: 'aider', name: 'Aider', bins: ['aider'], login: 'aider', install: 'python -m pip install aider-install && aider-install',
    // ask 模式只回答问题、不改代码
    args: ['--chat-mode', 'ask', '--no-git', '--no-auto-commits', '--no-pretty', '--no-stream', '--yes-always', '--message', '{prompt}'],
    output: 'text', readOnly: true,
  },
];
const presetOf = (id) => PRESETS.find((p) => p.id === id);

// ---------- 找程序 ----------
// 从桌面图标打开的软件拿不到终端里的 PATH（nvm、自定义 node 目录等），所以先问一下登录 shell 的 PATH
let shellPathCache = null;
function shellPath() {
  if (shellPathCache) return shellPathCache;
  shellPathCache = new Promise((resolve) => {
    if (isWin) return resolve('');
    const sh = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    execFile(sh, ['-ilc', 'printf "__SHUTTLE_PATH__%s__SHUTTLE_PATH__" "$PATH"'], { timeout: 8000, env: { ...process.env, TERM: 'dumb' } }, (err, out) => {
      const m = /__SHUTTLE_PATH__(.*?)__SHUTTLE_PATH__/s.exec(String(out || ''));
      resolve(m ? m[1] : '');
    });
  });
  return shellPathCache;
}
async function searchPath() {
  const home = os.homedir();
  const extra = isWin
    ? [path.join(process.env.APPDATA || '', 'npm'), path.join(home, '.local', 'bin'), path.join(process.env.LOCALAPPDATA || '', 'Programs'), path.join(home, '.bun', 'bin')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.opencode', 'bin'), path.join(home, '.cursor', 'bin')];
  // AGENT_EXPERT_DIRS：开发测试用，优先在这些目录里找（比如放一个模拟的 claude）
  const dirs = [...String(process.env.AGENT_EXPERT_DIRS || '').split(path.delimiter), ...(await shellPath()).split(path.delimiter), ...String(process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean);
  return [...new Set(dirs)];
}
function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (isWin || !!(st.mode & 0o111));
  } catch {
    return false;
  }
}
function findBin(dirs, name) {
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) for (const e of exts) if (isExecutable(path.join(d, name + e))) return path.join(d, name + e);
  return null;
}
/** 运行外援用的环境：带上完整 PATH（多数工具是 node 脚本，得找得到 node），去掉会让 Claude Code 以为自己被嵌套调用的变量 */
async function childEnv() {
  const env = { ...process.env, PATH: (await searchPath()).join(path.delimiter), NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE|^CLAUDECODE$|^CLAUDE_AGENT_SDK/.test(k)) delete env[k];
  return env;
}

/**
 * Windows 上 npm 装的是 .cmd 包装脚本，直接运行要经过 cmd（参数里的换行、引号会出问题）。
 * 能认出里面指向的 node 脚本就直接用 node 运行，认不出再走 cmd。
 */
function launchSpec(bin) {
  if (!isWin || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, pre: [], shell: false };
  try {
    const txt = fs.readFileSync(bin, 'utf8');
    const m = /"%(?:~dp0|dp0)%?\\([^"]+?\.(?:js|cjs|mjs))"/i.exec(txt);
    if (m) {
      const script = path.join(path.dirname(bin), m[1]);
      const localNode = path.join(path.dirname(bin), 'node.exe');
      if (fs.existsSync(script)) return { cmd: fs.existsSync(localNode) ? localNode : 'node', pre: [script], shell: false };
    }
  } catch {}
  return { cmd: bin, pre: [], shell: true };
}
const winQuote = (s) => '"' + String(s).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';

function runQuick(bin, args, env, timeout = 10000) {
  return new Promise((resolve) => {
    const ls = launchSpec(bin);
    let child;
    try {
      child = spawn(ls.cmd, [...ls.pre, ...(ls.shell ? args.map(winQuote) : args)], { env, shell: ls.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    let out = '';
    const t = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => out.length < 200000 && (out += d));
    child.stderr.on('data', (d) => out.length < 200000 && (out += d));
    child.on('error', () => (clearTimeout(t), resolve(null)));
    child.on('close', () => (clearTimeout(t), resolve(out.trim())));
  });
}
const versionOf = (out) => (/\d+\.\d+[\w.\-]*/.exec(out || '') || [''])[0];

/** 校验一个程序能不能运行：返回 { ok, version } */
async function probe(bin) {
  if (!bin || !isExecutable(bin)) return { ok: false, error: 'not_found' };
  const v = await runQuick(bin, ['--version'], await childEnv());
  if (v === null) return { ok: false, error: 'cannot_run' };
  return { ok: true, version: versionOf(v), raw: v.slice(0, 300) };
}

/**
 * 检测：内置配方逐个找（用户指定了路径的用指定的），再加上用户添加的工具。
 * cfg = { paths: {id: 路径}, custom: [配方] }
 * 返回 [{ id, name, path, version, found, preset, custom, readOnly, canEdit, login, install, error }]
 */
let detectCache = null;
async function detect(cfg = {}, force = false) {
  const key = JSON.stringify(cfg);
  if (!force && detectCache && detectCache.key === key && Date.now() - detectCache.at < 120000) return detectCache.list;
  const dirs = await searchPath();
  const list = [];
  for (const p of PRESETS) {
    const want = cfg.paths?.[p.id];
    const bin = want || p.bins.map((b) => findBin(dirs, b)).find(Boolean);
    const pr = bin ? await probe(bin) : { ok: false };
    list.push({ id: p.id, name: p.name, path: bin || '', manual: !!want, found: pr.ok, version: pr.version || '', error: bin && !pr.ok ? pr.error : '', preset: true, readOnly: p.readOnly, canEdit: !!p.editArgs, login: p.login, install: p.install });
  }
  for (const c of cfg.custom || []) {
    const pr = await probe(c.path);
    list.push({ id: c.id, name: c.name, path: c.path, found: pr.ok, version: pr.version || '', error: pr.ok ? '' : pr.error, custom: true, readOnly: c.readOnly === true ? true : 'unknown', canEdit: false, login: '', install: '', argsLine: joinArgs(c.args || []) });
  }
  detectCache = { key, at: Date.now(), list };
  return list;
}

// ---------- 运行 ----------
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill();
    } catch {}
  }
}
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');
function describeTool(name, input = {}) {
  const p = input.file_path || input.path || input.pattern || input.command || input.url || input.query || '';
  return { name: String(name || ''), arg: String(p).slice(0, 160) };
}
/** 从输出里找 JSON（可能前面混着日志），取指定字段 */
function pickJson(out, field) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let j = tryParse(out.trim());
  if (j === undefined) {
    const i = out.indexOf('{');
    const k = out.lastIndexOf('}');
    if (i >= 0 && k > i) j = tryParse(out.slice(i, k + 1));
  }
  if (j === undefined) return null;
  if (!field) return typeof j === 'string' ? j : JSON.stringify(j, null, 2);
  const v = String(field).split('.').reduce((o, k2) => (o == null ? o : o[k2]), j);
  return v == null ? null : typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}
const LOGIN_RE = /not logged in|please run \/login|codex login|not authenticated|unauthori[sz]ed|login required|please (log|sign) ?in|no api key|api[_ ]key.*(missing|not set|required)|authentication (failed|required)/i;

/**
 * 让外援回答。
 * opts: { recipe, bin, prompt, cwd, allowEdits, signal, onStatus({kind:'tool'|'text'|'start', name, arg, text}) }
 * recipe：内置配方或用户添加的配方（{args, output, jsonField}）
 * 返回 { ok, text, error, notLoggedIn, detail }
 */
async function run(opts) {
  const r = opts.recipe;
  const env = await childEnv();
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const lastFile = r.output === 'codex' ? path.join(os.tmpdir(), `shuttle-codex-${process.pid}-${Date.now()}.txt`) : null;
  const tpl = opts.allowEdits && r.editArgs ? r.editArgs : r.args;
  const viaArg = tpl.some((a) => String(a).includes('{prompt}'));
  const args = tpl.map((a) => String(a).replace('{lastfile}', lastFile || '').replace('{prompt}', opts.prompt));
  const ls = launchSpec(opts.bin);
  opts.onStatus?.({ kind: 'start' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ls.cmd, [...ls.pre, ...(ls.shell ? args.map(winQuote) : args)], { cwd, env, shell: ls.shell, detached: !isWin, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let buf = '';
    let out = ''; // 全部标准输出（text / json 用）
    let stderr = '';
    let result = null; // claude 的最终结果
    let model = ''; // 外援背后实际用的模型（Claude Code 开头会告诉我们）
    let lastText = '';
    let finished = false;
    const finish = (x) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (lastFile) fs.rm(lastFile, { force: true }, () => {});
      resolve(x);
    };
    const onAbort = () => {
      killTree(child);
      finish({ ok: false, error: 'aborted' });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: 'timeout' });
    }, opts.timeout || TIMEOUT_MS);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line) => {
      if (r.output !== 'claude-stream' && r.output !== 'codex') return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (r.output === 'claude-stream') {
        if (j.type === 'system' && j.subtype === 'init' && j.model) model = String(j.model);
        if (j.type === 'assistant') {
          for (const c of j.message?.content || []) {
            if (c.type === 'tool_use') opts.onStatus?.({ kind: 'tool', ...describeTool(c.name, c.input) });
            else if (c.type === 'text' && c.text?.trim()) {
              lastText = c.text;
              opts.onStatus?.({ kind: 'text', text: c.text });
            }
          }
        } else if (j.type === 'result') result = j;
      } else {
        // codex exec --json：事件格式各版本略有不同，只挑认得出的
        const item = j.item || j.msg || j;
        const t = item.type || j.type || '';
        if (/command|exec/.test(t) && (item.command || item.cmd)) opts.onStatus?.({ kind: 'tool', name: 'shell', arg: String([].concat(item.command || item.cmd).join(' ')).slice(0, 160) });
        else if (/agent_message|message/.test(t) && typeof (item.text || item.message) === 'string') {
          lastText = item.text || item.message;
          opts.onStatus?.({ kind: 'text', text: lastText });
        }
      }
    };
    child.stdout.on('data', (d) => {
      const s = String(d);
      if (out.length < 2000000) out += s;
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) if (l.trim()) handleLine(l.trim());
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (buf.trim()) handleLine(buf.trim());
      let text = '';
      if (r.output === 'claude-stream') text = result?.result || lastText;
      else if (r.output === 'codex') {
        try {
          text = fs.readFileSync(lastFile, 'utf8');
        } catch {}
        text = text || lastText;
      } else if (r.output === 'json') text = pickJson(stripAnsi(out), r.jsonField) ?? stripAnsi(out);
      else text = stripAnsi(out);
      text = String(text || '').trim();
      const errTail = stripAnsi(stderr).trim().split('\n').filter(Boolean).slice(-4).join(' ').slice(0, 500);
      if ((code !== 0 || !text || /not logged in|please run \/login/i.test(text)) && LOGIN_RE.test(`${text}\n${stderr}`)) return finish({ ok: false, notLoggedIn: true, error: 'not_logged_in', detail: errTail || text.slice(0, 300) });
      if (r.output === 'claude-stream' && result?.is_error) return finish({ ok: false, error: String(result.result || result.subtype || 'error').slice(0, 500) });
      if (!text) return finish({ ok: false, error: errTail || `exit ${code}` });
      if (code !== 0 && r.output === 'text' && errTail) return finish({ ok: false, error: errTail, text });
      finish({ ok: true, text, model: prettyModel(model) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(viaArg ? '' : opts.prompt);
  });
}

/** 模型 id 变成好读的名字：claude-sonnet-5-5 → Claude Sonnet 5.5；其他的（比如换成了 DeepSeek）原样显示 */
function prettyModel(id) {
  const s = String(id || '').replace(/\[.*?\]$/, '').trim();
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(s);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return s;
}

// ---------- 添加其他工具：读 --help ----------
/** 取程序的帮助说明（--help，不行再试 -h / help），给模型分析用法 */
async function helpText(bin) {
  const env = await childEnv();
  let best = '';
  for (const a of [['--help'], ['-h'], ['help']]) {
    const out = stripAnsi((await runQuick(bin, a, env, 12000)) || '');
    if (out.length > best.length) best = out;
    if (out.length > 400) break;
  }
  return best.slice(0, 16000);
}
/** 把用户编辑的命令行（不含程序本身）拆成参数，支持引号 */
function splitArgs(line) {
  const out = [];
  let cur = '';
  let q = null;
  let has = false;
  for (const ch of String(line || '')) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}
function joinArgs(args) {
  return (args || []).map((a) => (/[\s"']/.test(a) || a === '' ? `"${String(a).replace(/"/g, '\\"')}"` : a)).join(' ');
}

module.exports = { PRESETS, presetOf, detect, probe, run, helpText, splitArgs, joinArgs };
