// MCP（Model Context Protocol）客户端：连接用户配置的 MCP 服务，把它们的工具交给模型调用。
//
// 配置格式和 Claude Desktop / Cursor 一样（settings.json 里的 mcpServers）：
//   本地服务：{ "名字": { "command": "npx", "args": ["-y", "包名"], "env": {...}, "cwd": "...", "disabled": false } }
//   远程服务：{ "名字": { "url": "https://…/mcp", "headers": {...}, "type": "http" | "sse", "oauth": { "clientId": "…" } } }
//
// 不用官方 SDK、自己实现协议：补丁更新只打包 src/ 下的代码，不带第三方依赖。
// 本地服务走 stdio（每行一条 JSON-RPC 2.0 消息，stdout 是协议、stderr 是日志）；
// 远程服务走 Streamable HTTP / 旧版 SSE，见 mcp-remote.js。
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const remote = require('./mcp-remote');

const PROTOCOL_VERSION = '2025-06-18';
const INIT_TIMEOUT_MS = 90000; // npx / uvx 第一次运行要下载包，给足时间
const CALL_TIMEOUT_MS = 180000;
const isWin = process.platform === 'win32';

// 缺少运行环境时引导用户安装（node、uv 可以一键安装，见 runtimes.js）
const RUNTIMES = {
  node: { cmds: ['npx', 'node', 'npm', 'pnpm', 'yarn', 'bunx', 'bun'], url: { zh: 'https://nodejs.org/zh-cn/download', en: 'https://nodejs.org/en/download' }, name: 'Node.js' },
  uv: { cmds: ['uvx', 'uv'], url: { zh: 'https://docs.astral.sh/uv/getting-started/installation/', en: 'https://docs.astral.sh/uv/getting-started/installation/' }, name: 'uv' },
  python: { cmds: ['python', 'python3', 'pip', 'pip3', 'pipx'], url: { zh: 'https://www.python.org/downloads/', en: 'https://www.python.org/downloads/' }, name: 'Python' },
  docker: { cmds: ['docker'], url: { zh: 'https://www.docker.com/products/docker-desktop/', en: 'https://www.docker.com/products/docker-desktop/' }, name: 'Docker' },
};
function runtimeOf(command) {
  const base = path.basename(String(command || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  for (const [id, r] of Object.entries(RUNTIMES)) if (r.cmds.includes(base)) return id;
  return null;
}

// ---------- 外部依赖（由 main.js 注入） ----------
const hooks = {
  onChange: () => {},
  getWorkspace: () => null,
  extraPath: () => [], // Shuttle 自己装的运行环境
  auth: { load: () => null, save: () => {}, clear: () => {} }, // OAuth token 存取（加密保存在主进程）
  openExternal: async () => {},
  pages: { ok: 'OK', fail: 'Failed' },
  canInstall: () => false,
};
let lang = 'zh';

// ---------- PATH ----------
// 从「访达 / 开始菜单」打开的应用拿不到终端里的 PATH（nvm、Homebrew 装的 node 找不到），
// 所以 macOS / Linux 上读一次登录 shell 的 PATH，再补上常见安装目录。
let shellPathCache = null;
function shellPath() {
  if (shellPathCache) return shellPathCache;
  shellPathCache = new Promise((resolve) => {
    const base = (process.env.PATH || '').split(path.delimiter);
    const extra = isWin
      ? [path.join(process.env.APPDATA || '', 'npm'), path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin')]
      : ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.cargo/bin'), path.join(os.homedir(), '.volta/bin')];
    const done = (more) => resolve([...more, ...base, ...extra]);
    if (isWin) return done([]);
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__SHUTTLE_PATH__%s__SHUTTLE_PATH__" "$PATH"'], { timeout: 8000 }, (err, out) => {
      const m = /__SHUTTLE_PATH__(.*)__SHUTTLE_PATH__/s.exec(String(out || ''));
      done(m ? m[1].split(':') : []);
    });
  });
  return shellPathCache;
}
async function fullPath() {
  return [...new Set([...hooks.extraPath(), ...(await shellPath())])].filter(Boolean).join(path.delimiter);
}
// 在 PATH 里找可执行文件；Windows 上还要试 PATHEXT（npx 实际是 npx.cmd）
function which(command, PATH) {
  if (!command) return null;
  const exts = isWin ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  const tryFile = (f) => {
    for (const e of exts) {
      try {
        if (fs.statSync(f + e).isFile()) return f + e;
      } catch {}
    }
    return null;
  };
  if (command.includes('/') || command.includes('\\')) return tryFile(path.resolve(command));
  for (const dir of PATH.split(path.delimiter)) {
    const hit = dir && tryFile(path.join(dir, command));
    if (hit) return hit;
  }
  return null;
}
const expandHome = (s) => (typeof s === 'string' && (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) ? path.join(os.homedir(), s.slice(1)) : s);
// Windows 上 .cmd/.bat 必须经过 cmd.exe 运行；参数按 cmd 的规则加引号
function winQuote(a) {
  a = String(a);
  return /[\s"&|<>^()%!]/.test(a) || a === '' ? '"' + a.replace(/"/g, '""') + '"' : a;
}

// ---------- 服务状态 ----------
// status: disabled | starting | ready | error | missing（缺运行环境）| installing（正在装运行环境）
//         | auth（远程服务需要登录）| authorizing（等浏览器授权）| stopped
const servers = new Map();
const authKey = (cfg) => {
  try {
    const u = new URL(cfg.url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return String(cfg.url);
  }
};

function publicState(s) {
  const rt = s.missing && RUNTIMES[s.missing];
  const isRemote = !!s.config.url;
  return {
    name: s.name,
    status: s.status,
    error: s.error || '',
    missing: s.missing || null,
    runtimeName: rt ? rt.name : null,
    installUrl: rt ? rt.url[lang] || rt.url.zh : null,
    canInstall: !!(s.missing && hooks.canInstall(s.missing)),
    remote: isRemote,
    loggedIn: isRemote && !!hooks.auth.load(authKey(s.config)),
    command: isRemote ? s.config.displayUrl || s.config.url : [s.config.command, ...(s.config.args || [])].filter(Boolean).join(' '),
    connector: s.config.connector || null,
    tools: (s.tools || []).map((t) => ({ name: t.name, description: (t.description || '').slice(0, 200) })),
  };
}
function emit() {
  try {
    hooks.onChange(status());
  } catch {}
}
function status() {
  return [...servers.values()].map(publicState);
}
function setStatus(s, status, error = '', missing = null) {
  s.status = status;
  s.error = error;
  s.missing = missing;
  for (const { reject } of s.pending.values()) reject(new Error(error || status));
  s.pending.clear();
  rebuildIndex();
  emit();
}

function request(s, method, params, timeoutMs = CALL_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    const id = ++s.nextId;
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`MCP ${method} timeout`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      s.pending.delete(id);
      notify(s, 'notifications/cancelled', { requestId: id, reason: 'user stopped' });
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    s.pending.set(id, { resolve: (v) => (cleanup(), resolve(v)), reject: (e) => (cleanup(), reject(e)) });
    Promise.resolve()
      .then(() => s.transport.send({ jsonrpc: '2.0', id, method, params }))
      .catch((e) => {
        const p = s.pending.get(id);
        s.pending.delete(id);
        p?.reject(e);
      });
  });
}
function notify(s, method, params) {
  Promise.resolve()
    .then(() => s.transport?.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }))
    .catch(() => {});
}

