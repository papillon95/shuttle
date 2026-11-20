// 远程 MCP 服务：传输层（Streamable HTTP，兼容旧版 HTTP+SSE）和 OAuth 登录授权
//
// Streamable HTTP（协议 2025-03-26 起）：每条消息 POST 到同一个地址，
//   响应是一条 JSON，或者一个 SSE 流（里面可能先有服务端发来的请求 / 通知，最后是响应）；
//   会话 ID 在 Mcp-Session-Id 头里来回传。
// 旧版 HTTP+SSE（2024-11-05）：先 GET 建立 SSE 长连接，第一条 endpoint 事件告诉我们 POST 地址，
//   之后所有响应都从这个长连接回来。
// OAuth：服务返回 401 时按 MCP 授权规范走：受保护资源元数据 → 授权服务器元数据 → 动态注册客户端
//   → 浏览器授权（PKCE）→ 本机回调拿 code → 换 token；token 过期用 refresh_token 续期。
const http = require('http');
const crypto = require('crypto');

class AuthRequired extends Error {
  constructor(wwwAuth) {
    super('authorization required');
    this.code = 'auth';
    this.wwwAuth = wwwAuth || '';
  }
}
class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}${body ? ': ' + String(body).slice(0, 300) : ''}`);
    this.status = status;
  }
}

// ---------- SSE 解析 ----------
async function readSse(body, onEvent, signal) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const flush = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) onEvent(event, data.join('\n'));
  };
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        flush(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
    }
    if (buf.trim()) flush(buf);
  } catch (e) {
    if (!signal?.aborted) throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

/**
 * 远程传输。用法：
 *   const t = createRemoteTransport({ url, headers, type, getToken, onMessage, onClose })
 *   await t.send(msg)   // 抛 AuthRequired / HttpError
 *   t.close()
 * type: 'http'（默认，先试 Streamable HTTP，不行自动退回旧版 SSE）| 'sse'（直接用旧版）
 */
function createRemoteTransport({ url, headers = {}, type, getToken, onMessage, onClose }) {
  const ctrl = new AbortController();
  let mode = type === 'sse' ? 'sse' : 'http';
  let sessionId = null;
  let protocolVersion = null;
  let sseEndpoint = null; // 旧版：POST 地址
  let sseReady = null;
  let getStreamOpened = false;
  let closed = false;

  const handle = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) onMessage(m);
  };
  async function authHeaders() {
    const h = { ...headers };
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'authorization')) {
      const tok = getToken ? await getToken() : null;
      if (tok) h.Authorization = 'Bearer ' + tok;
    }
    return h;
  }

  // ---- 旧版 HTTP+SSE ----
  function openLegacy() {
    if (sseReady) return sseReady;
    sseReady = (async () => {
      const res = await fetch(url, { headers: { Accept: 'text/event-stream', ...(await authHeaders()) }, signal: ctrl.signal });
      if (res.status === 401) throw new AuthRequired(res.headers.get('www-authenticate'));
      if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ''));
      let resolveEndpoint;
      const got = new Promise((r) => (resolveEndpoint = r));
      readSse(res.body, (event, data) => {
        if (event === 'endpoint') {
          sseEndpoint = new URL(data.trim(), url).href;
          resolveEndpoint();
        } else handle(data);
      }, ctrl.signal).then(() => !closed && onClose?.(new Error('SSE stream closed')), (e) => !closed && onClose?.(e));
      await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('SSE endpoint event timeout')), 30000))]);
    })();
    sseReady.catch(() => (sseReady = null));
    return sseReady;
  }
  async function sendLegacy(msg) {
    await openLegacy();
    const res = await fetch(sseEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeaders()) }, body: JSON.stringify(msg), signal: ctrl.signal });
    if (res.status === 401) throw new AuthRequired(res.headers.get('www-authenticate'));
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    // 响应从 SSE 长连接回来；个别实现也会直接在 POST 里返回 JSON
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const t = await res.text();
      if (t.trim()) handle(t);
    }
  }

  // ---- Streamable HTTP ----
  // 服务端主动推送（比如工具列表变化）走单独的 GET 长连接；服务端不支持（405）就算了
  async function openGetStream() {
    if (getStreamOpened || !sessionId) return;
    getStreamOpened = true;
    try {
      const h = { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId, ...(await authHeaders()) };
      if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
      const res = await fetch(url, { headers: h, signal: ctrl.signal });
      if (res.ok && res.body && (res.headers.get('content-type') || '').includes('text/event-stream')) readSse(res.body, (_e, d) => handle(d), ctrl.signal).catch(() => {});
    } catch {}
  }
  async function sendHttp(msg) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(await authHeaders()) };
    if (sessionId) h['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) h['MCP-Protocol-Version'] = protocolVersion;
    const res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(msg), signal: ctrl.signal });
    if (res.status === 401) throw new AuthRequired(res.headers.get('www-authenticate'));
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 404 && sessionId && msg.method !== 'initialize') {
      sessionId = null;
      const e = new HttpError(404, 'session expired');
      e.code = 'session_expired';
      throw e;
    }
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ''));
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      // 不等流结束：响应会通过 onMessage 交给等待中的请求
      readSse(res.body, (_e, d) => handle(d), ctrl.signal).catch((e) => !closed && onClose?.(e));
    } else {
      const t = await res.text();
      if (!t.trim()) return;
      // 不是 MCP 消息（比如高德 Key 不对时直接返回 {"status":"0","info":"INVALID_USER_KEY"}）：当错误报出来，别让请求干等到超时
      let parsed;
      try {
        parsed = JSON.parse(t);
      } catch {
        throw new HttpError(res.status, t);
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      if (!msgs.every((m) => m && m.jsonrpc === '2.0')) throw new HttpError(res.status, t);
      for (const m of msgs) onMessage(m);
    }
  }

  return {
    kind: 'remote',
    get mode() {
      return mode;
    },
    setProtocolVersion(v) {
      protocolVersion = v;
      if (mode === 'http') openGetStream();
    },
    async send(msg) {
      if (closed) throw new Error('closed');
      if (mode === 'sse') return sendLegacy(msg);
      try {
        return await sendHttp(msg);
      } catch (e) {
        // 按规范的兼容做法：initialize 被 400/404/405 拒绝，说明是旧版 SSE 服务
        if (msg.method === 'initialize' && e instanceof HttpError && [400, 404, 405].includes(e.status) && type !== 'http') {
          mode = 'sse';
          return sendLegacy(msg);
        }
        throw e;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (mode === 'http' && sessionId) {
        // 通知服务端结束会话（不等结果）
        authHeaders().then((h) => fetch(url, { method: 'DELETE', headers: { ...h, 'Mcp-Session-Id': sessionId }, signal: AbortSignal.timeout(3000) })).catch(() => {});
      }
      ctrl.abort();
    },
  };
}

// ---------- OAuth ----------
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getJson(u) {
  const r = await fetch(u, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new HttpError(r.status);
  return r.json();
}
async function firstJson(urls) {
  for (const u of urls) {
    try {
      return await getJson(u);
    } catch {}
  }
  return null;
}
// 资源的规范地址（RFC 8707 resource 参数）：去掉 fragment 和末尾斜杠
function canonicalResource(serverUrl) {
  const u = new URL(serverUrl);
  u.hash = '';
  return u.href.replace(/\/$/, '');
}

async function discover(serverUrl, wwwAuth) {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/$/, '');
  const rmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth || '')?.[1];
  const scope = /scope="([^"]+)"/.exec(wwwAuth || '')?.[1];
  const prm = await firstJson(
    rmUrl ? [rmUrl] : [`${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]
  );
  const asUrl = new URL((prm && prm.authorization_servers && prm.authorization_servers[0]) || u.origin);
  const asPath = asUrl.pathname.replace(/\/$/, '');
  const meta =
    (await firstJson([
      ...(asPath ? [`${asUrl.origin}/.well-known/oauth-authorization-server${asPath}`, `${asUrl.origin}/.well-known/openid-configuration${asPath}`, `${asUrl.origin}${asPath}/.well-known/openid-configuration`] : []),
      `${asUrl.origin}/.well-known/oauth-authorization-server`,
      `${asUrl.origin}/.well-known/openid-configuration`,
    ])) || {
      // 老的实现（2025-03-26）没有元数据，按默认路径
      authorization_endpoint: `${asUrl.origin}/authorize`,
      token_endpoint: `${asUrl.origin}/token`,
      registration_endpoint: `${asUrl.origin}/register`,
    };
  return { meta, scope: scope || (prm && prm.scopes_supported ? prm.scopes_supported.join(' ') : undefined) };
}

// 本机回调：监听 127.0.0.1 的一个端口，等浏览器把 code 带回来
function waitForCallback(port, state, timeoutMs, pages) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, `http://127.0.0.1:${port}`);
      if (q.pathname !== '/callback') return res.writeHead(404).end();
      const done = (ok, body) => {
        // Connection: close + 关掉所有连接：否则浏览器复用这条连接，下次登录的回调会打到这个已关闭的服务上
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Shuttle</title><body style="font-family:system-ui;text-align:center;padding-top:80px"><h2>${body}</h2></body>`);
        clearTimeout(timer);
        srv.close();
        setImmediate(() => srv.closeAllConnections?.());
        ok ? resolve(q.searchParams.get('code')) : reject(new Error(q.searchParams.get('error_description') || q.searchParams.get('error') || 'authorization failed'));
      };
      if (q.searchParams.get('state') !== state) return done(false, pages.fail);
      if (q.searchParams.get('error') || !q.searchParams.get('code')) return done(false, pages.fail);
      done(true, pages.ok);
    });
    const timer = setTimeout(() => {
      srv.close();
      srv.closeAllConnections?.();
      reject(new Error('authorization timed out'));
    }, timeoutMs);
    srv.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    srv.listen(port, '127.0.0.1');
  });
}
function freePort(preferred) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once('error', () => {
      const s2 = http.createServer();
      s2.listen(0, '127.0.0.1', () => {
        const p = s2.address().port;
        s2.close(() => resolve(p));
      });
    });
    s.listen(preferred || 0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function postForm(u, params) {
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = Object.fromEntries(new URLSearchParams(t));
  }
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `token HTTP ${r.status}`);
  return j;
}
const toSaved = (j, extra) => ({
  ...extra,
  access_token: j.access_token,
  refresh_token: j.refresh_token || extra.refresh_token,
  expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : null,
  obtained_at: Date.now(),
});

/**
 * 浏览器授权。saved：上次保存的数据（复用已注册的客户端）。返回要保存的数据（含 token）。
 * oauthCfg：配置里的 oauth 字段（可手动指定 clientId / clientSecret / scope / callbackPort）
 */
async function authorize({ serverUrl, wwwAuth, saved = {}, oauthCfg = {}, openExternal, pages, timeoutMs = 5 * 60 * 1000 }) {
  const { meta, scope: discoveredScope } = await discover(serverUrl, wwwAuth);
  if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error('OAuth metadata not found');
  const port = await freePort(oauthCfg.callbackPort || saved.port || 33418);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let client = oauthCfg.clientId ? { client_id: oauthCfg.clientId, client_secret: oauthCfg.clientSecret } : saved.client;
  if (!oauthCfg.clientId && (!client || !client.redirect_uris || !client.redirect_uris.includes(redirectUri))) {
    if (!meta.registration_endpoint) throw new Error('This server does not support automatic client registration; set "oauth": {"clientId": "..."} in the config');
    const r = await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_name: 'Shuttle', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`client registration failed: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    client = { ...(await r.json()), redirect_uris: [redirectUri] };
  }

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const scope = oauthCfg.scope || discoveredScope;
  const authUrl = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256',
    state, resource: canonicalResource(serverUrl), scope,
  })) if (v) authUrl.searchParams.set(k, v);

  const codeP = waitForCallback(port, state, timeoutMs, pages);
  await openExternal(authUrl.href);
  const code = await codeP;
  const tok = await postForm(meta.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret,
    code_verifier: verifier, resource: canonicalResource(serverUrl),
  });
  return toSaved(tok, { client, port, token_endpoint: meta.token_endpoint, resource: canonicalResource(serverUrl) });
}

/** 用 refresh_token 续期，失败返回 null（需要重新登录） */
async function refresh(saved) {
  if (!saved || !saved.refresh_token || !saved.token_endpoint) return null;
  try {
    const tok = await postForm(saved.token_endpoint, {
      grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: saved.client?.client_id, client_secret: saved.client?.client_secret, resource: saved.resource,
    });
    return toSaved(tok, saved);
  } catch {
    return null;
  }
}

module.exports = { createRemoteTransport, authorize, refresh, AuthRequired, HttpError };