// 服务端发来的消息：响应、通知、或者它向我们发的请求
function onMessage(s, msg) {
  if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const p = s.pending.get(msg.id);
    if (!p) return;
    s.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'notifications/tools/list_changed') {
    listTools(s).then(emit, () => {});
    return;
  }
  if (msg.id === undefined) return; // 其他通知（日志、进度）忽略
  const reply = (result, error) =>
    Promise.resolve()
      .then(() => s.transport.send(error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result }))
      .catch(() => {});
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'roots/list') {
    const ws = hooks.getWorkspace();
    return reply({ roots: ws ? [{ uri: pathToFileURL(ws).href, name: path.basename(ws) }] : [] });
  }
  reply(null, { code: -32601, message: 'Method not found' });
}

async function listTools(s) {
  const all = [];
  let cursor;
  for (let i = 0; i < 20; i++) {
    const r = await request(s, 'tools/list', cursor ? { cursor } : {}, 30000);
    all.push(...(r.tools || []));
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
  }
  s.tools = all;
  rebuildIndex();
}

// ---------- 本地（stdio）服务 ----------
async function openStdio(s, gen) {
  const cfg = s.config;
  const PATH = await fullPath();
  const runtime = runtimeOf(cfg.command);
  const exe = which(expandHome(cfg.command), PATH);
  if (!exe) {
    if (runtime) setStatus(s, 'missing', '', runtime);
    else setStatus(s, 'error', `command not found: ${cfg.command}`);
    return false;
  }
  const args = (cfg.args || []).map((a) => expandHome(String(a)));
  const env = { ...process.env, PATH, ...(cfg.env || {}) };
  const cwd = expandHome(cfg.cwd) || os.homedir();
  let proc;
  try {
    proc = isWin && /\.(cmd|bat)$/i.test(exe)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + [exe, ...args].map(winQuote).join(' ') + '"'], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : spawn(exe, args, { cwd, env, windowsHide: true });
  } catch (e) {
    setStatus(s, 'error', e.message);
    return false;
  }
  s.stderr = '';
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onMessage(s, JSON.parse(line));
      } catch {} // 不是 JSON 的输出（个别服务会往 stdout 打日志）忽略
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => (s.stderr = (s.stderr + d).slice(-4000)));
  proc.on('error', (e) => {
    if (gen !== s.gen) return;
    if (e.code === 'ENOENT' && runtime) setStatus(s, 'missing', '', runtime);
    else setStatus(s, 'error', e.message);
  });
  proc.on('exit', (code) => {
    if (gen !== s.gen) return;
    s.transport = null;
    const tail = (s.stderr || '').trim().split('\n').slice(-6).join('\n');
    // 127（shell）/ 9009（cmd）= 找不到命令，多半是 npx 里又调用了没装的东西
    if ((code === 127 || code === 9009) && runtime) return setStatus(s, 'missing', tail, runtime);
    setStatus(s, 'error', `exited (${code})${tail ? '\n' + tail : ''}`);
  });
  s.transport = {
    kind: 'stdio',
    send(msg) {
      if (!proc.stdin.writable) throw new Error('not running');
      proc.stdin.write(JSON.stringify(msg) + '\n');
    },
    close() {
      try {
        proc.stdin.end();
      } catch {}
      // Windows 上中间隔了一层 cmd.exe，要连子进程一起结束
      if (isWin && proc.pid) execFile('taskkill', ['/pid', String(proc.pid), '/t', '/f'], () => {});
      else {
        try {
          proc.kill();
        } catch {}
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, 3000).unref();
      }
    },
  };
  return true;
}

// ---------- 远程服务 ----------
// 同一个服务同时只续期一次：refresh_token 往往是一次性的，并发续期后面的都会失败
const refreshing = new Map();
async function getToken(s) {
  const key = authKey(s.config);
  const saved = hooks.auth.load(key);
  if (!saved) return null;
  if (saved.expires_at) {
    // 提前续期的余量：最多 1 分钟，有效期很短的 token 按一半算
    const life = saved.obtained_at ? saved.expires_at - saved.obtained_at : 3600000;
    if (saved.expires_at - Math.min(60000, life / 2) < Date.now()) {
      if (!refreshing.has(key)) {
        refreshing.set(key, remote.refresh(saved).then((r) => {
          if (r) hooks.auth.save(key, r);
          return r;
        }).finally(() => refreshing.delete(key)));
      }
      const r = await refreshing.get(key);
      return r ? r.access_token : null; // 续期失败，服务端会回 401 → 提示重新登录
    }
  }
  return saved.access_token;
}
function openRemote(s, gen) {
  const cfg = s.config;
  s.transport = remote.createRemoteTransport({
    url: cfg.url,
    headers: cfg.headers || {},
    type: cfg.type === 'sse' ? 'sse' : cfg.type === 'http' || cfg.type === 'streamable-http' ? 'http' : undefined,
    getToken: () => getToken(s),
    onMessage: (m) => gen === s.gen && onMessage(s, m),
    onClose: (e) => {
      // 旧版 SSE 的长连接断了就收不到响应了，标为出错让用户重连；新版 HTTP 每次请求独立，不用管
      if (gen === s.gen && s.transport?.mode === 'sse' && s.status === 'ready') setStatus(s, 'error', 'connection lost: ' + (e?.message || ''));
    },
  });
  return true;
}

async function start(s) {
  const cfg = s.config;
  s.tools = [];
  const gen = ++s.gen;
  if (cfg.disabled) return setStatus(s, 'disabled');
  if (!cfg.command && !cfg.url) return setStatus(s, 'error', 'missing "command" or "url"');
  setStatus(s, 'starting');
  const opened = cfg.url ? openRemote(s, gen) : await openStdio(s, gen);
  if (!opened || gen !== s.gen) return;
  try {
    const init = await request(s, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'Shuttle', version: require('../package.json').version },
    }, INIT_TIMEOUT_MS);
    if (gen !== s.gen) return;
    s.serverInfo = init.serverInfo || {};
    s.transport.setProtocolVersion?.(init.protocolVersion || PROTOCOL_VERSION);
    notify(s, 'notifications/initialized');
    if (init.capabilities && init.capabilities.tools === undefined) s.tools = [];
    else await listTools(s);
    if (gen !== s.gen) return;
    setStatus(s, 'ready');
  } catch (e) {
    if (gen !== s.gen || s.status !== 'starting') return;
    if (e.code === 'auth') {
      s.wwwAuth = e.wwwAuth;
      closeTransport(s);
      return setStatus(s, 'auth');
    }
    const tail = (s.stderr || '').trim().split('\n').slice(-6).join('\n');
    closeTransport(s);
    setStatus(s, 'error', e.message + (tail ? '\n' + tail : ''));
  }
}

function closeTransport(s) {
  const t = s.transport;
  s.transport = null;
  s.gen++;
  try {
    t?.close();
  } catch {}
}

// ---------- 对外接口 ----------
const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 按新配置启动 / 重启 / 停止服务（配置没变的服务不动） */
function apply(config) {
  config = config && typeof config === 'object' ? config : {};
  for (const [name, s] of servers) {
    if (!config[name] || !sameConfig(config[name], s.config)) {
      s.status = 'stopped';
      closeTransport(s);
      servers.delete(name);
    }
  }
  for (const [name, cfg] of Object.entries(config)) {
    if (servers.has(name)) continue;
    const s = { name, config: cfg || {}, status: 'starting', tools: [], pending: new Map(), nextId: 0, gen: 0, transport: null };
    servers.set(name, s);
    start(s);
  }
  rebuildIndex();
  emit();
}
function restart(name, { recheckPath = false } = {}) {
  const s = servers.get(name);
  if (!s) return;
  if (recheckPath) shellPathCache = null; // 用户刚装好 Node.js / uv，重新读 PATH
  closeTransport(s);
  start(s);
}
/** 运行环境装好后，重连所有缺这个环境的服务 */
function restartMissing(runtime) {
  shellPathCache = null;
  for (const s of servers.values()) if (s.status === 'missing' && (!runtime || s.missing === runtime)) restart(s.name);
}
function markInstalling(runtime, on) {
  for (const s of servers.values()) {
    if (on && s.status === 'missing' && s.missing === runtime) {
      s.status = 'installing';
    } else if (!on && s.status === 'installing' && s.missing === runtime) s.status = 'missing';
  }
  emit();
}
function stopAll() {
  for (const s of servers.values()) {
    s.status = 'stopped';
    closeTransport(s);
  }
}
/** 远程服务：打开浏览器登录授权，成功后重连 */
async function login(name) {
  const s = servers.get(name);
  if (!s || !s.config.url) return;
  const key = authKey(s.config);
  closeTransport(s);
  setStatus(s, 'authorizing');
  try {
    const data = await remote.authorize({
      serverUrl: s.config.url, wwwAuth: s.wwwAuth, saved: hooks.auth.load(key) || {}, oauthCfg: s.config.oauth || {},
      openExternal: hooks.openExternal, pages: hooks.pages,
    });
    hooks.auth.save(key, data);
    start(s);
  } catch (e) {
    setStatus(s, 'auth', e.message);
  }
}
function logout(name) {
  const s = servers.get(name);
  if (!s || !s.config.url) return;
  hooks.auth.clear(authKey(s.config));
  restart(name);
}

// 模型看到的工具名：mcp__服务__工具（OpenAI 要求 ^[a-zA-Z0-9_-]{1,64}$）
let index = new Map();
function toolName(server, tool) {
  const slug = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_');
  let n = `mcp__${slug(server)}__${slug(tool)}`;
  if (n.length > 64) n = n.slice(0, 55) + '_' + crypto.createHash('md5').update(server + '/' + tool).digest('hex').slice(0, 8);
  return n;
}
function cleanSchema(schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : {};
  delete s.$schema;
  if (s.type !== 'object') return { type: 'object', properties: {} };
  if (!s.properties) s.properties = {};
  return s;
}
function rebuildIndex() {
  index = new Map();
  for (const s of servers.values()) {
    if (s.status !== 'ready' && s.status !== 'starting') continue;
    for (const t of s.tools || []) index.set(toolName(s.name, t.name), { server: s.name, tool: t });
  }
}

// ---------- 工具按需加载 ----------
// 工具多的服务（比如腾讯文档有上百个工具）如果每次请求都把全部工具说明发给模型，
// 一次就是十几万 token。所以：工具数或说明总长度超过阈值的服务改成「按需加载」——
// 平时只在系统提示里列出服务名和工具数，模型需要时用 mcp_find_tools 搜索、mcp_call_tool 调用。
const LAZY_MAX_TOOLS = 15;
const LAZY_MAX_CHARS = 12000;
function toolDef(name, server, tool) {
  return {
    type: 'function',
    function: {
      name,
      description: `[MCP · ${server}] ${tool.title && tool.title !== tool.name ? tool.title + '：' : ''}${tool.description || tool.name}`.slice(0, 1000),
      parameters: cleanSchema(tool.inputSchema),
    },
  };
}
function isLazy(s) {
  const tools = s.tools || [];
  if (tools.length > LAZY_MAX_TOOLS) return true;
  let chars = 0;
  for (const t of tools) chars += (t.description || '').length + JSON.stringify(t.inputSchema || {}).length;
  return chars > LAZY_MAX_CHARS;
}
/** 已连上、走按需加载的服务：[{ name, count, sample }] */
function lazyServers() {
  return [...servers.values()]
    .filter((s) => s.status === 'ready' && isLazy(s))
    .map((s) => ({ name: s.name, count: s.tools.length, title: s.serverInfo?.title || s.serverInfo?.name || '' }));
}

/** 交给模型的工具定义（只包含已连上、工具不多的服务） */
function toolDefinitions() {
  const out = [];
  for (const [name, { server, tool }] of index) {
    const s = servers.get(server);
    if (s?.status !== 'ready' || isLazy(s)) continue;
    out.push(toolDef(name, server, tool));
  }
  return out;
}

// 搜索工具：按名称 / 标题 / 说明里出现的关键词打分（中文按两个字一组切）
function terms(q) {
  const out = new Set();
  for (const w of String(q || '').toLowerCase().split(/[\s,，。、;；:：/|()（）"'“”]+/).filter(Boolean)) {
    out.add(w);
    if (/[\u4e00-\u9fff]/.test(w) && w.length > 2) for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return [...out];
}
/**
 * 在按需加载的服务里找工具。返回完整说明（含参数），给模型决定怎么调用。
 * query 为空：返回工具清单（名字 + 一句话说明）。
 */
function findTools(query, serverName, limit = 12) {
  const list = [];
  for (const s of servers.values()) {
    if (s.status !== 'ready' || !isLazy(s) || (serverName && s.name !== serverName)) continue;
    for (const t of s.tools || []) list.push({ server: s.name, tool: t });
  }
  if (!list.length) return { servers: lazyServers(), tools: [] };
  const ts = terms(query);
  if (!ts.length) {
    return {
      overview: list.slice(0, 200).map(({ server, tool }) => ({ server, name: tool.name, description: (tool.title || tool.description || '').replace(/\s+/g, ' ').slice(0, 60) })),
    };
  }
  const scored = list
    .map((x) => {
      const name = (x.tool.name || '').toLowerCase();
      const text = ((x.tool.title || '') + ' ' + (x.tool.description || '')).toLowerCase();
      let score = 0;
      for (const w of ts) {
        if (name.includes(w)) score += 3;
        if (text.includes(w)) score += w.length >= 2 ? 2 : 1;
      }
      return { ...x, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return {
    tools: scored.map(({ server, tool }) => ({
      server,
      name: tool.name,
      description: (tool.title && tool.title !== tool.name ? tool.title + '：' : '') + (tool.description || '').slice(0, 800),
      parameters: cleanSchema(tool.inputSchema),
    })),
  };
}
/** 按「服务 + 原始工具名」调用（给 mcp_call_tool 用） */
function callByName(serverName, toolName, args, signal) {
  for (const [name, hit] of index) if (hit.server === serverName && hit.tool.name === toolName) return call(name, args, signal);
  throw new Error(`MCP tool "${toolName}" not found on "${serverName}"`);
}
const isMcpTool = (name) => typeof name === 'string' && name.startsWith('mcp__');
function lookup(name) {
  const hit = index.get(name);
  return hit ? { server: hit.server, tool: hit.tool.name } : null;
}

// 工具结果转成给模型看的文字
function formatResult(r) {
  const parts = [];
  for (const c of r.content || []) {
    if (c.type === 'text') parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image ${c.mimeType || ''}, ${Math.round(((c.data || '').length * 3) / 4 / 1024)} KB]`);
    else if (c.type === 'audio') parts.push(`[audio ${c.mimeType || ''}]`);
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[resource ${c.resource?.uri || ''}]`);
    else if (c.type === 'resource_link') parts.push(`[${c.name || 'resource'}] ${c.uri}`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  const text = parts.join('\n') || '(empty)';
  return { text: text.length > 60000 ? text.slice(0, 60000) + '\n…(truncated)' : text, isError: !!r.isError };
}

async function call(name, args, signal) {
  const hit = index.get(name);
  if (!hit) throw new Error(`unknown MCP tool ${name}`);
  const s = servers.get(hit.server);
  if (!s || s.status !== 'ready') throw new Error(`MCP server "${hit.server}" is not connected`);
  try {
    const r = await request(s, 'tools/call', { name: hit.tool.name, arguments: args || {} }, CALL_TIMEOUT_MS, signal);
    return formatResult(r);
  } catch (e) {
    if (e.code === 'auth') {
      s.wwwAuth = e.wwwAuth;
      closeTransport(s);
      setStatus(s, 'auth');
    } else if (e.code === 'session_expired') restart(s.name); // 远程会话过期：后台重连，模型可以再试一次
    throw e;
  }
}

/** 等某个服务连接结果出来（不再是 starting / authorizing），最多等 ms 毫秒 */
function waitSettled(name, ms = 60000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const st = servers.get(name)?.status;
      if (!st || !['starting', 'authorizing'].includes(st) || Date.now() - t0 > ms) return resolve(st);
      setTimeout(tick, 300);
    };
    tick();
  });
}

function init(opts = {}) {
  for (const k of Object.keys(hooks)) if (opts[k]) hooks[k] = opts[k];
  if (opts.language) lang = opts.language;
}
const setLang = (l) => (lang = l === 'en' ? 'en' : 'zh');

module.exports = { init, setLang, waitSettled, lazyServers, findTools, callByName, apply, restart, restartMissing, markInstalling, stopAll, login, logout, status, toolDefinitions, isMcpTool, lookup, call, RUNTIMES };
