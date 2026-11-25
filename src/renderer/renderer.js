const $ = (id) => document.getElementById(id);
// 按系统加 class：Windows / Linux 没有红绿灯，顶栏右边让出系统按钮的位置，滚动条用自绘的细滚动条
// 调试：localStorage 里 shuttle.fakeOs = win 时在 Mac 上也按 Windows 的样式显示（检查 Windows 界面用）
const FAKE_OS = (() => { try { return localStorage.getItem('shuttle.fakeOs'); } catch { return null; } })();
// 配色主题：先用上次存在本机的，避免启动时先闪一下默认配色（设置读到后再以设置为准）
try { const p = localStorage.getItem('shuttle.palette'); if (p && p !== 'default') document.documentElement.dataset.palette = p; } catch {}
document.documentElement.classList.add(FAKE_OS === 'win' ? 'os-win' : /Mac/.test(navigator.platform) ? 'os-mac' : /Win/.test(navigator.platform) ? 'os-win' : 'os-linux');
let settings;
let running = false;
let thinkingEl = null;
let toolEls = {};
let currentConvId = null;

// ---------- 多语言 ----------
const lang = () => (settings && settings.language) || 'zh';
const T = (key, vars) => window.I18N.t(lang(), key, vars);
const pName = (p) => (lang() === 'en' && p.nameEn) || p.name;
const mLabel = (m) => (lang() === 'en' && m.labelEn) || m.label;
function applyI18n() {
  document.documentElement.lang = lang() === 'en' ? 'en' : 'zh-CN';
  document.title = T('version', { v: '' }).replace(/ v$/, '');
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = T(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => (el.placeholder = T(el.dataset.i18nPh)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = T(el.dataset.i18nTitle)));
}
// 切换语言后，把动态生成的部分也重新渲染一遍
function rerenderAll() {
  applyI18n();
  renderModelSel();
  renderWorkspace();
  setRunning(running);
  if ($('emptyHint')) clearLog();
  else if (currentConvId && !running) openConv(currentConvId); // 重新渲染当前对话里的工具卡片
  refreshConvs();
  if (currentUser) loadBanners();
}
async function setLanguage(l) {
  settings = await window.api.saveSettings({ language: l });
  rerenderAll();
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const baseName = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() || p : '');

// Markdown 渲染（md / mdBlock / mdInline）在 markdown.js 里，和快捷小窗共用
// 聊天区里的链接用系统浏览器打开；代码块「复制」
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) {
    e.preventDefault();
    if (/^https?:\/\//i.test(a.dataset.href)) window.api.openExternal(a.dataset.href);
    return;
  }
  const btn = e.target.closest('.code-copy');
  if (btn) {
    const code = btn.closest('.code').querySelector('code').textContent;
    const done = () => {
      btn.textContent = T('copied');
      setTimeout(() => (btn.textContent = T('copy')), 1500);
    };
    navigator.clipboard.writeText(code).then(done, () => {
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    });
  }
});

// ---------- 聊天区 ----------
function clearLog() {
  setSuggestion('');
  hideLongBanner();
  const w = settings?.workspace || '';
  const isDefault = w && w === settings.defaultWorkspace;
  const sugs = (w ? ['sug1', 'sug2', 'sug3', 'sug4'] : ['sugChat1', 'sugChat2', 'sugChat3', 'sugChat4']).map((k) => T(k));
  $('log').innerHTML = `<div class="empty" id="emptyHint">
      <img class="empty-logo" src="../assets/icon-128.png" alt="" />
      <h2>${esc(T('emptyTitle'))}</h2>
      <p>${esc(T(w ? 'emptyBody' : 'emptyBodyChat'))}</p>
      <div class="sugs">${sugs.map((t) => `<button class="sug" type="button">${esc(t)}</button>`).join('')}</div>
      <div class="empty-ws">${w ? `📁 ${esc(T(isDefault ? 'emptyWsDefault' : 'emptyWs', { name: baseName(w) }))} · <a id="emptyWsChange">${esc(T('changeWs'))}</a>` : `💬 ${esc(T('emptyNoFolder'))} · <a id="emptyWsChange">${esc(T('chooseFolderForFiles'))}</a>`}</div>
    </div>`;
  $('log').querySelectorAll('.sug').forEach((b) => (b.onclick = () => {
    $('input').value = b.textContent;
    autosizeInput();
    $('input').focus();
  }));
  $('emptyWsChange').onclick = () => $('wsBtn').click();
  toolEls = {};
  thinkingEl = null;
  $('usage').textContent = '';
  renderCtx(null);
}
function append(el) {
  $('emptyHint')?.remove();
  const log = $('log');
  log.insertBefore(el, thinkingEl && thinkingEl.parentNode ? thinkingEl : null);
  log.scrollTop = log.scrollHeight;
}
function addMsg(cls, html) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  d.innerHTML = html;
  append(d);
  return d;
}
// 用户消息下面的「复制」「重新发送」：模型半天没回、报错时，不用重新打字
const USER_ACT_ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  resend: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/></svg>',
};
/** payload：{ text, images: [dataURL], files: [{name, path, size}] } */
function addUserMsg(html, payload) {
  const el = addMsg('user', html);
  const acts = document.createElement('div');
  acts.className = 'user-acts';
  acts.innerHTML = `<button type="button" class="ua-copy" title="${esc(T('copy'))}">${USER_ACT_ICONS.copy}</button><button type="button" class="ua-resend" title="${esc(T('resend'))}">${USER_ACT_ICONS.resend}</button>`;
  acts.querySelector('.ua-copy').onclick = () => navigator.clipboard.writeText(payload.text || '').then(() => showToast(T('copied'), 'info'));
  acts.querySelector('.ua-resend').onclick = () => resendUser(payload);
  // 最新一条的按钮一直显示（模型没回时最需要它），之前的悬停才显示
  document.querySelectorAll('.user-acts.latest').forEach((x) => x.classList.remove('latest'));
  acts.classList.add('latest');
  el.after(acts);
  return el;
}
/** 重新发送：把这条消息（文字、图片、附件）原样再发一次 */
function resendUser(payload) {
  if (running) return showToast(T('resendBusy'), 'info');
  $('input').value = payload.text || '';
  pendingImages = (payload.images || []).map((url) => ({ url }));
  pendingFiles = (payload.files || []).filter((f) => f && f.path).map((f) => ({ name: f.name, path: f.path, size: f.size }));
  renderAttachments();
  submit();
}
/** 从保存的消息里取出重新发送需要的内容 */
function userPayload(m) {
  const parts = Array.isArray(m.content) ? m.content : null;
  const text = m.attachments ? m.userText || '' : parts ? parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : String(m.content || '');
  const images = parts ? parts.filter((p) => p.type === 'image_url' && /^data:image\//.test(p.image_url?.url || '')).map((p) => p.image_url.url) : [];
  return { text, images, files: m.attachments || [] };
}

// 用户消息：纯文字，或 [{type:'text'}, {type:'image_url'}] 这种图文混合
const FILE_ICON = {doc:'📄',docx:'📄',pdf:'📕',xlsx:'📊',csv:'📊',tsv:'📊',pptx:'📽️'};
function fileChips(files, removable) {
  if (!files?.length) return '';
  return `<div class="file-chips">${files.map((f, i) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return `<span class="file-chip" title="${esc(f.path || f.name)}"><i>${FILE_ICON[ext] || '📝'}</i><span class="fn">${esc(f.name)}</span><span class="fs">${esc(fmtSizeShort(f.size))}</span>${removable ? `<button type="button" data-rm="${i}" title="${esc(T('removeImage'))}">×</button>` : ''}</span>`;
  }).join('')}</div>`;
}
function fmtSizeShort(n) {
  n = Number(n) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
function userHtml(content, files) {
  if (files?.length) {
    if (typeof content === 'string') return esc(content) + fileChips(files);
    return userHtml(content) + fileChips(files);
  }
  if (typeof content === 'string') return esc(content);
  const text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const imgs = content.filter((p) => p.type === 'image_url' && /^data:image\//.test(p.image_url?.url || ''));
  return (
    esc(text) +
    (imgs.length ? `<div class="imgs">${imgs.map((p) => `<img src="${esc(p.image_url.url)}" alt="">`).join('')}</div>` : '')
  );
}
function fileUrl(p) {
  const norm = String(p).replace(/\\/g, '/');
  return 'file://' + (norm.startsWith('/') ? '' : '/') + norm.split('/').map(encodeURIComponent).join('/').replace(/^\/([A-Za-z])%3A/, '/$1:');
}
// 批量生图：每生成一张就往网格里加一张缩略图
function showToolImageGrid(callId, absPath) {
  const el = toolEls[callId];
  if (!el) return;
  let grid = el.querySelector('.gen-grid');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'gen-grid';
    el.insertBefore(grid, el.querySelector('pre'));
  }
  if ([...grid.children].some((x) => x.title === absPath)) return;
  const img = document.createElement('img');
  img.src = fileUrl(absPath) + '?t=' + Date.now();
  img.title = absPath;
  img.loading = 'lazy';
  img.onclick = () => window.api.openImage(absPath);
  img.onerror = () => img.remove();
  grid.appendChild(img);
  el.open = true;
  $('log').scrollTop = $('log').scrollHeight;
}
function showToolImage(callId, absPath) {
  const el = toolEls[callId];
  if (!el || el.querySelector('.gen-img')) return;
  const img = document.createElement('img');
  img.className = 'gen-img';
  img.src = fileUrl(absPath) + '?t=' + Date.now();
  img.title = absPath;
  img.onclick = () => window.api.openImage(absPath);
  img.onerror = () => img.remove();
  el.insertBefore(img, el.querySelector('pre'));
  el.open = true;
  $('log').scrollTop = $('log').scrollHeight;
}

// 配音结果：在工具卡片里放一个播放器
function showToolAudio(callId, absPath) {
  const el = toolEls[callId];
  if (!el || el.querySelector('.gen-audio')) return;
  const au = document.createElement('audio');
  au.className = 'gen-audio';
  au.controls = true;
  au.preload = 'metadata';
  au.src = fileUrl(absPath) + '?t=' + Date.now();
  au.title = absPath;
  au.onerror = () => au.remove();
  el.insertBefore(au, el.querySelector('pre'));
  el.open = true;
  $('log').scrollTop = $('log').scrollHeight;
}

const SEND_ICONS = {
  send: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>',
};
// 输入框随内容长高（最多约 10 行）
function autosizeInput() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}
$('input').addEventListener('input', autosizeInput);
$('sendBtn').innerHTML = SEND_ICONS.send;

function setRunning(v) {
  running = v;
  document.body.classList.toggle('busy', v);
  $('sendBtn').innerHTML = v ? SEND_ICONS.stop : SEND_ICONS.send;
  $('sendBtn').title = v ? T('stop') : T('send');
  $('sendBtn').classList.toggle('stop', v);
  if (!v && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

// MCP 工具名：mcp__服务__工具 → 「MCP · 服务 / 工具」
function toolLabel(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  return m ? `MCP · ${m[1]} / ${m[2]}` : T('tool_' + name);
}
function toolSummary(name, a) {
  if (name === 'mcp_call_tool') return `${a.server || ''} / ${a.tool || ''}  ${JSON.stringify(a.arguments || {}).slice(0, 120)}`;
  if (name === 'mcp_find_tools') return a.query || '';
  if (/^mcp__/.test(name || '')) return JSON.stringify(a || {}).slice(0, 160);
  if (/^mcp_/.test(name || '')) return a.name || '';
  if (name === 'browser_open') return a.url || '';
  if (name === 'browser_click') return '#' + (a.id || '');
  if (name === 'browser_type') return `#${a.id || ''}  ${(a.text || '').slice(0, 80)}${a.submit ? ' ⏎' : ''}`;
  if (name === 'browser_press') return a.key || '';
  if (name === 'browser_scroll') return a.direction === 'up' ? '↑' : '↓';
  if (/^browser_/.test(name || '')) return '';
  if (name === 'search') return a.pattern;
  if (name === 'run_command') return a.command;
  if (name === 'generate_image') return a.prompt;
  if (name === 'text_to_speech') return (a.voice ? a.voice + ' · ' : '') + String(a.text || a.text_file || '').slice(0, 80);
  if (name === 'generate_images') return T('batchToolSummary', { n: (a.items || []).length });
  if (name === 'ai_visibility' || name === 'geo_content') return a.brand || a.project || '';
  if (name === 'ask_expert') return (a.expert ? a.expert + ' · ' : '') + (a.question || '');
  return a.path || '';
}
// 逐行对比（改文件 / 写文件、确认框共用）：del 红、add 绿、ctx 原样、gap 表示中间省略了没改的行
function diffHtml(rows) {
  return rows
    .map((l) =>
      l.type === 'gap'
        ? '<div class="line gap"><span class="no">⋯</span><span></span></div>'
        : `<div class="line ${l.type}"><span class="no">${l.no}</span><span class="sign">${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span><span>${esc(l.text)}</span></div>`
    )
    .join('');
}
function renderTool(evt) {
  let el = toolEls[evt.id];
  if (!el) {
    el = document.createElement('details');
    el.className = 'tool';
    el.innerHTML = `<summary><span class="st">⏳</span><span class="name">${esc(toolLabel(evt.name))}</span><span class="arg">${esc(
      toolSummary(evt.name, evt.args || {})
    )}</span></summary><pre></pre>`;
    toolEls[evt.id] = el;
    append(el);
  }
  if (evt.status === 'done') {
    const failed = /^(错误|用户拒绝|已中断|Error|User rejected|Interrupted)/.test(evt.result);
    el.querySelector('.st').textContent = failed ? '⚠️' : '✓';
    el.querySelector('pre').textContent = evt.result;
    // 改了文件：标题后面显示 +几 -几，展开就是逐行对比（改动不多时默认展开）
    if (evt.diff && evt.diff.rows?.length && !failed && !el.querySelector('.diff')) {
      el.querySelector('summary').insertAdjacentHTML('beforeend', `<span class="dstat"><b class="a">+${evt.diff.add}</b> <b class="d">-${evt.diff.del}</b></span>`);
      el.querySelector('pre').insertAdjacentHTML('beforebegin', `<div class="diff tool-diff">${diffHtml(evt.diff.rows)}</div>`);
      el.querySelector('pre').classList.add('hidden');
      el.classList.add('has-diff');
      if (evt.diff.rows.length <= 60) el.open = true;
    }
  }
}

// ---------- 外援（Claude Code / Codex） ----------
let expertsAvail = []; // 检测到的外援
const EXPERT_NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen Code', cursor: 'Cursor Agent', copilot: 'GitHub Copilot CLI', opencode: 'OpenCode', aider: 'Aider' };
const expertName = (id) => [...expertsAvail, ...expertsAllR].find((x) => x.id === id)?.name || EXPERT_NAMES[id] || id;
const EXPERT_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z"/></svg>';
const expertTag = (name) => `<div class="expert-tag">${EXPERT_ICON}${esc(T('expertFrom', { name }))}</div>`;
async function loadExperts(force) {
  try {
    expertsAvail = (await window.api.expertsList(force)).list || [];
  } catch {
    expertsAvail = [];
  }
  renderExpertBar();
  // 模型列表里的「本机 AI 工具」一组跟着更新；选着外援的话，后台先查一下它能不能用
  try {
    expertHealth = (await window.api.expertsHealth()) || {};
  } catch {}
  renderModelSel();
  if (settings?.chatExpert && expertsAvail.some((x) => x.id === settings.chatExpert)) checkChatExpert(settings.chatExpert, false);
  return expertsAvail;
}
let expertHealth = {}; // id -> { ok, error }：选中时检查过的结果
const expertChecking = {}; // 正在检查的：同一个外援同时只查一次，提示也只弹一次
async function checkChatExpert(id, announce) {
  if (expertChecking[id]) return expertChecking[id];
  expertChecking[id] = window.api.expertsCheck(id).catch(() => null);
  const h = await expertChecking[id];
  delete expertChecking[id];
  if (!h) return;
  expertHealth[id] = h;
  renderModelSel();
  if (!h.ok && settings.chatExpert === id) showToast(h.error, 'error');
  else if (h.ok && announce) showToast(T('chatExpertReady', { name: expertName(id) }), 'info');
}
function hideExpertBar() {
  document.getElementById('expertBar')?.remove();
}
/** 最后一条是 Shuttle 的回答、没在运行、电脑上装了外援时，在回答下面显示「回答不满意？让 xx 回答」 */
function renderExpertBar() {
  hideExpertBar();
  if (running || !expertsAvail.length || (currentConvId && runningConvs.has(currentConvId))) return;
  // 看界面上最后一条：是一段回答（不是工具、报错、确认框）才显示
  const log = $('log');
  const lastEl = [...log.children].reverse().find((el) => !el.classList.contains('thinking'));
  if (!lastEl || !lastEl.matches('.msg.assistant') || !log.querySelector('.msg.user, .msg.expert-ask')) return;
  const bar = document.createElement('div');
  bar.id = 'expertBar';
  bar.className = 'expert-bar';
  // 一排小头像按钮：默认外援排第一，最多放 3 个，其他的收进「+N」
  // 选着某个本机 AI 工具时，它自己就不用再列在「换个 AI 回答」里了
  const pool = expertsAvail.filter((x) => x.id !== settings.chatExpert);
  if (!pool.length) return;
  const def = pool.find((x) => x.id === settings.expertDefault);
  const ordered = def ? [def, ...pool.filter((x) => x !== def)] : pool;
  const shown = ordered.length > 3 ? ordered.slice(0, 2) : ordered;
  const rest = ordered.slice(shown.length);
  bar.innerHTML =
    `<span class="eb-lead">${EXPERT_ICON}${esc(T('expertBarLead'))}</span>` +
    shown.map((x) => `<button type="button" class="eb-ask" data-id="${esc(x.id)}" title="${esc(T('expertBarBtn', { name: x.name }))}">${expertBadge(x)}<span>${esc(expertShort(x.name))}</span></button>`).join('') +
    (rest.length ? `<button type="button" class="eb-more" title="${esc(T('expertBarMore'))}">${rest.slice(0, 3).map((x) => expertBadge(x)).join('')}<span>+${rest.length}</span></button>` : '');
  const setBusy = (v) => bar.querySelectorAll('button').forEach((x) => (x.disabled = v));
  const ask = async (id) => {
    setBusy(true);
    const r = await window.api.expertAsk(id);
    if (r?.error) {
      showToast(r.error, 'error');
      setBusy(false);
    } else if (r?.cancelled) setBusy(false);
  };
  bar.querySelectorAll('.eb-ask').forEach((b) => (b.onclick = () => ask(b.dataset.id)));
  bar.querySelector('.eb-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openExpertMenu(e.currentTarget, rest, ask);
  });
  append(bar);
}
// 外援的小头像：各家的品牌色 + 首字母；自己添加的工具用灰色
const EXPERT_COLORS = { claude: '#d97757', codex: '#111827', gemini: '#4285f4', qwen: '#615ced', cursor: '#1f2937', copilot: '#6e40c9', opencode: '#f97316', aider: '#14b8a6' };
function expertBadge(x) {
  const color = EXPERT_COLORS[x.id] || '#8b8f96';
  const letter = (expertShort(String(x.name || x.id)).trim()[0] || '?').toUpperCase();
  return `<i class="eb-badge" style="background:${color}">${esc(letter)}</i>`;
}
/** 按钮上用短名字：去掉「CLI」「GitHub」「Agent」这类后缀 */
function expertShort(name) {
  return String(name || '').replace(/^GitHub\s+/i, '').replace(/\s+(CLI|Agent|Code CLI)$/i, '').trim() || name;
}
let expertsAllR = []; // 设置页：全部检测结果（含没找到的、自己添加的）
function expertTags(e) {
  const tags = [];
  if (e.found) tags.push(`<span class="xtag ${e.readOnly === true ? 'ok' : 'warn'}">${esc(T(e.readOnly === true ? 'expertTagReadOnly' : 'expertTagUnknown'))}</span>`);
  if (e.custom) tags.push(`<span class="xtag">${esc(T('expertTagCustom'))}</span>`);
  else if (e.manual) tags.push(`<span class="xtag">${esc(T('expertTagManual'))}</span>`);
  return tags.join('');
}
/** 行内的「指定路径」编辑框 */
function pathEditor(row, e) {
  row.querySelector('.x-edit')?.remove();
  const ed = document.createElement('div');
  ed.className = 'x-edit';
  ed.innerHTML = `<div class="x-path"><input class="x-path-in" spellcheck="false" placeholder="${esc(T('expertPathPh'))}" value="${esc(e.manual ? e.path : '')}" /><button type="button" class="ghost small x-browse">${esc(T('expertBrowse'))}</button><button type="button" class="primary small x-ok">${esc(T('expertSave'))}</button>${e.manual ? `<button type="button" class="ghost small x-auto">${esc(T('expertAutoPath'))}</button>` : ''}<button type="button" class="ghost small x-cancel">${esc(T('cancel'))}</button></div><div class="hint">${esc(T('expertPathHow'))}</div><div class="x-msg"></div>`;
  row.appendChild(ed);
  const inp = ed.querySelector('.x-path-in');
  inp.focus();
  ed.querySelector('.x-browse').onclick = async () => {
    const p = await window.api.expertsPick();
    if (p) inp.value = p;
  };
  ed.querySelector('.x-cancel').onclick = () => ed.remove();
  const save = async (val) => {
    ed.querySelector('.x-msg').textContent = '';
    const r = await window.api.expertsSet(e.id, { path: val });
    if (r.error) return (ed.querySelector('.x-msg').textContent = r.error);
    applyExpertsView(r);
  };
  ed.querySelector('.x-ok').onclick = () => save(inp.value.trim());
  ed.querySelector('.x-auto')?.addEventListener('click', () => save(''));
  inp.onkeydown = (ev) => ev.key === 'Enter' && save(inp.value.trim());
}
async function testExpert(row, target) {
  const msg = row.querySelector('.x-result') || row.appendChild(Object.assign(document.createElement('div'), { className: 'x-result' }));
  msg.className = 'x-result';
  msg.innerHTML = `<i class="spin-sm"></i>${esc(T('expertTesting'))}`;
  const r = await window.api.expertsTest(target);
  msg.className = 'x-result ' + (r.ok ? 'ok' : 'err');
  msg.textContent = r.ok ? T('expertTestOk', { s: Math.round(r.ms / 100) / 10, text: r.text.replace(/\s+/g, ' ').slice(0, 80) }) : r.error;
  return r;
}
function expertRow(e) {
  const row = document.createElement('div');
  row.className = 'expert-row' + (e.found ? ' ok' : '');
  const sub = e.found
    ? `<div class="hint mono">${esc(e.path)}</div>${e.custom ? `<div class="hint mono">${esc(e.name)} ${esc(e.argsLine || '')}</div>` : e.login ? `<div class="hint">${esc(T('expertLoginFirst', { cmd: e.login }))}</div>` : ''}`
    : `<div class="hint">${esc(e.install ? T('expertInstall', { cmd: e.install }) : e.path || '')}</div>`;
  const acts = e.found
    ? `<button type="button" class="ghost small x-test">${esc(T('expertTest'))}</button>${e.custom ? `<button type="button" class="ghost small x-editc">${esc(T('expertEdit'))}</button><button type="button" class="ghost small danger x-del">${esc(T('expertRemove'))}</button>` : `<button type="button" class="ghost small x-path-btn">${esc(T('expertChangePath'))}</button>`}`
    : e.custom ? `<button type="button" class="ghost small danger x-del">${esc(T('expertRemove'))}</button>` : `<button type="button" class="ghost small x-path-btn">${esc(T('expertSetPath'))}</button>`;
  row.innerHTML = `<div class="x-main"><div class="expert-ic">${EXPERT_ICON}</div><div class="tx"><div class="x-title"><b>${esc(e.name)}</b>${e.found && e.version ? `<span class="x-ver">v${esc(e.version)}</span>` : ''}${expertTags(e)}</div>${sub}<div class="x-acts">${acts}</div></div>${e.found ? `<label class="switch"><input type="checkbox" class="x-on" ${e.enabled ? 'checked' : ''} /><i></i></label>` : ''}</div>`;
  row.querySelector('.x-on')?.addEventListener('change', async (ev) => applyExpertsView(await window.api.expertsSet(e.id, { enabled: ev.target.checked })));
  row.querySelector('.x-test')?.addEventListener('click', (ev) => {
    ev.target.disabled = true;
    testExpert(row, { id: e.id }).finally(() => (ev.target.disabled = false));
  });
  row.querySelector('.x-path-btn')?.addEventListener('click', () => pathEditor(row, e));
  row.querySelector('.x-del')?.addEventListener('click', async () => {
    if (confirm(T('expertRemoveConfirm', { name: e.name }))) applyExpertsView(await window.api.expertsRemoveCustom(e.id));
  });
  row.querySelector('.x-editc')?.addEventListener('click', () => {
    const c = expertsAllR.find((x) => x.id === e.id);
    openExpertAdd({ name: c.name, path: c.path, argsLine: c.argsLine, output: 'text', readOnly: c.readOnly === true }, e.id);
  });
  return row;
}
function applyExpertsView(r) {
  if (!r || r.error) return r?.error && showToast(r.error, 'error');
  expertsAllR = r.all || [];
  expertsAvail = r.avail || expertsAvail;
  const found = expertsAllR.filter((e) => e.found || e.custom);
  const missing = expertsAllR.filter((e) => !e.found && !e.custom);
  const box = $('expertList');
  box.innerHTML = found.length ? '' : `<div class="hint">${esc(T('expertsFoundNone'))}</div>`;
  found.forEach((e) => box.appendChild(expertRow(e)));
  const mb = $('expertMissing');
  mb.innerHTML = '';
  missing.forEach((e) => mb.appendChild(expertRow(e)));
  mb.closest('details').classList.toggle('hidden', !missing.length);
  $('expertOpts').classList.toggle('hidden', !expertsAvail.length);
  const sel = $('expertDefault');
  sel.innerHTML = expertsAvail.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  sel.value = expertsAvail.some((x) => x.id === settings.expertDefault) ? settings.expertDefault : expertsAvail[0]?.id || '';
  $('expertAuto').checked = settings.expertAuto !== false;
  $('expertAllowEdits').checked = !!settings.expertAllowEdits;
  renderExpertBar();
}
/** 「▾」弹出其他外援（样式和模型下拉一样） */
function openExpertMenu(anchor, list, onPick) {
  document.getElementById('expertMenu')?.remove();
  const pop = document.createElement('div');
  pop.id = 'expertMenu';
  pop.className = 'pick-pop';
  pop.innerHTML = `<div class="pick-group">${esc(T('expertBarOthers'))}</div>` + list.map((x) => `<div class="pick-item eb-item" data-id="${esc(x.id)}">${expertBadge(x)}<span class="pick-label">${esc(T('expertBarBtn', { name: x.name }))}</span></div>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  const below = window.innerHeight - r.bottom - 12;
  if (below < pop.offsetHeight && r.top > below) {
    pop.style.bottom = window.innerHeight - r.top + 6 + 'px';
    pop.classList.add('up');
  } else pop.style.top = r.bottom + 6 + 'px';
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc_, true);
  };
  const outside = (e) => !pop.contains(e.target) && e.target !== anchor && close();
  const esc_ = (e) => e.key === 'Escape' && close();
  pop.querySelectorAll('.pick-item').forEach((it) => {
    it.onmousemove = () => {
      pop.querySelectorAll('.kb').forEach((x) => x.classList.remove('kb'));
      it.classList.add('kb');
    };
    it.onclick = () => {
      close();
      onPick(it.dataset.id);
    };
  });
  setTimeout(() => {
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', esc_, true);
  });
}
async function refreshExpertsPane(force) {
  const r = await window.api.expertsList(force);
  applyExpertsView(r);
}
/** 添加其他工具：选程序 → 分析用法 → 确认 / 修改 → 测试 → 保存。editId：编辑已添加的 */
function openExpertAdd(draft, editId) {
  const box = $('expertAdd');
  box.classList.remove('hidden');
  const d = draft || { path: '' };
  box.innerHTML = `<div class="x-step1"><div class="x-path"><input class="x-path-in" spellcheck="false" placeholder="${esc(T('expertPathPh'))}" value="${esc(d.path || '')}" /><button type="button" class="ghost small x-browse">${esc(T('expertBrowse'))}</button><button type="button" class="primary small x-analyze">${esc(T('expertAnalyze'))}</button><button type="button" class="ghost small x-close">${esc(T('cancel'))}</button></div><div class="hint">${esc(T('expertPathHow'))}</div><div class="x-msg"></div></div><div class="x-form hidden"></div>`;
  const inp = box.querySelector('.x-path-in');
  const msg = box.querySelector('.x-msg');
  box.querySelector('.x-close').onclick = () => box.classList.add('hidden');
  box.querySelector('.x-browse').onclick = async () => {
    const p = await window.api.expertsPick();
    if (p) inp.value = p;
  };
  const showForm = (f) => {
    const form = box.querySelector('.x-form');
    form.classList.remove('hidden');
    form.innerHTML = `${f.notes ? `<div class="hint x-notes">${esc(T('expertFormNotes', { notes: f.notes }))}</div>` : ''}
      <label class="x-field"><span>${esc(T('expertFormName'))}</span><input class="f-name" value="${esc(f.name || '')}" /></label>
      <label class="x-field"><span>${esc(T('expertFormArgs'))}</span><div class="x-cmd"><code>${esc((f.path || '').split(/[\\/]/).pop())}</code><input class="f-args mono" spellcheck="false" value="${esc(f.argsLine || '')}" /></div></label>
      <div class="hint">${esc(T('expertFormArgsHint'))}</div>
      <div class="x-field"><span>${esc(T('expertFormOutput'))}</span><label class="x-radio"><input type="radio" name="fout" value="text" ${f.output !== 'json' ? 'checked' : ''}/> ${esc(T('expertFormText'))}</label><label class="x-radio"><input type="radio" name="fout" value="json" ${f.output === 'json' ? 'checked' : ''}/> ${esc(T('expertFormJson'))}</label><input class="f-field mono" placeholder="response" value="${esc(f.jsonField || '')}" /></div>
      <label class="x-check"><input type="checkbox" class="f-ro" ${f.readOnly ? 'checked' : ''}/> ${esc(T('expertFormReadOnly'))}</label>
      <div class="x-acts"><button type="button" class="ghost small f-test">${esc(T('expertTest'))}</button><button type="button" class="primary small f-save">${esc(T('expertSave'))}</button></div>
      <div class="x-result"></div>`;
    const read = () => ({
      name: form.querySelector('.f-name').value,
      path: f.path,
      argsLine: form.querySelector('.f-args').value,
      output: form.querySelector('input[name=fout]:checked').value,
      jsonField: form.querySelector('.f-field').value,
      readOnly: form.querySelector('.f-ro').checked,
    });
    form.querySelector('.f-test').onclick = async (ev) => {
      ev.target.disabled = true;
      await testExpert(form, { draft: read() });
      ev.target.disabled = false;
    };
    form.querySelector('.f-save').onclick = async () => {
      const r = await window.api.expertsSaveCustom(read(), editId);
      if (r.error) return (form.querySelector('.x-result').textContent = r.error);
      box.classList.add('hidden');
      applyExpertsView(r);
    };
  };
  box.querySelector('.x-analyze').onclick = async (ev) => {
    const p = inp.value.trim();
    if (!p) return inp.focus();
    ev.target.disabled = true;
    msg.className = 'x-msg';
    msg.innerHTML = `<i class="spin-sm"></i>${esc(T('expertAnalyzing'))}`;
    const r = await window.api.expertsAnalyze(p);
    ev.target.disabled = false;
    if (r.ok) {
      msg.textContent = '';
      showForm(r.draft);
    } else {
      msg.className = 'x-msg err';
      msg.textContent = r.error;
      // 分析不了也可以手动填
      if (!/找不到|not found|运行不了|cannot be run/i.test(r.error)) showForm({ path: p, name: p.split(/[\\/]/).pop(), argsLine: '', output: 'text' });
    }
  };
  if (editId) showForm(d);
  box.scrollIntoView({ block: 'nearest' });
}
$('expertAddBtn').onclick = () => openExpertAdd();
$('expertsRefresh').onclick = async (e) => {
  const b = e.currentTarget;
  if (b.disabled) return;
  b.disabled = true;
  b.classList.add('loading');
  const old = b.textContent;
  b.innerHTML = `<i class="spin-sm"></i>${esc(T('expertsDetecting'))}`;
  try {
    // 检测通常很快：转圈至少显示一小会儿，结束后提示结果，不然像没反应
    await Promise.all([refreshExpertsPane(true), new Promise((r) => setTimeout(r, 700))]);
    showToast(T('expertsDetected', { n: expertsAllR.filter((x) => x.found).length }), 'info');
  } finally {
    b.disabled = false;
    b.classList.remove('loading');
    b.textContent = old;
  }
};
$('expertDefault').onchange = async (e) => (settings = await window.api.saveSettings({ expertDefault: e.target.value }));
$('expertAuto').onchange = async (e) => (settings = await window.api.saveSettings({ expertAuto: e.target.checked }));
$('expertAllowEdits').onchange = async (e) => {
  if (e.target.checked && !confirm(T('expertEditsHint'))) return (e.target.checked = false);
  settings = await window.api.saveSettings({ expertAllowEdits: e.target.checked });
};

// 把保存的消息历史重新渲染出来
let toolDiffsOf = null; // 当前对话里改文件的逐行对比（callId -> {rows, add, del}），渲染历史时用
function renderMessages(messages, compact, toolDiffs) {
  toolDiffsOf = toolDiffs || null;
  setSuggestion('');
  hideLongBanner();
  clearLog();
  const calls = {};
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (compact?.upto === i) addCompactDivider();
    if (m.role === 'user' && m.expertAsk) addMsg('expert-ask', esc(T('expertAskMsg', { name: expertName(m.expertAsk) })));
    else if (m.role === 'user') addUserMsg(m.attachments ? userHtml(m.userText ?? '', m.attachments) + imgOnly(m.content) : userHtml(m.content), userPayload(m));
    else if (m.role === 'assistant') {
      if (m.content) addMsg('assistant' + (m.expert ? ' from-expert' : ''), (m.expert ? expertTag(expertName(m.expert) + (m.expertModel ? `（${m.expertModel}）` : '')) : '') + md(m.content));
      for (const c of m.tool_calls || []) {
        let args = {};
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {}
        calls[c.id] = { name: c.function.name, args };
        renderTool({ id: c.id, ...calls[c.id], status: 'running' });
      }
    } else if (m.role === 'tool') {
      const call = calls[m.tool_call_id] || { name: '?' };
      renderTool({ id: m.tool_call_id, ...call, status: 'done', result: m.content, diff: toolDiffsOf?.[m.tool_call_id] });
      // 生成的图片：从工具结果里取出保存路径（相对工作区），显示预览
      const voiced = call.name === 'text_to_speech' && /(?:已保存配音|Saved voice-over) (.+?)(?:（| \()/.exec(m.content || '');
      if (voiced && settings.workspace) showToolAudio(m.tool_call_id, settings.workspace.replace(/[\\/]+$/, '') + '/' + voiced[1]);
      const saved = call.name === 'generate_image' && /(?:已保存图片|Saved image) (.+?)(?:（| \()/.exec(m.content || '');
      if (saved && settings.workspace) showToolImage(m.tool_call_id, settings.workspace.replace(/[\\/]+$/, '') + '/' + saved[1]);
      if (call.name === 'generate_images' && settings.workspace) {
        for (const mm of String(m.content || '').matchAll(/^(?:已保存|Saved) (.+\.(?:png|jpe?g|webp))$/gim)) showToolImageGrid(m.tool_call_id, settings.workspace.replace(/[\\/]+$/, '') + '/' + mm[1]);
      }
    }
  }
  renderExpertBar();
}

// ---------- 侧边栏：历史对话 ----------
function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return T('justNow');
  if (d < 3600) return T('minAgo', { n: Math.floor(d / 60) });
  if (d < 86400) return T('hourAgo', { n: Math.floor(d / 3600) });
  return new Date(t).toLocaleDateString(lang() === 'en' ? 'en-US' : 'zh-CN');
}
// 侧边栏有两个视图：历史对话 / 已归档
let showArchived = false;
// 历史对话按时间分组
function convGroup(t) {
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (t >= d0.getTime()) return 'grpToday';
  if (t >= d0.getTime() - day) return 'grpYesterday';
  if (t >= d0.getTime() - 7 * day) return 'grpWeek';
  if (t >= d0.getTime() - 30 * day) return 'grpMonth';
  return 'grpOlder';
}
let convQuery = '';
// 侧边栏里就地改名：回车保存，Esc 取消
function startRename(el, c) {
  const t = el.querySelector('.t');
  const inp = document.createElement('input');
  inp.className = 'conv-rename';
  inp.value = c.title;
  t.replaceWith(inp);
  el.classList.add('editing');
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && inp.value.trim() && inp.value.trim() !== c.title) await window.api.renameConv(c.id, inp.value);
    refreshConvs();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.isComposing) finish(true);
    if (e.key === 'Escape') finish(false);
  };
  inp.onblur = () => finish(true);
  inp.onclick = (e) => e.stopPropagation();
}
const CONV_ICONS = {"archive":"<svg viewBox=\"0 0 24 24\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"5\" rx=\"1.5\"/><path d=\"M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4\"/></svg>","unarchive":"<svg viewBox=\"0 0 24 24\"><path d=\"M3 12a9 9 0 1 0 3-6.7L3 8\"/><path d=\"M3 3v5h5\"/></svg>","del":"<svg viewBox=\"0 0 24 24\"><path d=\"M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3\"/></svg>","rename":"<svg viewBox=\"0 0 24 24\"><path d=\"M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z\"/><path d=\"m13.5 6.5 4 4\"/></svg>"};
// 侧边栏的一条对话。flat：不分组时（搜索、已归档）标出文件夹
function convItem(c, { flat, needConfirm }) {
  const el = document.createElement('div');
  el.className = 'conv' + (c.id === currentConvId ? ' active' : '') + (selectMode ? ' selecting' : '') + (selectedConvs.has(c.id) ? ' selected' : '');
  el.dataset.id = c.id;
  const badge = needConfirm.has(c.id) && c.id !== currentConvId
    ? `<span class="conv-badge confirm" title="${esc(T('bgNeedConfirm'))}">${esc(T('bgNeedConfirm'))}</span>`
    : runningConvs.has(c.id)
      ? `<span class="conv-badge run" title="${esc(T('bgRunning'))}"></span>`
      : unreadConvs.has(c.id)
        ? `<span class="conv-badge unread" title="${esc(T('bgNewResult'))}"></span>`
        : '';
  const archBtn = showArchived
    ? `<button class="c-unarch" title="${esc(T('unarchive'))}">${CONV_ICONS.unarchive}</button>`
    : `<button class="c-arch" title="${esc(T('archive'))}">${CONV_ICONS.archive}</button>`;
  const where = flat ? `<span class="c-where">${esc(c.workspace ? baseName(c.workspace) : T('noFolder'))}</span>` : '';
  el.innerHTML = `<span class="conv-check"></span><div class="c-row"><div class="t">${badge}${esc(c.title)}</div><span class="c-time" title="${esc(new Date(c.updatedAt).toLocaleString())}">${esc(timeAgo(c.updatedAt))}</span></div>${where}<div class="conv-acts"><button class="c-ren" title="${esc(T('rename'))}">${CONV_ICONS.rename}</button>${archBtn}<button class="del" title="${esc(T('delete'))}">${CONV_ICONS.del}</button></div>`;
  el.onclick = (e) => {
    if (selectMode || e.metaKey || e.ctrlKey) return toggleSelect(c.id, e.shiftKey);
    openConv(c.id);
  };
  el.querySelector('.c-ren').onclick = (e) => {
    e.stopPropagation();
    startRename(el, c);
  };
  el.querySelector('.t').ondblclick = (e) => {
    e.stopPropagation();
    startRename(el, c);
  };
  el.querySelector('.c-arch, .c-unarch').onclick = async (e) => {
    e.stopPropagation();
    if (running && c.id === currentConvId) return showToast(T('waitTask'));
    const ok = await window.api.archiveConv(c.id, !showArchived);
    if (!ok) return;
    if (!showArchived && c.id === currentConvId) clearLog();
    if (showArchived && c.id === currentConvId) $('archNotice')?.remove();
    showToast(showArchived ? T('unarchivedToast') : T('archivedToast', { title: c.title }), 'info');
    refreshConvs();
  };
  el.querySelector('.del').onclick = async (e) => {
    e.stopPropagation();
    if (!confirm(T('deleteChatConfirm', { title: c.title }))) return;
    await window.api.deleteConv(c.id);
    if (c.id === currentConvId) clearLog();
    refreshConvs();
  };
  return el;
}
const FOLDER_ICONS = {
  arrow: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};
function folderCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('folderCollapsed') || '[]'));
  } catch {
    return new Set();
  }
}
function saveFolderCollapsed(set) {
  try {
    localStorage.setItem('folderCollapsed', JSON.stringify([...set].slice(-100)));
  } catch {}
}
/** 新对话：folder 为空 = 不关联文件夹（纯聊天） */
async function newChatIn(folder) {
  if (running) return showToast(T('waitTask'));
  settings = await window.api.setWorkspace(folder || '');
  currentConvId = null;
  setRunning(false);
  renderWorkspace();
  clearLog();
  refreshConvs();
  $('input').focus();
}
async function refreshConvs() {
  const { list, currentId, archivedCount, running: runIds = [], confirming = [] } = await window.api.listConvs(showArchived, convQuery);
  if (!expectRun) currentConvId = currentId;
  runningConvs.clear();
  runIds.forEach((id) => runningConvs.add(id));
  const needConfirm = new Set([...confirming, ...confirmQueue.keys()]);
  $('sideLabel').textContent = T(showArchived ? 'archived' : 'history');
  $('archBack').classList.toggle('hidden', !showArchived);
  const entry = $('archEntry');
  entry.classList.toggle('hidden', showArchived || !archivedCount);
  if (!showArchived) entry.textContent = T('archivedEntry', { n: archivedCount || 0 });
  const box = $('convList');
  box.innerHTML = list.length ? '' : `<div class="conv-empty">${esc(T(convQuery ? 'searchEmpty' : showArchived ? 'archivedEmpty' : 'noChats'))}</div>`;
  const shown = []; // 实际显示出来的（折叠的分组不算），Shift 多选按这个顺序
  const addItem = (c, flat) => {
    box.appendChild(convItem(c, { flat, needConfirm }));
    shown.push(c.id);
  };
  if (convQuery || showArchived) {
    // 搜索结果和已归档列表：不分组，标出文件夹
    for (const c of list) addItem(c, true);
  } else {
    // 按文件夹分组（最近用过的在前），「未关联文件夹」也是一组；每条对话右边显示时间
    const groups = new Map();
    for (const c of list) {
      const k = c.workspace || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const collapsed = folderCollapsed();
    for (const [k, items] of groups) {
      const fold = collapsed.has(k);
      const h = document.createElement('div');
      h.className = 'folder-group' + (fold ? ' folded' : '') + ((settings.workspace || '') === k && !currentConvId ? ' current' : '');
      h.title = k || T('noFolderTip');
      h.innerHTML = `<span class="fg-arrow">${FOLDER_ICONS.arrow}</span><span class="fg-ic">${k ? FOLDER_ICONS.folder : FOLDER_ICONS.chat}</span><span class="fg-name">${esc(k ? baseName(k) : T('noFolder'))}</span><span class="fg-count">${items.length}</span><button class="fg-new" type="button" title="${esc(T(k ? 'newChatInFolder' : 'newChat'))}">${FOLDER_ICONS.plus}</button>`;
      h.onclick = () => {
        const set = folderCollapsed();
        set.has(k) ? set.delete(k) : set.add(k);
        saveFolderCollapsed(set);
        refreshConvs();
      };
      h.querySelector('.fg-new').onclick = (e) => {
        e.stopPropagation();
        newChatIn(k);
      };
      box.appendChild(h);
      if (!fold) for (const c of items) addItem(c, false);
    }
  }
  visibleConvIds = shown;
  for (const id of [...selectedConvs]) if (!visibleConvIds.includes(id)) selectedConvs.delete(id);
  updateBatchBar();
}

// ---------- 批量选择：删除 / 归档 ----------
var selectMode = false;
var selectedConvs = new Set();
var visibleConvIds = [];
var lastPicked = null;
function setSelectMode(on) {
  selectMode = on;
  if (!on) selectedConvs.clear();
  lastPicked = null;
  refreshConvs();
}
function toggleSelect(id, range) {
  if (!selectMode) selectMode = true;
  if (range && lastPicked && visibleConvIds.includes(lastPicked)) {
    // Shift 点选：选中上次点的和这次之间的全部
    const a = visibleConvIds.indexOf(lastPicked);
    const b = visibleConvIds.indexOf(id);
    for (const x of visibleConvIds.slice(Math.min(a, b), Math.max(a, b) + 1)) selectedConvs.add(x);
  } else if (selectedConvs.has(id)) selectedConvs.delete(id);
  else selectedConvs.add(id);
  lastPicked = id;
  refreshConvs();
}
function updateBatchBar() {
  $('batchBar').classList.toggle('hidden', !selectMode);
  $('selectBtn').classList.toggle('hidden', selectMode);
  $('batchCount').textContent = T('batchCount', { n: selectedConvs.size });
  const all = visibleConvIds.length && visibleConvIds.every((id) => selectedConvs.has(id));
  $('batchAll').textContent = T(all ? 'selectNone' : 'selectAll');
  $('batchArch').textContent = T(showArchived ? 'unarchive' : 'archive');
  $('batchDel').disabled = $('batchArch').disabled = !selectedConvs.size;
}
$('selectBtn').onclick = () => setSelectMode(true);
$('batchCancel').onclick = () => setSelectMode(false);
$('batchAll').onclick = () => {
  const all = visibleConvIds.every((id) => selectedConvs.has(id));
  if (all) selectedConvs.clear();
  else visibleConvIds.forEach((id) => selectedConvs.add(id));
  refreshConvs();
};
async function batchApply(fn) {
  let done = 0;
  let skipped = 0;
  for (const id of [...selectedConvs]) {
    if (runningConvs.has(id)) {
      skipped++;
      continue;
    }
    if (await fn(id)) {
      done++;
      if (id === currentConvId) clearLog();
    } else skipped++;
  }
  return { done, skipped };
}
$('batchDel').onclick = async () => {
  const n = selectedConvs.size;
  if (!n || !confirm(T('batchDeleteConfirm', { n }))) return;
  const r = await batchApply((id) => window.api.deleteConv(id));
  showToast(T('batchDeleted', { n: r.done }) + (r.skipped ? T('batchSkipped', { n: r.skipped }) : ''), 'info');
  setSelectMode(false);
};
$('batchArch').onclick = async () => {
  if (!selectedConvs.size) return;
  const r = await batchApply((id) => window.api.archiveConv(id, !showArchived));
  showToast(T(showArchived ? 'batchUnarchived' : 'batchArchived', { n: r.done }) + (r.skipped ? T('batchSkipped', { n: r.skipped }) : ''), 'info');
  setSelectMode(false);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectMode && !document.querySelector('.modal:not(.hidden)')) setSelectMode(false);
});
{
  let t;
  $('convSearch').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      convQuery = e.target.value.trim();
      refreshConvs();
    }, 200);
  });
  $('convSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      convQuery = '';
      refreshConvs();
    }
  });
}
$('archEntry').onclick = () => {
  showArchived = true;
  refreshConvs();
};
$('archBack').onclick = () => {
  showArchived = false;
  refreshConvs();
};
async function openConv(id) {
  const c = await window.api.openConv(id);
  if (!c) return;
  currentConvId = c.id;
  unreadConvs.delete(c.id);
  if (c.workspaceMissing) {
    showToast(T('workspaceMissing'), 'info');
    c.workspace = settings.workspace;
  }
  settings.workspace = c.workspace || '';
  renderWorkspace();
  renderMessages(c.messages, c.compact, c.toolDiffs);
  window.api.convContext().then((ctx) => currentConvId === c.id && renderCtx(ctx));
  streamEl = null;
  thinkingEl = null;
  if (c.running) {
    runningConvs.add(c.id);
    if (c.partial) {
      streamText = c.partial;
      streamEl = document.createElement('div');
      streamEl.className = 'msg assistant';
      append(streamEl);
      renderStream(false);
    } else showThinking(T('thinking'));
  }
  setRunning(runningConvs.has(c.id));
  if (confirmQueue.has(c.id)) {
    showConfirm(confirmQueue.get(c.id));
    confirmQueue.delete(c.id);
  }
  if (c.archived) {
    const n = document.createElement('div');
    n.id = 'archNotice';
    n.className = 'arch-notice';
    n.textContent = T('archivedNotice');
    $('log').prepend(n);
  }
  refreshConvs();
}
$('newBtn').onclick = async () => {
  await window.api.newConv();
  settings.workspace = ''; // 新对话默认不关联文件夹（纯聊天）
  currentConvId = null;
  setRunning(false);
  renderWorkspace();
  clearLog();
  refreshConvs();
  $('input').focus();
};

// ---------- 顶栏：工作目录、模型 ----------
// 一个下拉框两组：平台模型（扣会员额度）+ 我的 Key（填了 Key 的厂商，不扣额度），选哪个用哪个
// 选着本机 AI 工具时：思考档位用不上，先藏起来；输入框提示写给谁发；「换个 AI 回答」里不列它自己
function applyModelMode() {
  const xp = !!settings?.chatExpert && expertsAvail.some((x) => x.id === settings.chatExpert);
  $('effortSel').nextElementSibling?.classList.toggle('hidden', xp);
  if (!suggestion) $('input').placeholder = inputPh();
  if (document.getElementById('expertBar')) renderExpertBar();
}
// 输入框的提示：选着本机 AI 工具时写「给 Claude Code 发消息…」
function inputPh() {
  const id = settings?.chatExpert;
  return id && expertsAvail.some((x) => x.id === id) ? T('inputPhExpert', { name: expertName(id) }) : T('inputPh');
}
function currentModelValue() {
  if (settings.chatExpert && expertsAvail.some((x) => x.id === settings.chatExpert)) return 'X::' + settings.chatExpert;
  if (settings.useOwnKey) {
    const cur = settings.selectedModels[settings.provider] || settings.allModels[settings.provider]?.[0]?.id;
    return 'O::' + settings.provider + '::' + cur;
  }
  return 'P::' + settings.platformModel;
}
function renderModelSel() {
  const sel = $('modelSel');
  sel.innerHTML = '';
  renderPlatformModels(sel);
  for (const [pid, p] of Object.entries(settings.providers)) {
    const models = settings.allModels[pid];
    if (!models.length || !settings.hasKey[pid]) continue;
    const g = document.createElement('optgroup');
    g.label = T('ownKeyGroup', { name: pName(p) });
    for (const m of models) {
      const o = document.createElement('option');
      o.value = 'O::' + pid + '::' + m.id;
      o.textContent = mLabel(m).replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  // 本机的 AI 工具（Claude Code、Codex…）：选中后消息直接交给它回答，用用户自己的账号，不扣额度
  if (expertsAvail.length) {
    const g = document.createElement('optgroup');
    g.label = T('localAiGroup');
    for (const x of expertsAvail) {
      const o = document.createElement('option');
      o.value = 'X::' + x.id;
      const h = expertHealth[x.id];
      o.textContent = x.name + (h && !h.ok ? ' · ' + T(h.notLoggedIn ? 'expertNeedsLogin' : 'expertUnavailable') : '');
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  sel.value = currentModelValue();
  if (!sel.value && sel.options.length) sel.selectedIndex = 0;
  applyModelMode();
  $('effortSel').value = settings.effort || 'standard';
}
function renderWorkspace() {
  const w = settings.workspace;
  $('wsName').textContent = w ? baseName(w) : T('noFolderBtn');
  $('wsBtn').classList.toggle('ws-none', !w);
  $('wsBtn').title = w && w === settings.defaultWorkspace ? T('defaultWsTitle', { path: w }) : w || T('noFolderBtnTip');
}
enhanceSelect($('modelSel'), { className: 'pick-model' });
enhanceSelect($('effortSel'), { className: 'pick-effort' });
// 思考档位：快速 / 标准 / 深入（所有对话共用；深入会多用一些额度）
$('effortSel').onchange = async (e) => {
  settings = await window.api.saveSettings({ effort: e.target.value });
  if (e.target.value === 'deep') showToast(T('effortDeepHint'), 'info');
};
enhanceSelect($('approvalSel'), { up: true, className: 'pick-perm' });
for (const id of ['approvalSel2', 'fontFamily', 'language', 'sfType', 'fbType', 'expertDefault', 'remoteBrowseScope']) enhanceSelect($(id), { className: 'pick-field' });
$('modelSel').onchange = async (e) => {
  if (e.target.value.startsWith('X::')) {
    const id = e.target.value.slice(3);
    settings = await window.api.saveSettings({ chatExpert: id });
    applyModelMode();
    showToast(T('chatExpertPicked', { name: expertName(id) }), 'info');
    checkChatExpert(id, false);
    return;
  }
  if (e.target.value.startsWith('P::')) {
    const m = settings.platformModels.find((x) => x.value === e.target.value.slice(3));
    if (m && m.minPlanLevel > userLevel()) {
      sel_revert();
      return openPlans('plan_required', m.minPlanLevel);
    }
    settings = await window.api.saveSettings({ platformModel: e.target.value.slice(3), useOwnKey: false, chatExpert: '' });
    applyModelMode();
    renderQuota();
    return;
  }
  const [, provider, model] = e.target.value.split('::');
  settings = await window.api.saveSettings({ useOwnKey: true, provider, models: { [provider]: model }, chatExpert: '' });
  applyModelMode();
  renderQuota();
};
// 切到「全部自动执行」先确认风险；取消就退回原来的选项
function confirmApprovalAll(sel, prev) {
  if (sel.value !== 'all' || prev === 'all') return true;
  if (confirm(T('approvalAllConfirm'))) return true;
  sel.value = prev;
  return false;
}
function markApproval() {
  document.querySelector('.composer .perm')?.classList.toggle('perm-all', $('approvalSel').value === 'all');
}
$('approvalSel').onchange = async (e) => {
  if (!confirmApprovalAll(e.target, settings.approval)) return;
  settings = await window.api.saveSettings({ approval: e.target.value });
  markApproval();
};
$('approvalSel2').addEventListener('change', (e) => confirmApprovalAll(e.target, settings.approval));
$('wsBtn').onclick = async () => {
  if (running) return;
  const r = await window.api.chooseWorkspace();
  if (!r) return;
  settings.workspace = r.path;
  renderWorkspace();
  if (r.attached) {
    // 正在聊的对话直接关联上这个文件夹，接着聊
    showToast(T('folderAttached', { name: baseName(r.path) }), 'info');
  } else {
    currentConvId = null;
    clearLog();
  }
  refreshConvs();
};

// ---------- 发送 ----------
// ---------- 下一句建议：输入框为空时显示成灰字，按 Tab 填入 ----------
let suggestion = '';
function setSuggestion(text) {
  suggestion = text || '';
  const inp = $('input');
  inp.placeholder = suggestion || inputPh();
  inp.classList.toggle('has-suggest', !!suggestion);
  $('suggestHint').classList.toggle('hidden', !suggestion || !!inp.value);
}
$('input').addEventListener('input', () => $('suggestHint').classList.toggle('hidden', !suggestion || !!$('input').value));

// ---------- 图片上标注「AI生成」：关闭前说明责任，确认后立即保存 ----------
$('imageWatermark').onchange = async (e) => {
  if (!e.target.checked && !confirm(T('imageWatermarkOffConfirm'))) {
    e.target.checked = true;
    return;
  }
  settings = await window.api.saveSettings({ imageWatermark: e.target.checked });
};

// ---------- 左侧会话栏：一键隐藏 / 展开（Ctrl/⌘ + B），记住上次的状态 ----------
function setSideCollapsed(v) {
  document.body.classList.toggle('side-collapsed', v);
  $('sideToggle').title = T(v ? 'sideShow' : 'sideHide') + (navigator.platform.startsWith('Mac') ? '（⌘B）' : '（Ctrl+B）');
  try {
    localStorage.setItem('sideCollapsed', v ? '1' : '');
  } catch {}
}
try {
  setSideCollapsed(localStorage.getItem('sideCollapsed') === '1');
} catch {
  setSideCollapsed(false);
}
$('sideToggle').onclick = () => setSideCollapsed(!document.body.classList.contains('side-collapsed'));
$('sideNew').onclick = () => $('newBtn').click();
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    $('sideToggle').click();
  }
});

// ---------- 上下文用量：输入框旁的小圆圈，点开看明细、手动整理 ----------
let ctxNow = null;
const fmtK = (n) => (n >= 10000 ? (n / 1000).toFixed(0) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
function ctxPct(ctx) {
  return Math.min(100, Math.round((ctx.used / ctx.limit) * 100));
}
function renderCtx(ctx) {
  ctxNow = ctx && ctx.limit ? ctx : null;
  const el = $('ctxRing');
  if (!ctxNow) {
    el.classList.add('hidden');
    $('ctxPop').classList.add('hidden');
    return;
  }
  const pct = ctxPct(ctxNow);
  el.classList.remove('hidden');
  el.classList.toggle('warn', pct >= 60 && pct < 80);
  el.classList.toggle('hot', pct >= 80);
  const C = 2 * Math.PI * 7.5;
  el.querySelector('.fg').style.strokeDasharray = `${((C * Math.max(pct, 2)) / 100).toFixed(1)} ${C.toFixed(1)}`;
  el.querySelector('.ctx-pct').textContent = pct + '%';
  el.title = T('ctxTitle', { pct });
  if (!$('ctxPop').classList.contains('hidden')) fillCtxPop();
}
function fillCtxPop() {
  const c = ctxNow;
  const pop = $('ctxPop');
  if (!c) return pop.classList.add('hidden');
  const pct = ctxPct(c);
  const rows = [
    ['messages', T('ctxMessages'), c.messages],
    ['tools', T('ctxTools'), c.tools],
    ['system', T('ctxSystem'), c.system],
  ];
  const bar = rows.map(([k, , v]) => `<i class="seg ${k}" style="width:${Math.min(100, (v / c.limit) * 100).toFixed(2)}%"></i>`).join('');
  pop.innerHTML = `<div class="cp-head"><b>${esc(T('ctxHead'))}</b><span>${c.estimated ? '≈' : ''}${fmtK(c.used)} / ${fmtK(c.limit)}</span></div>
    <div class="cp-pct">${esc(T('ctxUsedPct', { pct }))}</div>
    <div class="cp-bar">${bar}</div>
    ${rows.map(([k, label, v]) => `<div class="cp-row"><i class="dot ${k}"></i><span>${esc(label)}</span><span class="v">${fmtK(v)}</span><span class="p">${((v / c.limit) * 100).toFixed(1)}%</span></div>`).join('')}
    <div class="cp-row free"><i class="dot"></i><span>${esc(T('ctxFree'))}</span><span class="v">${fmtK(Math.max(0, c.limit - c.used))}</span><span class="p">${(100 - Math.min(100, (c.used / c.limit) * 100)).toFixed(1)}%</span></div>
    <div class="cp-note">${esc(T('ctxNote'))}${c.compacts ? ' ' + esc(T('ctxCompacts', { n: c.compacts })) : ''}</div>
    <button class="primary small cp-btn" type="button" ${running ? 'disabled' : ''}>${esc(T(running ? 'ctxBusy' : 'ctxCompactNow'))}</button>`;
  pop.querySelector('.cp-btn').onclick = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = T('ctxCompacting');
    const r = await window.api.compactConv();
    if (r?.ok) {
      showToast(T('ctxCompactOk'), 'info');
      pop.classList.add('hidden');
    } else {
      showToast(T(r?.reason === 'short' ? 'ctxShort' : r?.reason === 'busy' ? 'ctxBusy' : 'ctxCompactFail'));
      b.disabled = false;
      b.textContent = T('ctxCompactNow');
    }
  };
}
$('ctxRing').onclick = (e) => {
  e.stopPropagation();
  const pop = $('ctxPop');
  if (!pop.classList.contains('hidden')) return pop.classList.add('hidden');
  fillCtxPop();
  pop.classList.remove('hidden');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxPop') && !e.target.closest('#ctxRing')) $('ctxPop').classList.add('hidden');
});
function addCompactDivider() {
  const d = document.createElement('div');
  d.className = 'compact-divider';
  d.innerHTML = `<span>${esc(T('compactedDivider'))}</span>`;
  append(d);
}

// ---------- 长对话提示：单次请求带的历史超过约 4 万 token 时，建议总结后新开 ----------
const LONG_CONV_TOKENS = 40000;
const longDismissed = new Set();
function hideLongBanner() {
  $('longBanner').classList.add('hidden');
}
function showLongBanner(promptTokens) {
  if (longDismissed.has(currentConvId)) return;
  const el = $('longBanner');
  const zh = lang() !== 'en';
  const n = zh ? (promptTokens / 10000).toFixed(1) : Math.round(promptTokens / 1000);
  el.innerHTML = `<span class="lb-text">${esc(T('longConv', { n }))}</span><div class="spacer"></div>
    <button class="primary small lb-sum">${esc(T('longConvSummary'))}</button><button class="ghost small lb-new">${esc(T('longConvNew'))}</button><button class="ghost small lb-x" title="${esc(T('close'))}">×</button>`;
  el.classList.remove('hidden');
  el.querySelector('.lb-x').onclick = () => {
    longDismissed.add(currentConvId);
    hideLongBanner();
  };
  el.querySelector('.lb-new').onclick = () => $('newBtn').click();
  el.querySelector('.lb-sum').onclick = async (e) => {
    if (running) return;
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = T('longConvBusy');
    const summary = await window.api.summarizeConv();
    if (!summary) {
      b.disabled = false;
      b.textContent = T('longConvSummary');
      return showToast(T('longConvFail'));
    }
    await window.api.newConv();
    clearLog();
    refreshConvs();
    const inp = $('input');
    inp.value = T('continueFrom', { summary });
    inp.dispatchEvent(new Event('input'));
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  };
}

async function submit() {
  if (running) {
    window.api.stop(currentConvId);
    return;
  }
  const text = $('input').value.trim();
  if (!text && !pendingImages.length && !pendingFiles.length) return;
  setSuggestion('');
  // 当前平台模型看不懂图片：直接提示，图片留在输入框里，换个模型再发
  if (pendingImages.length && !settings.useOwnKey) {
    const m = (settings.platformModels || []).find((x) => x.value === settings.platformModel);
    if (m && !m.supportsVision) {
      showToast(T('err_model_no_vision'));
      return;
    }
  }
  if (text && looksSecret(text) && !(await confirmSendSecret())) return;
  const images = pendingImages.map((i) => i.url);
  const files = pendingFiles.slice();
  $('input').value = '';
  autosizeInput();
  pendingImages = [];
  pendingFiles = [];
  renderAttachments();
  addUserMsg(userHtml(images.length ? [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : text, files), { text, images, files });
  setRunning(true);
  expectRun = !currentConvId;
  if (currentConvId) runningConvs.add(currentConvId);
  const started = await window.api.send(images.length || files.length ? { text, images, files: files.map((f) => f.path) } : text);
  if (started === false || (started && started.ok === false)) {
    expectRun = false;
    if (currentConvId) runningConvs.delete(currentConvId);
    setRunning(false);
    if (started && started.message) showToast(started.message);
    return;
  }
  // 跑得久的任务提示一下：可以去做别的（最多提示 3 次）
  clearTimeout(bgHintTimer);
  bgHintTimer = setTimeout(() => {
    let n = 0;
    try {
      n = Number(localStorage.getItem('bgHintShown') || 0);
    } catch {}
    if (!running || n >= 3) return;
    showToast(T('bgHint'), 'info');
    try {
      localStorage.setItem('bgHintShown', String(n + 1));
    } catch {}
  }, 20000);
}

// ---------- 图片附件：点 📎 选择、粘贴、拖进输入区 ----------
let pendingImages = [];
const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
// 缩小到最长边 1600、转 JPEG，省流量也省额度
function downscale(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}
async function addImageFiles(files) {
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    if (pendingImages.length >= MAX_IMAGES) {
      showToast(T('imageLimit'));
      break;
    }
    try {
      pendingImages.push({ url: await downscale(f) });
    } catch {
      showToast(T('imageReadFail'));
    }
  }
  renderAttachments();
}
function imgOnly(content) {
  if (!Array.isArray(content)) return '';
  return userHtml(content.filter((p) => p.type === 'image_url'));
}
let pendingFiles = [];
async function addAnyFiles(files) {
  const imgs = files.filter((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
  if (imgs.length) await addImageFiles(imgs);
  const others = files.filter((f) => !imgs.includes(f));
  if (!others.length) return;
  const paths = [];
  for (const f of others) {
    const p = window.api.filePath(f);
    if (p) paths.push(p);
    else showToast(T('fileNoPath', { name: f.name }));
  }
  if (!paths.length) return;
  for (const info of await window.api.attachInfo(paths)) {
    if (info.error) {
      showToast(T({ folder: 'fileFolder', unsupported: 'fileUnsupported', too_large: 'fileTooLarge' }[info.error] || 'fileMissing', { name: info.name }));
      continue;
    }
    if (pendingFiles.some((x) => x.path === info.path)) continue;
    if (pendingFiles.length >= 10) {
      showToast(T('fileLimit'));
      break;
    }
    pendingFiles.push(info);
  }
  renderAttachments();
}
function renderAttachments() {
  const box = $('attachStrip');
  box.classList.toggle('hidden', !pendingImages.length && !pendingFiles.length);
  box.innerHTML = (pendingImages.length ? `<span class="attach-count">${esc(T('attachCount', { n: pendingImages.length }))}</span>` : '') + fileChips(pendingFiles, true);
  box.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    pendingFiles.splice(Number(b.dataset.rm), 1);
    renderAttachments();
  }));
  pendingImages.forEach((img, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${esc(img.url)}" alt=""><button title="${esc(T('removeImage'))}">×</button>`;
    d.querySelector('button').onclick = () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    };
    box.appendChild(d);
  });
}
// 浮在最上层的短提示（弹窗打开时也看得到）。kind: error / ok
function showToast(text, kind = 'error') {
  let box = $('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const d = document.createElement('div');
  d.className = 'toast ' + kind;
  d.textContent = text;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  await addAnyFiles([...e.target.files]);
  e.target.value = '';
};
$('input').addEventListener('paste', (e) => {
  // 截图等图片直接加；从访达复制的文件也能粘贴
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addAnyFiles(files);
});
{
  const comp = document.querySelector('.composer');
  comp.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) {
      e.preventDefault();
      comp.classList.add('drag');
    }
  });
  comp.addEventListener('dragleave', () => comp.classList.remove('drag'));
  comp.addEventListener('drop', (e) => {
    comp.classList.remove('drag');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    addAnyFiles(files);
  });
}
// 防止把图片拖到窗口别处时 Electron 直接打开它
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
$('sendBtn').onclick = submit;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && suggestion && !$('input').value && !e.isComposing) {
    e.preventDefault();
    $('input').value = suggestion;
    setSuggestion('');
    $('input').dispatchEvent(new Event('input')); // 让输入框按内容撑高
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

function showThinking(text) {
  if (!thinkingEl) {
    thinkingEl = document.createElement('div');
    thinkingEl.className = 'thinking';
    $('log').appendChild(thinkingEl);
  }
  thinkingEl.textContent = text;
  $('log').scrollTop = $('log').scrollHeight;
}
function hideThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
}

// 流式输出：文字一块块到达，合并到下一帧再渲染，避免频繁重绘
let streamEl = null;
let streamText = '';
let streamExpert = ''; // 正在显示的是外援（Claude Code / Codex）的回答
let renderQueued = false;
function renderStream(final) {
  renderQueued = false;
  if (!streamEl) return;
  const log = $('log');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  streamEl.innerHTML = (streamExpert ? expertTag(streamExpert) : '') + md(streamText) + (final ? '' : '<span class="cursor"></span>');
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

// ---------- 后台运行：多个对话可以同时跑，界面只显示当前对话的输出 ----------
const CONV_EVENTS = new Set(['context', 'compacted', 'notice', 'expert-start', 'thinking', 'status', 'assistant-start', 'assistant-delta', 'assistant-end', 'tool', 'image', 'audio', 'confirm', 'confirm-timeout', 'usage', 'error', 'platform-error', 'done', 'suggestion']);
const runningConvs = new Set(); // 正在运行的对话
const unreadConvs = new Set(); // 在后台跑完、用户还没看的对话
const confirmQueue = new Map(); // convId -> 等用户确认的事件（后台对话的确认，打开对话时再弹）
let expectRun = false; // 刚从「新对话」发出消息，等主进程告诉我们新对话的 id
let bgHintTimer = null;
function backgroundEvent(evt) {
  if (evt.type === 'confirm') confirmQueue.set(evt.convId, evt);
  else if (evt.type === 'confirm-timeout') confirmQueue.delete(evt.convId);
  else if (evt.type === 'done') {
    confirmQueue.delete(evt.convId);
    if (!evt.stopped) unreadConvs.add(evt.convId);
  } else return;
  refreshConvs();
}
window.api.onEvent((evt) => {
  if (evt.type === 'convs-changed' && evt.runId) {
    runningConvs.add(evt.runId);
    // 从新对话发出的消息：主进程新建的对话就是当前对话
    if (expectRun && evt.currentId === evt.runId) {
      currentConvId = evt.runId;
      expectRun = false;
    }
  }
  if (evt.convId && CONV_EVENTS.has(evt.type)) {
    if (evt.type === 'done') runningConvs.delete(evt.convId);
    if (evt.convId !== currentConvId) return backgroundEvent(evt);
  }
  switch (evt.type) {
    case 'context':
      renderCtx(evt.ctx);
      break;
    case 'compacted':
      addCompactDivider();
      renderCtx(evt.ctx);
      break;
    case 'notice': {
      // 一行灰色的小提示（比如这次换成了备用模型）
      const n = document.createElement('div');
      n.className = 'notice-line';
      n.textContent = evt.text;
      append(n);
      break;
    }
    case 'ui-font':
      useUiFont(evt.url);
      break;
    case 'catalog-changed':
      // 后台改了模型：重新拿模型列表，下拉框跟着更新
      window.api.getSettings().then((s) => {
        settings = s;
        renderModelSel();
        renderQuota();
      });
      break;
    case 'thinking':
      showThinking(T('thinking'));
      break;
    case 'status':
      if (!streamEl) showThinking(evt.text);
      break;
    case 'expert-start':
      hideExpertBar();
      if (!evt.direct) addMsg('expert-ask', esc(T('expertAskMsg', { name: evt.name })));
      setRunning(true);
      showThinking(T('expertWorking', { name: evt.name }));
      break;
    case 'assistant-start':
      hideThinking();
      hideExpertBar();
      streamText = '';
      streamExpert = evt.expert || '';
      streamEl = document.createElement('div');
      streamEl.className = 'msg assistant' + (streamExpert ? ' from-expert' : '');
      append(streamEl);
      break;
    case 'assistant-delta':
      streamText += evt.text;
      if (!renderQueued) {
        renderQueued = true;
        requestAnimationFrame(() => renderStream(false));
      }
      break;
    case 'assistant-end':
      renderStream(true);
      streamEl = null;
      break;
    case 'tool':
      renderTool(evt);
      break;
    case 'image':
      if (evt.multi) showToolImageGrid(evt.callId, evt.path);
      else showToolImage(evt.callId, evt.path);
      break;
    case 'audio':
      showToolAudio(evt.callId, evt.path);
      break;
    case 'confirm':
      showConfirm(evt);
      break;
    case 'screenshot':
      addImageDataUrl(evt.dataUrl);
      $('input').focus();
      break;
    case 'screenshot-denied':
      showScreenPermission();
      break;
    case 'image-copied':
      showToast(T(evt.ok ? 'imgCopied' : 'imgCopyFail'), evt.ok ? 'ok' : 'error');
      break;
    case 'confirm-timeout':
      if (confirmingId === evt.id) {
        $('confirmModal').classList.add('hidden');
        showToast(T('confirmTimedOut'), 'info');
      }
      break;
    case 'open-conv':
      $('settingsModal').classList.add('hidden');
      openConv(evt.id);
      break;
    case 'schedules-changed':
      if (!$('settingsModal').classList.contains('hidden')) loadSchedules();
      break;
    case 'quota':
      if (quota) {
        quota.remaining = evt.quota.remaining;
        renderQuota();
      }
      clearTimeout(quotaTimer);
      quotaTimer = setTimeout(refreshQuota, 1500);
      break;
    case 'skill-progress':
      if ($('skillMsg') && !$('skillModal').classList.contains('hidden')) $('skillMsg').textContent = T('skillProgress', { done: evt.done, total: evt.total });
      break;
    case 'secret-request':
      showSecretRequest(evt);
      break;
    case 'runtime-install':
      onRuntimeInstall(evt);
      break;
    case 'mcp-status':
      mcpStatus = evt.status;
      renderConnectors();
      renderMcpList();
      renderMcpBanners();
      break;
    case 'update-ready':
      showPatchBanner(evt);
      break;
    case 'platform-error':
      showPlatformError(evt);
      break;
    case 'usage':
      $('usage').textContent = T('tokens', { n: evt.taskTokens ? fmtNum(evt.taskTokens) : '-', calls: evt.taskCalls || 1 });
      break;
    case 'auth-expired':
      currentUser = null;
      $('settingsModal').classList.add('hidden');
      showAuth('login');
      $('loginError').textContent = T('sessionExpired');
      break;
    case 'convs-changed':
      refreshConvs();
      break;
    case 'conv-synced':
      // 别的设备改了 / 删了对话：刷新列表；当前打开的对话被更新就重新打开
      refreshConvs();
      if (currentConvId && evt.ids.includes(currentConvId) && !runningConvs.has(currentConvId)) {
        window.api.listConvs(false, '').then(({ list }) => (list.some((c) => c.id === currentConvId) ? openConv(currentConvId) : clearLog()));
      }
      break;
    case 'remote-status':
      renderRemoteChip(evt.status);
      if (!$('settingsModal').classList.contains('hidden')) refreshRemote();
      break;
    case 'confirm-answered':
      // 在手机上点了允许 / 拒绝：电脑上的确认框关掉
      confirmQueue.delete(evt.convId);
      if (confirmingId === evt.id) {
        $('confirmModal').classList.add('hidden');
        showToast(T(evt.ok ? 'remoteConfirmedYes' : 'remoteConfirmedNo'), 'info');
      }
      refreshConvs();
      break;
    case 'conv-sync-status':
      renderSyncStatus(evt.status);
      break;
    case 'browser-show':
      openBrowserPane();
      break;
    case 'browser-hide':
      // 切到了没开过浏览器的对话：只收起面板（主进程那边已经藏好了页面）
      if (browserOpen) closeBrowserPane(true);
      break;
    case 'browser-state':
      renderBrowserState(evt);
      break;
    case 'browser-busy':
      $('bpBusy').classList.toggle('hidden', !evt.on);
      $('browserPane').classList.toggle('ai-busy', !!evt.on);
      break;
    case 'suggestion':
      if (!running) setSuggestion(evt.text);
      break;
    case 'error':
      addMsg('error', esc(evt.text));
      break;
    case 'done':
      if (streamEl) {
        renderStream(true);
        streamEl = null;
      }
      setRunning(false);
      refreshConvs();
      renderExpertBar();
      break;
  }
});

// ---------- 确认弹窗 ----------
let confirmingId = null;
function showConfirm(evt) {
  confirmingId = evt.id;
  $('confirmTitle').textContent = evt.title;
  const body = $('confirmBody');
  body.classList.toggle('diff', !evt.detail);
  if (evt.detail) {
    // 团队操作（开会员、设客服等）：说明 + 可选项（客服类型、有效期）
    body.innerHTML = `<div class="confirm-detail">${esc(evt.detail)}</div>` + (evt.choices || []).map((c) =>
      `<label class="confirm-choice"><span>${esc(c.label)}</span><select data-key="${esc(c.key)}">${c.options.map((o) =>
        `<option value="${esc(String(o.value))}"${String(o.value) === String(c.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`).join('');
  } else if (evt.command) {
    body.innerHTML = `<div class="cmd">${evt.tool === 'run_command' ? '$ ' : ''}${esc(evt.command)}</div>`;
  } else {
    body.innerHTML = diffHtml(evt.diff);
  }
  $('confirmYes').textContent = evt.yes || T('allow');
  $('confirmNo').textContent = evt.detail ? T('cancel') : T('reject');
  $('confirmModal').classList.remove('hidden');
  const done = (ok) => {
    $('confirmModal').classList.add('hidden');
    const values = {};
    body.querySelectorAll('select[data-key]').forEach((sel) => {
      const c = (evt.choices || []).find((x) => x.key === sel.dataset.key);
      const opt = c?.options.find((o) => String(o.value) === sel.value);
      values[sel.dataset.key] = opt ? opt.value : sel.value;
    });
    window.api.confirmReply(evt.id, ok, values);
  };
  $('confirmYes').onclick = () => done(true);
  $('confirmNo').onclick = () => done(false);
}

// ---------- 内置浏览器面板 ----------
// 网页是主进程的原生视图，叠在 #browserView 上；这里负责把占位区域的位置同步过去，
// 并在弹窗打开时让浏览器暂时让开（原生视图总在最上层，会挡住弹窗）。
let browserOpen = false;
function syncBrowserBounds() {
  if (!browserOpen) return;
  const r = $('browserView').getBoundingClientRect();
  window.api.browserBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}
function openBrowserPane() {
  if (browserOpen) return syncBrowserBounds();
  browserOpen = true;
  $('browserPane').classList.remove('hidden');
  $('browserBtn').classList.add('on');
  requestAnimationFrame(() => {
    syncBrowserBounds();
    window.api.browserShow();
  });
}
function closeBrowserPane(fromMain) {
  browserOpen = false;
  $('browserPane').classList.add('hidden');
  $('browserBtn').classList.remove('on');
  if (fromMain !== true) window.api.browserHide();
}
function renderBrowserState(s) {
  if (document.activeElement !== $('bpUrl')) $('bpUrl').value = s.url && s.url !== 'about:blank' ? s.url : '';
  $('bpBack').disabled = !s.canBack;
  $('bpFwd').disabled = !s.canForward;
  $('bpLoading').classList.toggle('hidden', !s.loading);
}
$('browserBtn').onclick = () => (browserOpen ? closeBrowserPane() : openBrowserPane());
$('bpClose').onclick = () => closeBrowserPane();
$('bpBack').onclick = () => window.api.browserBack();
$('bpFwd').onclick = () => window.api.browserForward();
$('bpReload').onclick = () => window.api.browserReload();
$('bpForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('bpUrl').value.trim();
  if (v) window.api.browserNavigate(v);
  $('bpUrl').blur();
};
new ResizeObserver(syncBrowserBounds).observe($('browserView'));
window.addEventListener('resize', syncBrowserBounds);
// 任何弹窗打开时暂时隐藏网页
{
  const anyModal = () => [...document.querySelectorAll('.modal')].some((m) => !m.classList.contains('hidden')) || !$('authScreen').classList.contains('hidden');
  let last = false;
  const check = () => {
    const s = anyModal();
    if (s === last) return;
    last = s;
    $('bpPaused').classList.toggle('hidden', !s);
    window.api.browserSuspend(s);
  };
  const mo = new MutationObserver(check);
  document.querySelectorAll('.modal, #authScreen').forEach((m) => mo.observe(m, { attributes: true, attributeFilter: ['class'] }));
}
// 拖动左边缘调整宽度
{
  const pane = $('browserPane');
  let startX = 0;
  let startW = 0;
  const move = (e) => {
    const w = Math.min(Math.max(startW + (startX - e.clientX), 360), window.innerWidth - 560);
    pane.style.width = w + 'px';
    syncBrowserBounds();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing');
    window.api.browserSuspend(false);
    try {
      localStorage.setItem('browserPaneWidth', pane.style.width);
    } catch {}
  };
  $('bpResize').addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = pane.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    window.api.browserSuspend(true); // 拖动时网页会吃掉鼠标事件，先隐藏
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  try {
    const w = localStorage.getItem('browserPaneWidth');
    if (w) pane.style.width = w;
  } catch {}
}

// ---------- 设置弹窗 ----------
const SAVE_TABS = ['models', 'behavior', 'safety'];
function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-body section').forEach((sec) => sec.classList.toggle('hidden', sec.dataset.pane !== name));
  // 「保存 / 取消」只在要点保存才生效的页面显示；其他页面改了立即生效，右上角关闭即可
  $('settingsFoot').classList.toggle('hidden', !SAVE_TABS.includes(name));
  if (name === 'data') refreshDataInfo();
  if (name === 'remote') refreshRemote();
  if (name === 'experts') refreshExpertsPane();
  if (name === 'mcp') loadMcp();
  if (name === 'account') loadAccount();
  if (name === 'team') loadTeam();
  if (name === 'usage') loadUsage();
  if (name === 'feedback') loadFeedback();
  if (name === 'about') loadAbout();
  if (name === 'schedules') loadSchedules();
}
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
// ---------- 手机远程控制 ----------
function renderRemoteChip(st) {
  const active = (st?.active || []).length;
  $('remoteChip').classList.toggle('hidden', !active);
  $('remoteChip').title = active ? T('remoteChipTip', { names: st.active.filter(Boolean).join('、') || '-' }) : '';
}
$('remoteChip').onclick = () => openSettings('remote');
async function refreshRemote() {
  const st = await window.api.remoteStatus();
  const on = !!settings.remoteEnabled;
  $('remoteEnabled').checked = on;
  $('remoteKeepAwake').checked = settings.remoteKeepAwake !== false;
  $('remoteBrowseScope').value = settings.remoteBrowseScope || 'common';
  $('remoteMore').classList.toggle('hidden', !on);
  const info = $('remoteInfo');
  info.classList.toggle('err', !!(on && st.error));
  info.textContent = !on ? T('remoteOff') : st.error ? T('remoteErr', { err: st.error }) : st.online ? (st.active.length ? T('remoteActive', { names: st.active.filter(Boolean).join('、') || '-' }) : T('remoteOnline')) : T('remoteConnecting');
  renderRemoteChip(st);
  if (!on) return;
  $('remoteUrl').textContent = st.url;
  if (document.activeElement !== $('remoteName')) $('remoteName').value = settings.remoteName || '';
  $('remoteName').placeholder = st.defaultName || '';
  $('remoteQr').src = await window.api.remoteQr();
  const box = $('remoteTrustedList');
  box.innerHTML = st.trusted.length ? '' : `<div class="hint">${esc(T('remoteNoTrusted'))}</div>`;
  for (const t of st.trusted.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'data-row';
    row.innerHTML = `<div><b>${esc(t.name || T('remotePhone'))}</b><div class="hint">${esc(T('remoteTrustedAt', { time: new Date(t.at).toLocaleString(), ip: t.ip || '-' }))}</div></div><button class="ghost danger small" type="button">${esc(T('remoteRevoke'))}</button>`;
    row.querySelector('button').onclick = async () => {
      if (!confirm(T('remoteRevokeConfirm', { name: t.name || T('remotePhone') }))) return;
      await window.api.remoteUntrust(t.sid);
      settings = await window.api.getSettings();
      refreshRemote();
    };
    box.appendChild(row);
  }
}
$('remoteEnabled').onchange = async (e) => {
  const on = e.target.checked;
  if (on && !confirm(T('remoteEnableConfirm'))) {
    e.target.checked = false;
    return;
  }
  settings = await window.api.saveSettings({ remoteEnabled: on });
  setTimeout(refreshRemote, 800);
};
$('remoteBrowseScope').onchange = async (e) => (settings = await window.api.saveSettings({ remoteBrowseScope: e.target.value }));
$('remoteKeepAwake').onchange = async (e) => {
  settings = await window.api.saveSettings({ remoteKeepAwake: e.target.checked });
};
$('remoteName').onchange = async (e) => {
  settings = await window.api.saveSettings({ remoteName: e.target.value.trim().slice(0, 40) });
  showToast(T('remoteNameSaved'), 'info');
};
$('remoteCopy').onclick = () => {
  navigator.clipboard.writeText($('remoteUrl').textContent);
  showToast(T('copied'), 'ok');
};
window.api.remoteStatus().then(renderRemoteChip).catch(() => {});
function renderSyncStatus(st) {
  const box = $('convSyncInfo');
  if (!box) return;
  const on = !!settings.convSync;
  $('convSync').checked = on;
  $('convSyncNow').classList.toggle('hidden', !on);
  $('convSyncNow').disabled = !!st?.busy;
  box.classList.toggle('err', !!(on && st?.error));
  if (!on) return (box.textContent = T('convSyncOff'));
  if (st?.busy) return (box.textContent = T('convSyncBusy'));
  if (st?.error === 'conv_limit') return (box.textContent = T('convSyncLimit', { n: st.limit || 2000 }));
  if (st?.error) return (box.textContent = T('convSyncFail', { err: st.error }));
  if (!st?.lastSync) return (box.textContent = T('convSyncNever'));
  const d = new Date(st.lastSync);
  const time = d.toDateString() === new Date().toDateString() ? d.toTimeString().slice(0, 5) : d.toLocaleString();
  box.textContent = T('convSyncOk', { time, n: st.count || 0 });
}
$('convSync').onchange = async (e) => {
  const on = e.target.checked;
  if (!confirm(T(on ? 'convSyncOnConfirm' : 'convSyncOffConfirm'))) {
    e.target.checked = !on;
    return;
  }
  settings = await window.api.saveSettings({ convSync: on });
  renderSyncStatus(await window.api.convSyncStatus());
};
$('convSyncNow').onclick = async () => {
  renderSyncStatus({ busy: true });
  renderSyncStatus(await window.api.convSyncNow());
  refreshConvs();
};
async function refreshDataInfo() {
  window.api.convSyncStatus().then(renderSyncStatus);
  const d = await window.api.dataInfo();
  $('backupInfo').textContent = T('backupInfo', { count: d.backups.count, size: fmtSize(d.backups.size) });
  $('convInfo').textContent = T('chatInfo', { count: d.convs.count, size: fmtSize(d.convs.size) });
  $('dataDirInfo').textContent = d.dataDir;
  $('versionInfo').textContent = T('version', { v: d.version });
}

// 配色：[id, 浅色版的 侧栏 / 对话区 / 强调色]（只用来画选择卡片）
const PALETTES = [
  ['default', '#121830', '#ffffff', '#4a6bff'],
  ['forest', '#11261b', '#ffffff', '#2f855a'],
  ['ocean', '#0e2331', '#ffffff', '#0e7490'],
  ['lavender', '#1c1634', '#ffffff', '#7c5cd6'],
  ['sand', '#2a1d13', '#fffdfa', '#c2410c'],
  ['rose', '#2a1322', '#ffffff', '#c93c66'],
];
// Windows：右上角最小化 / 关闭按钮那一块的底色跟顶栏一致（换配色、深浅色时都要更新）
function syncTitleBar() {
  if (document.documentElement.classList.contains('os-mac') || !window.api.titleBar) return;
  requestAnimationFrame(() => {
    const top = document.querySelector('.topbar');
    if (!top) return;
    const hex = (c) => {
      const m = String(c).match(/\d+(\.\d+)?/g);
      return m && m.length >= 3 ? '#' + m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('') : null;
    };
    const color = hex(getComputedStyle(top).backgroundColor);
    const symbolColor = hex(getComputedStyle(document.body).color);
    if (color && symbolColor) window.api.titleBar({ color, symbolColor });
  });
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTitleBar);
function applyPalette(id) {
  const p = PALETTES.some((x) => x[0] === id) ? id : 'default';
  if (p === 'default') delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
  syncTitleBar();
  try { localStorage.setItem('shuttle.palette', p); } catch {}
  document.querySelectorAll('#paletteCards button').forEach((b) => b.classList.toggle('on', b.dataset.palette === p));
}
function renderPaletteCards() {
  const box = $('paletteCards');
  box.innerHTML = '';
  for (const [id, side, main, accent] of PALETTES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.palette = id;
    b.innerHTML = `<span class="pal-pv" style="--ps:${side};--pm:${main};--pa:${accent}"></span><span>${esc(T('palette_' + id))}</span>`;
    b.onclick = async () => {
      applyPalette(id);
      settings = await window.api.saveSettings({ palette: id });
    };
    box.appendChild(b);
  }
  applyPalette(settings?.palette);
}

function applyAppearance() {
  applyPalette(settings.palette);
  document.body.style.setProperty('--chat-font', (settings.fontSize || 14) + 'px');
  applyFontFamily(settings.fontFamily);
  applyBackground();
}

// ---------- Windows / Linux：右上角系统按钮的底色跟着界面走 ----------
// 系统按钮是系统画的一块纯色，盖在界面右上角。每秒看一次那块地方界面实际是什么颜色（把叠在一起的半透明层混合起来），变了就告诉主进程。
if (!document.documentElement.classList.contains('os-mac')) {
  const parse = (c) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c || '');
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  const over = (top, base) => [0, 1, 2].map((i) => top[i] * top[3] + base[i] * (1 - top[3]));
  let bgAvg = null;
  let bgAvgFor = '';
  let last = '';
  const sample = async () => {
    const x = innerWidth - 70;
    const y = 24;
    const layers = []; // 从上到下
    let base = null;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.id === 'fakeCaption') continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || +cs.opacity === 0) continue;
      if (el.classList.contains('app-bg-img')) {
        // 背景图：图片（带透明度）叠在页面底色上，再盖一层遮罩
        const p = settings?.bgImage || '';
        if (p !== bgAvgFor) (bgAvgFor = p, (bgAvg = p ? await window.api.bgAvg(p) : null));
        const pageBg = parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255, 1];
        let c = bgAvg ? over([...bgAvg, +cs.opacity], pageBg) : pageBg.slice(0, 3);
        const dim = parse(getComputedStyle(el.parentElement, '::after').backgroundColor);
        const dimOp = +getComputedStyle(el.parentElement, '::after').opacity;
        if (dim) c = over([dim[0], dim[1], dim[2], dim[3] * dimOp], c);
        base = c;
        break;
      }
      const c = parse(cs.backgroundColor);
      if (!c || c[3] === 0) continue;
      const a = c[3] * (+cs.opacity || 1);
      if (a >= 0.999) {
        base = c.slice(0, 3);
        break;
      }
      layers.push([c[0], c[1], c[2], a]);
    }
    if (!base) base = (parse(getComputedStyle(document.body).backgroundColor) || [255, 255, 255]).slice(0, 3);
    for (const l of layers.reverse()) base = over(l, base);
    const hex = '#' + base.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
    const lum = 0.2126 * base[0] + 0.7152 * base[1] + 0.0722 * base[2];
    const symbol = lum < 128 ? '#d4d3ce' : '#3b3f45';
    if (hex + symbol !== last) {
      last = hex + symbol;
      window.api.setCaption({ color: hex, symbol });
      window.__captionLast = last;
    }
  };
  // 只在界面可能变色时检查：深浅色切换、窗口大小变化、弹窗开关 / 配色 / 背景图（class、style 变化），合并到下一帧做一次
  let queued = false;
  const tick = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => ((queued = false), sample().catch(() => {})));
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(tick, 50));
  addEventListener('resize', tick);
  addEventListener('focus', tick);
  new MutationObserver(tick).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-palette'], subtree: true });
  setInterval(tick, 5000); // 兜底
  tick();
  window.__captionSample = sample;
}

// ---------- 背景图：图片 + 填充方式、透明度、模糊、遮罩、界面通透度 ----------
const BG_DEFAULTS = { bgFit: 'cover', bgOpacity: 100, bgBlur: 0, bgDim: 50, bgGlass: 60 };
const bgVal = (k) => (settings?.[k] ?? BG_DEFAULTS[k]);
function applyBackground() {
  const on = !!settings?.bgImage;
  document.body.classList.toggle('has-bg', on);
  const img = document.querySelector('#appBg .app-bg-img');
  const st = document.body.style;
  if (on) {
    const fit = bgVal('bgFit');
    img.style.backgroundImage = `url("${fileUrl(settings.bgImage)}")`;
    img.style.backgroundSize = fit === 'cover' || fit === 'contain' ? fit : 'auto';
    img.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
    st.setProperty('--bg-opacity', bgVal('bgOpacity') / 100);
    st.setProperty('--bg-blur', bgVal('bgBlur') + 'px');
    st.setProperty('--bg-dim', bgVal('bgDim') / 100);
    st.setProperty('--glass', bgVal('bgGlass') + '%');
    // 侧栏是深色底白字：玻璃再透也至少留 62% 的底色，不然背景图一亮字就看不见了
    st.setProperty('--glass-side', Math.max(62, Number(bgVal('bgGlass')) + 5) + '%');
    st.setProperty('--glass-strong', Math.min(100, Number(bgVal('bgGlass')) + 15) + '%');
  } else img.style.backgroundImage = '';
  renderBgControls();
}
function renderBgControls() {
  const on = !!settings?.bgImage;
  const pv = $('bgPreview');
  pv.style.backgroundImage = on ? `url("${fileUrl(settings.bgImage)}")` : '';
  pv.classList.toggle('on', on);
  $('bgClear').classList.toggle('hidden', !on);
  $('bgControls').classList.toggle('disabled', !on);
  document.querySelectorAll('#bgFitSeg button').forEach((b) => b.classList.toggle('active', b.dataset.fit === bgVal('bgFit')));
  for (const [k, id, unit] of [['bgOpacity', 'bgOpacity', '%'], ['bgBlur', 'bgBlur', 'px'], ['bgDim', 'bgDim', '%'], ['bgGlass', 'bgGlass', '%']]) {
    if (document.activeElement !== $(id)) $(id).value = bgVal(k);
    $(id + 'Val').textContent = bgVal(k) + unit;
  }
}
const chooseBg = async () => {
  const r = await window.api.chooseBg();
  if (!r) return;
  if (r.error) return showToast(T('bgTooBig'));
  settings = await window.api.getSettings();
  applyBackground();
};
$('bgChoose').onclick = chooseBg;
$('bgPreview').onclick = chooseBg;
$('bgClear').onclick = async () => {
  await window.api.clearBg();
  settings = await window.api.getSettings();
  applyBackground();
};
document.querySelectorAll('#bgFitSeg button').forEach((b) => (b.onclick = async () => {
  settings.bgFit = b.dataset.fit;
  applyBackground();
  settings = await window.api.saveSettings({ bgFit: b.dataset.fit });
}));
for (const k of ['bgOpacity', 'bgBlur', 'bgDim', 'bgGlass']) {
  // 拖动时实时预览，松手再保存
  $(k).oninput = (e) => {
    settings[k] = Number(e.target.value);
    applyBackground();
  };
  $(k).onchange = async (e) => (settings = await window.api.saveSettings({ [k]: Number(e.target.value) }));
}
$('bgReset').onclick = async () => {
  Object.assign(settings, BG_DEFAULTS);
  applyBackground();
  settings = await window.api.saveSettings({ ...BG_DEFAULTS });
};

// ---------- Windows / Linux 默认界面字体：下载好的思源黑体（英文数字仍用 Segoe UI） ----------
function useUiFont(url) {
  if (!url || document.getElementById('uiFontFace')) return;
  const st = document.createElement('style');
  st.id = 'uiFontFace';
  st.textContent = `@font-face { font-family: "Shuttle Sans"; src: url("${url}") format("woff2"); font-weight: 100 900; font-display: swap; }
:root.os-win, :root.os-linux { --font: "Shuttle Sans", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
:root.os-win body, :root.os-linux body { font-weight: 450; }`;
  document.head.appendChild(st);
}
if (!document.documentElement.classList.contains('os-mac')) window.api.uiFont().then(useUiFont).catch(() => {});

// ---------- 字体 ----------
// 常用字体按系统里有没有装来显示；另外列出本机已安装的全部字体（Local Font Access）
const FALLBACK_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const FONT_PRESETS = [
  { id: 'hei', label: 'fontHei', families: ['Source Han Sans SC', 'Noto Sans CJK SC', 'Noto Sans SC', '思源黑体'] },
  { id: 'song', label: 'fontSong', families: ['Songti SC', 'STSong', 'SimSun', 'Source Han Serif SC', 'Noto Serif CJK SC', 'Noto Serif SC'], tail: 'serif' },
  { id: 'kai', label: 'fontKai', families: ['Kaiti SC', 'STKaiti', 'KaiTi', 'BiauKai'], tail: 'serif' },
  { id: 'fangsong', label: 'fontFangsong', families: ['STFangsong', 'FangSong', 'FangSong_GB2312'], tail: 'serif' },
  { id: 'yuan', label: 'fontYuan', families: ['Yuanti SC', 'YouYuan', 'Yuppy SC'] },
  { id: 'wenkai', label: 'fontWenkai', families: ['LXGW WenKai', 'LXGW WenKai Screen', '霞鹜文楷'] },
  { id: 'serif', label: 'fontSerifEn', families: ['Georgia', 'Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC'], tail: 'serif', always: true },
  { id: 'rounded', label: 'fontRounded', families: ['ui-rounded', 'SF Pro Rounded', 'Yuanti SC', 'PingFang SC'], mac: true },
];
const q = (f) => (/^ui-/.test(f) ? f : `"${f}"`);
function fontStack(id) {
  if (!id || id === 'system') return '';
  if (id.startsWith('local:')) return `${q(id.slice(6))}, ${FALLBACK_FONT}`;
  const p = FONT_PRESETS.find((x) => x.id === id);
  if (!p) return '';
  return [...p.families.map(q), p.tail === 'serif' ? 'serif' : FALLBACK_FONT].join(', ');
}
function applyFontFamily(id) {
  const st = fontStack(id);
  if (st) document.documentElement.style.setProperty('--font', st);
  else document.documentElement.style.removeProperty('--font');
}
// 判断字体装没装：用中英文混排的样张量宽度，和兜底字体不一样就说明装了
function fontInstalled(family) {
  const c = fontInstalled.c || (fontInstalled.c = document.createElement('canvas').getContext('2d'));
  const sample = '梭子字体 Shuttle Font 0123';
  return ['monospace', 'serif'].some((base) => {
    c.font = `40px ${base}`;
    const w0 = c.measureText(sample).width;
    c.font = `40px "${family}", ${base}`;
    return c.measureText(sample).width !== w0;
  });
}
let localFonts = null;
async function loadLocalFonts() {
  if (localFonts) return localFonts;
  try {
    const list = await window.queryLocalFonts();
    localFonts = [...new Set(list.map((f) => f.family))].filter((f) => !/^\.|LastResort|Emoji|Symbol|Wingdings|Webdings|Dingbats/i.test(f)).sort((a, b) => a.localeCompare(b, 'zh'));
  } catch {
    localFonts = [];
  }
  return localFonts;
}
async function renderFontOptions() {
  const sel = $('fontFamily');
  const cur = settings.fontFamily || 'system';
  const isMac = /Mac/.test(navigator.platform);
  const presets = FONT_PRESETS.filter((p) => (p.mac ? isMac : true) && (p.always || p.families.some(fontInstalled)));
  const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
  let html = opt('system', T('fontSystem'));
  html += `<optgroup label="${esc(T('fontGroupPreset'))}">${presets.map((p) => opt(p.id, T(p.label))).join('')}</optgroup>`;
  sel.innerHTML = html;
  sel.value = cur;
  const fonts = await loadLocalFonts();
  if (fonts.length) {
    sel.insertAdjacentHTML('beforeend', `<optgroup label="${esc(T('fontGroupLocal'))}">${fonts.map((f) => `<option value="local:${esc(f)}" style="font-family:${esc(q(f))}">${esc(f)}</option>`).join('')}</optgroup>`);
  }
  if (cur.startsWith('local:') && ![...sel.options].some((o) => o.value === cur)) sel.insertAdjacentHTML('beforeend', opt(cur, cur.slice(6)));
  sel.value = cur;
}
$('fontFamily').onchange = async (e) => {
  applyFontFamily(e.target.value);
  settings = await window.api.saveSettings({ fontFamily: e.target.value });
};

// 「更多模型」输入框 → 模型 ID 列表。用户常把显示名（如「Gemma 4 31B」）当模型名填进来：
// 先按逗号/换行分，能对上内置模型显示名的换成它的 ID；其余按空格再分（模型 ID 里没有空格）
function parseExtraModels(value, p) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[（(].*$/, '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const part of String(value || '').replace(/[（(][^）)]*[）)]/g, '').split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean)) {
    const hit = (p?.models || []).find((m) => [m.id, m.label, m.labelEn].some((l) => l && norm(l) === norm(part)));
    if (hit) out.push(hit.id);
    else out.push(...part.split(/\s+/).filter(Boolean));
  }
  return [...new Set(out)];
}
function openSettings(tab = 'models') {
  refreshTeamTab();
  const list = $('keyList');
  list.innerHTML = '';
  let codingHead = false;
  for (const [id, p] of Object.entries(settings.providers)) {
    if (p.coding && !codingHead) {
      codingHead = true;
      const h = document.createElement('div');
      h.className = 'keygroup';
      h.innerHTML = `<b>${esc(T('codingPlanTitle'))}</b><span>${esc(T('codingPlanTip'))}</span>`;
      list.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'keyrow';
    const builtin = p.models.map((m) => m.id);
    const extra = settings.allModels[id].map((m) => m.id).filter((m) => !builtin.includes(m));
    row.innerHTML = `<span>${esc(pName(p))}</span>
      <input type="password" data-key="${id}" placeholder="${settings.hasKey[id] ? esc(T('keySaved')) : 'sk-...'}" />
      <input data-models="${id}" value="${esc(extra.join(', '))}" placeholder="${esc(id === 'custom' ? T('customRequired') : T('extraModelsPh'))}" title="${esc(T('extraModelsTip'))}" />
      <button class="ghost test-btn">${esc(T('test'))}</button>
      ${p.keyUrl ? `<a>${esc(T('getKey'))}</a>` : '<span></span>'}
      <div class="test-result"></div>`;
    if (p.keyUrl) row.querySelector('a').onclick = () => window.api.openExternal(p.keyUrl);
    row.querySelector('.test-btn').onclick = async () => {
      const out = row.querySelector('.test-result');
      out.className = 'test-result';
      out.textContent = T('testing');
      const key = row.querySelector('[data-key]').value.trim();
      const firstExtra = parseExtraModels(row.querySelector('[data-models]').value, p)[0];
      const r = await window.api.testProvider(id, {
        key: key || undefined,
        model: firstExtra || undefined, // 填了「额外模型名」就测第一个，方便确认模型名对不对
        baseUrl: id === 'custom' ? $('customBaseUrl').value.trim() : undefined,
      });
      out.className = 'test-result ' + (r.ok ? 'ok' : 'fail');
      out.textContent = (r.ok ? '✓ ' : '✗ ') + r.msg;
    };
    list.appendChild(row);
  }
  $('customBaseUrl').value = settings.customBaseUrl || '';

  $('customInstructions').value = settings.customInstructions || '';
  $('temperature').value = settings.temperature;
  $('tempVal').textContent = settings.temperature;
  $('maxSteps').value = settings.maxSteps;
  $('suggestNext').checked = settings.suggestNext !== false;
  $('imageWatermark').checked = settings.imageWatermark !== false;
  $('approvalSel2').value = settings.approval;
  $('blockedCommands').value = (settings.blockedCommands || []).join('\n');
  $('commandTimeout').value = settings.commandTimeout;
  $('ignoreDirs').value = (settings.ignoreDirs || []).join(', ');
  $('language').value = lang();
  $('theme').value = settings.theme;
  $('fontSize').value = String(settings.fontSize);
  syncAppearanceUI();
  switchTab(tab);
  $('settingsModal').classList.remove('hidden');
}
$('temperature').oninput = (e) => ($('tempVal').textContent = e.target.value);
$('settingsBtn').onclick = () => openSettings();

$('settingsCancel').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsClose').onclick = () => $('settingsModal').classList.add('hidden');
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('settingsModal').classList.contains('hidden')) return;
  // 设置上面还盖着别的弹窗时，先关那个
  if ([...document.querySelectorAll('.modal:not(.hidden)')].some((m) => m.id !== 'settingsModal')) return;
  $('settingsModal').classList.add('hidden');
});
$('backupsBtn').onclick = () => window.api.openBackups();
$('dataDirBtn').onclick = () => window.api.openDataDir();
$('clearBackupsBtn').onclick = async () => {
  if (!confirm(T('clearBackupsConfirm'))) return;
  await window.api.dataClear('backups');
  refreshDataInfo();
};
$('clearHistoryBtn').onclick = async () => {
  if (runningConvs.size) return alert(T('waitTask'));
  if (!confirm(T(settings.convSync ? 'clearHistoryConfirmCloud' : 'clearHistoryConfirm'))) return;
  await window.api.dataClear('history');
  clearLog();
  refreshConvs();
  refreshDataInfo();
};
$('settingsSave').onclick = async () => {
  const keys = {};
  const extraModels = {};
  document.querySelectorAll('#keyList input[data-key]').forEach((i) => {
    if (i.value.trim()) keys[i.dataset.key] = i.value.trim();
  });
  document.querySelectorAll('#keyList input[data-models]').forEach((i) => {
    extraModels[i.dataset.models] = parseExtraModels(i.value, settings.providers[i.dataset.models]);
  });
  const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number(v) || d));
  settings = await window.api.saveSettings({
    keys,
    extraModels,
    customBaseUrl: $('customBaseUrl').value.trim(),
    customInstructions: $('customInstructions').value.trim(),
    temperature: Number($('temperature').value),
    maxSteps: clampNum($('maxSteps').value, 5, 200, 40),
    suggestNext: $('suggestNext').checked,
    approval: $('approvalSel2').value,
    blockedCommands: $('blockedCommands').value.split('\n').map((l) => l.trim()).filter(Boolean),
    commandTimeout: clampNum($('commandTimeout').value, 5, 3600, 60),
    ignoreDirs: $('ignoreDirs').value.split(/[,，]+/).map((x) => x.trim()).filter(Boolean),
    theme: $('theme').value,
    language: $('language').value,
    fontSize: Number($('fontSize').value),
  });
  await fixOwnKeySelection();
  renderModelSel();
  renderQuota();
  $('approvalSel').value = settings.approval;
  markApproval();
  applyAppearance();
  rerenderAll();
  $('settingsModal').classList.add('hidden');
};

// ---------- 外观：语言、主题选完立即生效（不用点保存） ----------
$('language').onchange = (e) => setLanguage(e.target.value);
$('theme').onchange = async (e) => {
  settings = await window.api.saveSettings({ theme: e.target.value });
};
function syncAppearanceUI() {
  renderFontOptions();
  renderPaletteCards();
  document.querySelectorAll('#themeCards button').forEach((b) => b.classList.toggle('on', b.dataset.themeOpt === $('theme').value));
  document.querySelectorAll('#fontSeg button').forEach((b) => b.classList.toggle('on', b.dataset.font === $('fontSize').value));
}
document.querySelectorAll('#themeCards button').forEach(
  (b) =>
    (b.onclick = () => {
      $('theme').value = b.dataset.themeOpt;
      $('theme').dispatchEvent(new Event('change'));
      syncAppearanceUI();
    })
);
document.querySelectorAll('#fontSeg button').forEach(
  (b) =>
    (b.onclick = async () => {
      $('fontSize').value = b.dataset.font;
      syncAppearanceUI();
      // 和主题、语言一样立即生效，不用再点保存
      settings = await window.api.saveSettings({ fontSize: Number(b.dataset.font) });
      applyAppearance();
    })
);

// ---------- 登录 / 注册 ----------
let currentUser = null;
function showAuth(tab = 'login') {
  $('authScreen').classList.remove('hidden');
  switchAuthTab(tab);
  $('serverUrl').value = settings.serverUrl || '';
  setTimeout(() => $(tab === 'login' ? 'loginAccount' : 'regUsername').focus(), 50);
}
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.auth === tab));
  $('loginForm').classList.toggle('hidden', tab !== 'login');
  $('registerForm').classList.toggle('hidden', tab !== 'register');
  $('loginError').textContent = '';
  $('registerError').textContent = '';
  if (tab === 'register') loadCaptcha();
}
// 注册用的图形验证码（算术题），点图片换一张；每次提交后都换新的
let captchaUuid = '';
async function loadCaptcha() {
  $('regCaptcha').value = '';
  const r = await window.api.captcha();
  if (r.ok) {
    captchaUuid = r.data.uuid;
    $('regCaptchaImg').src = r.data.img;
  } else {
    captchaUuid = '';
    $('regCaptchaImg').removeAttribute('src');
  }
}
$('regCaptchaImg').onclick = loadCaptcha;
document.querySelectorAll('.auth-tabs button').forEach((b) => (b.onclick = () => switchAuthTab(b.dataset.auth)));
$('authLang').onclick = () => setLanguage(lang() === 'en' ? 'zh' : 'en');
$('serverSave').onclick = async () => {
  settings = await window.api.saveSettings({ serverUrl: $('serverUrl').value.trim() });
  $('serverSave').textContent = T('serverSaved');
  setTimeout(() => ($('serverSave').textContent = T('save')), 1200);
};

async function withBusy(btn, busyKey, idleKey, fn) {
  btn.disabled = true;
  btn.textContent = T(busyKey);
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = T(idleKey);
  }
}
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  const r = await withBusy($('loginSubmit'), 'loggingIn', 'login', () =>
    window.api.login($('loginAccount').value.trim(), $('loginPassword').value)
  );
  if (r.error) return ($('loginError').textContent = T('err_' + r.error));
  $('loginPassword').value = '';
  enterApp(r.user);
};
// 《用户协议》链接（登录页、注册页、关于页）：用系统浏览器打开服务器上的网页
document.querySelectorAll('.terms-link').forEach((a) => (a.onclick = (e) => {
  e.preventDefault();
  e.stopPropagation(); // 注册页的链接在勾选框的 label 里，点链接不要顺便勾上
  window.api.openTerms(a.dataset.doc || 'terms');
}));
$('regAgree').onchange = () => $('regAgree').checked && $('registerError').textContent === T('termsRequired') && ($('registerError').textContent = '');
$('registerForm').onsubmit = async (e) => {
  e.preventDefault();
  $('registerError').textContent = '';
  if (!$('regAgree').checked) return ($('registerError').textContent = T('termsRequired'));
  if ($('regPassword').value !== $('regConfirm').value) return ($('registerError').textContent = T('passwordMismatch'));
  const r = await withBusy($('registerSubmit'), 'registering', 'createAccount', () =>
    window.api.register({ username: $('regUsername').value.trim(), email: $('regEmail').value.trim(), password: $('regPassword').value, captchaUuid, captchaCode: $('regCaptcha').value.trim() })
  );
  if (r.error) {
    loadCaptcha();
    return ($('registerError').textContent = T('err_' + r.error));
  }
  $('regPassword').value = $('regConfirm').value = '';
  enterApp(r.user);
};
$('logoutBtn').onclick = async () => {
  if (running || !confirm(T('logoutConfirm'))) return;
  await window.api.logout();
  currentUser = null;
  clearLog();
  showAuth('login');
};

// 头像：有图片显示图片，没有显示名字首字（图片加载失败也退回首字）
function paintAvatar(el) {
  const name = currentUser.nickname || currentUser.username;
  el.textContent = '';
  el.classList.remove('has-img');
  if (currentUser.avatarUrl) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = currentUser.avatarUrl;
    img.onerror = () => {
      img.remove();
      el.classList.remove('has-img');
      el.textContent = name.slice(0, 1).toUpperCase();
    };
    el.appendChild(img);
    el.classList.add('has-img');
  } else el.textContent = name.slice(0, 1).toUpperCase();
}
function renderUser() {
  if (!currentUser) return;
  paintAvatar($('userAvatar'));
  if ($('profAvatar')) {
    paintAvatar($('profAvatar'));
    $('avatarRemove').classList.toggle('hidden', !currentUser.avatarUrl);
  }
  $('userName').textContent = currentUser.username;
  $('userName').title = currentUser.email || currentUser.username;
  $('userBadge').classList.toggle('hidden', currentUser.role !== 'admin');
}
async function enterApp(user) {
  currentUser = user;
  $('authScreen').classList.add('hidden');
  // 登录时主进程已从服务器同步了设置和模型目录，重新读一遍
  settings = await window.api.getSettings();
  $('approvalSel').value = settings.approval;
  markApproval();
  applyAppearance();
  applyI18n();
  renderModelSel();
  renderWorkspace();
  renderUser();
  refreshQuota();
  loadBanners();
  clearLog();
  refreshConvs();
  await fixOwnKeySelection();
  if (!settings.onboarded) $('onboardModal').classList.remove('hidden');
}

// ---------- 新用户引导：看过一次就不再显示 ----------
async function finishOnboarding() {
  $('onboardModal').classList.add('hidden');
  settings = await window.api.saveSettings({ onboarded: true });
}
$('obStart').onclick = () => {
  finishOnboarding();
  $('input').focus();
};
$('obConn').onclick = () => {
  finishOnboarding();
  connMode = 'mcp';
  openConnectors('discover');
};

// ---------- 账号 ----------
const fmtNum = (n) => Number(n || 0).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN');
const fmtTime = (t) => (t ? new Date(t).toLocaleString(lang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '-');
function formMsg(id, ok, text) {
  $(id).className = 'form-msg ' + (ok ? 'ok' : 'err');
  $(id).textContent = text;
  if (ok) setTimeout(() => ($(id).textContent = ''), 3000);
}
const errText = (r) => T('err_' + r.error);

async function loadAccount() {
  const r = await window.api.call('GET', '/aidesk/auth/me');
  if (!r.ok) return;
  const me = r.data;
  currentUser = me.user;
  renderUser();
  quota = me.quota;
  renderQuota();
  $('planBox').innerHTML = quotaDetailHtml(me.quota) + `<div class="row"><button class="ghost small" id="planBoxUpgrade">${esc(T('upgrade'))}</button></div>`;
  $('planBoxUpgrade').onclick = () => openPlans();
  $('profNickname').value = me.user.nickname || '';
  $('profEmail').value = me.user.email || '';
  $('dangerZone').classList.toggle('hidden', me.user.role === 'admin');
  loadDevices();
  loadMcpTokens();
  $('mcpUrlText').textContent = mcpUrl();
  $('mcpTokenNew').classList.add('hidden');
  newMcpToken = '';
}
async function loadDevices() {
  const r = await window.api.call('GET', '/aidesk/account/sessions');
  const box = $('deviceList');
  if (!r.ok) return (box.textContent = errText(r));
  box.innerHTML = '';
  for (const d of r.data.sessions) {
    const el = document.createElement('div');
    el.className = 'device';
    el.innerHTML = `<div><b>${esc(d.deviceName || d.platform)}</b>${d.current ? `<span class="tag">${esc(T('thisDevice'))}</span>` : ''}
      <div class="hint">${esc(d.platform)} · ${esc(d.appVersion || '')} · ${esc(d.ip || '')} · ${esc(T('lastActive', { t: fmtTime(d.lastActiveAt) }))}</div></div>
      ${d.current ? '' : `<button class="ghost small">${esc(T('signOutDevice'))}</button>`}`;
    el.querySelector('button')?.addEventListener('click', async () => {
      await window.api.call('DELETE', '/aidesk/account/sessions/' + d.id);
      loadDevices();
    });
    box.appendChild(el);
  }
}
// ---------- MCP 令牌：在 Claude、Cursor 等工具里连 Shuttle 平台，查额度、用量、会员 ----------
const mcpUrl = () => (settings.serverUrl || 'https://richbrian.site').replace(/\/$/, '') + '/aidesk/mcp';
async function loadMcpTokens() {
  const r = await window.api.call('GET', '/aidesk/mcp-tokens');
  const box = $('mcpTokenList');
  box.innerHTML = '';
  if (!r.ok) return;
  for (const t of r.data.tokens) {
    const el = document.createElement('div');
    el.className = 'device';
    const used = t.lastUsedAt ? T('mcpTokenUsed', { t: fmtTime(t.lastUsedAt) }) : T('mcpTokenNeverUsed');
    const oauth = !!t.clientId;
    el.innerHTML = `<div><b>${esc(t.name || T('mcpTokenUnnamed'))}</b>${oauth ? `<span class="tag">${esc(T('mcpTokenOAuth'))}</span>` : ''}
      <div class="hint">${oauth ? '' : esc(t.tokenPrefix) + '… · '}${esc(T(oauth ? 'mcpTokenAuthorized' : 'mcpTokenCreated', { t: fmtTime(t.createTime) }))} · ${esc(used)}${!oauth && t.expiresAt ? ' · ' + esc(T('mcpTokenExpires', { t: fmtTime(t.expiresAt) })) : ''}</div></div>
      <button class="ghost small">${esc(T('mcpTokenRevoke'))}</button>`;
    el.querySelector('button').addEventListener('click', async () => {
      if (!confirm(T('mcpTokenRevokeConfirm', { name: t.name || t.tokenPrefix }))) return;
      await window.api.call('DELETE', '/aidesk/mcp-tokens/' + t.id);
      loadMcpTokens();
    });
    box.appendChild(el);
  }
}
let newMcpToken = '';
const mcpJson = (tk) => JSON.stringify({ mcpServers: { shuttle: { type: 'http', url: mcpUrl(), headers: { Authorization: 'Bearer ' + tk } } } }, null, 2);
const copyMsg = async (text) => {
  await navigator.clipboard.writeText(text);
  formMsg('mcpTokenMsg', true, T('copied'));
};
$('mcpTokenCreate').onclick = async () => {
  const r = await window.api.call('POST', '/aidesk/mcp-tokens', { name: $('mcpTokenName').value.trim() });
  if (!r.ok) return formMsg('mcpTokenMsg', false, r.error === 'too_many_tokens' ? T('mcpTokenTooMany') : errText(r));
  newMcpToken = r.data.token;
  $('mcpTokenValue').textContent = newMcpToken;
  $('mcpTokenNew').classList.remove('hidden');
  $('mcpTokenName').value = '';
  loadMcpTokens();
};
$('mcpTokenCopy').onclick = () => copyMsg(newMcpToken);
$('mcpUrlCopy').onclick = () => copyMsg(mcpUrl());
$('mcpTokenCopyJson').onclick = () => copyMsg(mcpJson(newMcpToken));
$('mcpTokenCopyCli').onclick = () => copyMsg(`claude mcp add --transport http shuttle ${mcpUrl()} --header "Authorization: Bearer ${newMcpToken}"`);
$('mcpTokenInstall').onclick = async () => {
  const r = await window.api.mcpInstallPlatform(newMcpToken);
  formMsg('mcpTokenMsg', !!r?.ok, r?.ok ? T('mcpTokenInstalled') : r?.error || T('mcpTokenInstallFailed'));
};
// ---------- 团队：超级管理员 / 管理员生成团队令牌，客服绑定后对话里能查用户、开会员、加额度、确认收款 ----------
const teamErr = (r) => {
  const k = 'teamErr_' + (r?.error || '');
  const t = T(k);
  return t !== k ? t : r?.error && /[一-龥]/.test(r.error) ? r.error : errText(r);
};
let teamMe = null;
async function loadTeam() {
  const r = await window.api.call('GET', '/aidesk/team/me');
  if (!r.ok) return;
  teamMe = r.data;
  $('teamRole').textContent = T('teamRole_' + (teamMe.role || 'none'));
  if (teamMe.canManage) {
    loadTeamMembers();
    loadTeamLogs();
  }
}
// 「团队」菜单只有超级管理员、管理员看得到
async function refreshTeamTab() {
  const r = await window.api.call('GET', '/aidesk/team/me').catch(() => null);
  const show = !!r?.ok && !!r.data.canManage;
  document.querySelector('.tabs button[data-tab="team"]')?.classList.toggle('hidden', !show);
  if (!show && !document.querySelector('[data-pane="team"]').classList.contains('hidden')) switchTab('account');
}
async function loadTeamMembers() {
  const r = await window.api.call('GET', '/aidesk/team/members');
  const box = $('teamMemberList');
  box.innerHTML = '';
  if (!r.ok) return;
  for (const m of r.data.members) {
    const el = document.createElement('div');
    el.className = 'device';
    const canRemove = m.role !== 'owner' && (m.role !== 'admin' || teamMe?.isOwner);
    const exp = m.expiresAt ? (m.expired ? T('teamExpired') : T('teamUntil', { t: fmtTime(m.expiresAt) })) : T('teamForever');
    el.innerHTML = `<div><b>${esc(m.nickname || m.username)}</b>${m.nickname && m.nickname !== m.username ? `<span class="hint"> @${esc(m.username)}</span>` : ''}<span class="tag team-role-${esc(m.role)}">${esc(T('teamRole_' + m.role))}</span>
      <div class="hint">${esc(exp)}${m.tokenName ? ' · ' + esc(T('teamViaToken', { name: m.tokenName })) : ''}${m.grantedBy ? ' · ' + esc(T('teamGrantedBy', { u: m.grantedBy })) : ''}</div></div>
      ${canRemove ? `<button class="ghost small danger-text">${esc(T('teamRemove'))}</button>` : '<span></span>'}`;
    el.querySelector('button')?.addEventListener('click', async () => {
      if (!confirm(T('teamRemoveConfirm', { u: m.username, role: T('teamRole_' + m.role) }))) return;
      const x = await window.api.call('DELETE', '/aidesk/team/members/' + m.userId);
      if (!x.ok) alert(teamErr(x));
      loadTeam();
    });
    box.appendChild(el);
  }
}
async function loadTeamLogs() {
  const r = await window.api.call('GET', '/aidesk/team/logs?limit=50');
  const box = $('teamLogList');
  box.innerHTML = '';
  if (!r.ok) return;
  if (!r.data.logs.length) box.innerHTML = `<div class="hint">${esc(T('teamNoLogs'))}</div>`;
  for (const l of r.data.logs) {
    const el = document.createElement('div');
    el.className = 'team-log';
    el.innerHTML = `<span class="tl-time">${esc(fmtTime(l.createTime))}</span><span class="tl-who">${esc(l.operatorName)}</span><span class="tl-what">${esc(l.summary)}${l.source === 'chat' ? `<span class="tag">${esc(T('teamViaChat'))}</span>` : ''}</span>`;
    box.appendChild(el);
  }
}
$('revokeOthers').onclick = async () => {
  const r = await window.api.call('POST', '/aidesk/account/sessions/revoke-others');
  if (r.ok) loadDevices();
};
// 选图 → 居中裁成正方形、缩到 256×256、转 JPEG → 上传
function squareAvatar(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
      resolve(c.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode'));
    };
    img.src = url;
  });
}
$('avatarPick').onclick = () => $('avatarFile').click();
$('avatarFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let image;
  try {
    image = await squareAvatar(f);
  } catch {
    return formMsg('profMsg', false, T('err_invalid_image'));
  }
  $('avatarPick').disabled = true;
  const r = await window.api.call('POST', '/aidesk/account/avatar', { image });
  $('avatarPick').disabled = false;
  if (!r.ok) return formMsg('profMsg', false, errText(r));
  currentUser = r.data.user;
  renderUser();
  formMsg('profMsg', true, T('avatarUploaded'));
};
$('avatarRemove').onclick = async () => {
  const r = await window.api.call('DELETE', '/aidesk/account/avatar');
  if (!r.ok) return formMsg('profMsg', false, errText(r));
  currentUser = r.data.user;
  renderUser();
  formMsg('profMsg', true, T('avatarRemoved'));
};
$('profSave').onclick = async () => {
  const r = await window.api.call('PUT', '/aidesk/account/profile', { nickname: $('profNickname').value, email: $('profEmail').value });
  if (!r.ok) return formMsg('profMsg', false, errText(r));
  currentUser = r.data.user;
  renderUser();
  formMsg('profMsg', true, T('saved'));
};
$('pwSave').onclick = async () => {
  if ($('pwNew').value !== $('pwConfirm').value) return formMsg('pwMsg', false, T('passwordMismatch'));
  const r = await window.api.call('POST', '/aidesk/account/password', { oldPassword: $('pwOld').value, newPassword: $('pwNew').value });
  if (!r.ok) return formMsg('pwMsg', false, errText(r));
  $('pwOld').value = $('pwNew').value = $('pwConfirm').value = '';
  formMsg('pwMsg', true, T('pwChanged', { n: r.data.revokedSessions }));
  loadDevices();
};
$('deleteAccountBtn').onclick = async () => {
  if (!$('delPassword').value || !confirm(T('deleteAccountConfirm'))) return;
  const r = await window.api.call('POST', '/aidesk/account/delete', { password: $('delPassword').value });
  $('delPassword').value = '';
  if (!r.ok) return formMsg('delMsg', false, errText(r));
  await window.api.logout();
  currentUser = null;
  $('settingsModal').classList.add('hidden');
  clearLog();
  showAuth('login');
};

// ---------- 用量 ----------
async function loadUsage() {
  const r = await window.api.call('GET', '/aidesk/usage/summary');
  if (!r.ok) return ($('usageStats').textContent = errText(r));
  const u = r.data;
  const stat = (v, l) => `<div class="stat"><div class="v">${fmtNum(v)}</div><div class="l">${esc(T(l))}</div></div>`;
  $('usageStats').innerHTML =
    stat(u.today.billed ?? u.today.tokens, 'statTodayBilled') + stat(u.today.calls, 'statTodayCalls') + stat(u.month.billed ?? u.month.tokens, 'statMonthBilled') + stat(u.month.calls, 'statMonthCalls');
  // 平台模式按「扣除额度」显示：命中缓存的输入只按一小部分扣
  // 补齐最近 7 天（没有用量的日子显示 0）
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = u.daily.find((x) => x.day === key);
    days.push({ key, tokens: row ? row.billed ?? row.tokens : 0 });
  }
  const max = Math.max(1, ...days.map((d) => d.tokens));
  $('usageDaily').innerHTML = days
    .map((d) => `<div class="b" title="${d.key}: ${fmtNum(d.tokens)}"><span>${d.tokens ? fmtNum(d.tokens) : ''}</span><i style="height:${(d.tokens / max) * 80}%"></i><span>${d.key.slice(5)}</span></div>`)
    .join('');
  $('usageByModel').innerHTML = u.byModel.length
    ? `<tr><th>${esc(T('colModel'))}</th><th class="num">${esc(T('colTokens'))}</th><th class="num">${esc(T('colBilled'))}</th><th class="num">${esc(T('colCalls'))}</th></tr>` +
      u.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td class="num">${fmtNum(m.tokens)}</td><td class="num">${fmtNum(m.billed ?? m.tokens)}</td><td class="num">${fmtNum(m.calls)}</td></tr>`).join('')
    : `<tr><td class="hint">${esc(T('noData'))}</td></tr>`;
}

// ---------- 反馈 ----------
async function loadFeedback() {
  const r = await window.api.call('GET', '/aidesk/feedback/mine');
  const box = $('fbList');
  if (!r.ok) return (box.textContent = errText(r));
  if (!r.data.feedback.length) return (box.innerHTML = `<div class="hint">${esc(T('noFeedback'))}</div>`);
  box.innerHTML = r.data.feedback
    .map((f) => `<div class="fb-item"><div class="meta">${esc(T('fb' + f.type[0].toUpperCase() + f.type.slice(1)))} · ${esc(T('fbStatus_' + f.status))} · ${esc(fmtTime(f.createTime))}</div>
      <div class="content">${esc(f.content)}</div>${f.reply ? `<div class="reply">${esc(T('adminReply'))}${esc(f.reply)}</div>` : ''}</div>`)
    .join('');
}
$('fbSubmit').onclick = async () => {
  const r = await window.api.call('POST', '/aidesk/feedback', {
    type: $('fbType').value, content: $('fbContent').value, contact: $('fbContact').value, appVersion: settings.appVersion, platform: settings.platform,
  });
  if (!r.ok) return formMsg('fbMsg', false, errText(r));
  $('fbContent').value = '';
  formMsg('fbMsg', true, T('fbSent'));
  loadFeedback();
};

// ---------- 公告与版本更新横幅 ----------
function dismissedIds() {
  try {
    return JSON.parse(localStorage.getItem('dismissedAnnouncements') || '[]');
  } catch {
    return [];
  }
}
async function loadBanners() {
  const box = $('banners');
  box.innerHTML = '';
  const [ann, ver] = await Promise.all([
    window.api.call('GET', '/aidesk/announcements'),
    window.api.call('GET', `/aidesk/app/version?platform=${settings.platform}&arch=${settings.arch}&current=${settings.appVersion}`),
  ]);
  if (ver.ok && ver.data.updateAvailable) {
    const v = ver.data.latest;
    const notes = (lang() === 'en' && v.releaseNotesEn) || v.releaseNotes || '';
    const el = document.createElement('div');
    el.className = 'banner ' + (ver.data.force ? 'critical' : 'info');
    el.innerHTML = `<div class="bt"><b>${esc(T(ver.data.force ? 'updateForce' : 'updateAvailable', { v: v.version }))}</b>${esc(notes.split('\n')[0])}</div>
      <button>${esc(T('download'))}</button>${ver.data.force ? '' : `<button class="x">${esc(T('dismiss'))}</button>`}`;
    el.querySelector('button').onclick = () => window.api.openExternal(v.downloadUrl);
    el.querySelector('.x')?.addEventListener('click', () => el.remove());
    box.appendChild(el);
  }
  if (ann.ok) {
    const hidden = dismissedIds();
    for (const a of ann.data.announcements.filter((x) => !hidden.includes(x.id))) {
      const title = (lang() === 'en' && a.titleEn) || a.title;
      const content = (lang() === 'en' && a.contentEn) || a.content;
      const el = document.createElement('div');
      el.className = 'banner ' + a.level;
      el.innerHTML = `<div class="bt"><b>${esc(title)}</b>${esc(content)}</div><button>${esc(T('dismiss'))}</button>`;
      el.querySelector('button').onclick = () => {
        try {
          localStorage.setItem('dismissedAnnouncements', JSON.stringify([...dismissedIds(), a.id]));
        } catch {}
        el.remove();
      };
      box.appendChild(el);
    }
  }
}

// ---------- 平台模型、额度、会员 ----------
let quota = null;
let quotaTimer = null;
const userLevel = () => (quota && quota.level) || 0;
const levelName = (l) => T('level' + l);
const fmtTok = (n) => {
  n = Number(n || 0);
  if (lang() === 'en') return n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
  return n >= 1e4 ? (n / 1e4).toFixed(n % 1e4 ? 1 : 0).replace(/\.0$/, '') + ' 万' : String(n);
};
const yuan = (cents) => (cents / 100).toFixed(cents % 100 ? 2 : 0);
function sel_revert() {
  $('modelSel').value = currentModelValue();
}

function renderPlatformModels(sel) {
  const groups = {};
  for (const m of settings.platformModels || []) (groups[m.group || m.provider] ||= { m, list: [] }).list.push(m);
  for (const { m: first, list } of Object.values(groups)) {
    const g = document.createElement('optgroup');
    g.label = (lang() === 'en' && first.nameEn) || first.name;
    for (const m of list) {
      const o = document.createElement('option');
      o.value = 'P::' + m.value;
      const locked = m.minPlanLevel > userLevel();
      // 只显示模型名：去掉「（通用，便宜）」这类括号说明；需要更高会员的只加一个小锁
      const name = ((lang() === 'en' && m.labelEn) || m.label).replace(/\s*[（(][^）)]*[）)]\s*$/, '').trim();
      // 名字后面标上扣额度的倍数（免费的标「免费」），用户选之前就知道贵不贵
      const mul = Number(m.multiplier ?? 1);
      const tag = mul === 0 ? T('modelFreeTag') : `×${+mul.toFixed(2)}`;
      o.textContent = `${name} ${tag}` + (locked ? ' 🔒' : '');
      o.title = locked ? T('modelNeedPlan', { plan: levelName(m.minPlanLevel) }) : mul === 0 ? T('modelFreeTip') : T('modelMulTip', { mul: +mul.toFixed(2) });
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
}

async function fixOwnKeySelection() {
  if (settings.useOwnKey && !settings.hasKey[settings.provider]) {
    settings = await window.api.saveSettings({ useOwnKey: false });
    renderModelSel();
  }
}
async function refreshQuota() {
  if (!currentUser) return;
  const r = await window.api.call('GET', '/aidesk/billing/quota');
  if (!r.ok) return;
  quota = r.data;
  renderQuota();
  renderModelSel();
}
function renderQuota() {
  const chip = $('quotaChip');
  chip.classList.toggle('hidden', !quota || !currentUser);
  if (!quota) return;
  const name = (lang() === 'en' && quota.planNameEn) || quota.planName || '-';
  $('quotaPlan').textContent = name;
  const total = quota.dailyQuota + quota.monthlyQuota + quota.extraTokens;
  const pct = total > 0 ? Math.min(100, (quota.remaining / total) * 100) : 0;
  $('quotaBar').style.width = pct + '%';
  chip.classList.toggle('low', pct < 10);
  const key = quota.dailyQuota > 0 && quota.monthlyQuota === 0 ? 'quotaLeftToday' : 'quotaLeftMonth';
  $('quotaText').textContent = T(key, { n: fmtTok(quota.remaining) });
}
function quotaDetailHtml(q) {
  if (!q) return '';
  const name = (lang() === 'en' && q.planNameEn) || q.planName || '-';
  const rows = [`<div><b>${esc(T('planLine', { plan: name }))}</b>${q.expireTime ? ` <span class="hint">${esc(T('expireAt', { t: q.expireTime }))}</span>` : ''}</div>`];
  if (q.dailyQuota) rows.push(`<div class="hint">${esc(T('quotaDaily', { used: fmtTok(q.dailyUsed), quota: fmtTok(q.dailyQuota) }))}</div>`);
  if (q.monthlyQuota) rows.push(`<div class="hint">${esc(T('quotaMonthly', { used: fmtTok(q.monthlyUsed), quota: fmtTok(q.monthlyQuota), t: q.monthlyResetTime || '-' }))}</div>`);
  if (q.extraTokens) rows.push(`<div class="hint">${esc(T('quotaExtra', { n: fmtTok(q.extraTokens) }))}</div>`);
  rows.push(`<div class="hint">${esc(T('quotaRemaining', { n: fmtTok(q.remaining) }))}</div>`);
  return rows.join('');
}
$('upgradeBtn').onclick = () => openPlans();

function showPlatformError(evt) {
  const d = document.createElement('div');
  d.className = 'msg error';
  d.textContent = evt.code === 'plan_required' ? T('needLevel', { level: levelName(evt.data?.requiredLevel || 1) }) : evt.text;
  if (evt.code === 'plan_required' || evt.code === 'quota_exceeded') {
    const b = document.createElement('button');
    b.className = 'primary small upgrade-inline';
    b.textContent = T('upgrade');
    b.onclick = () => openPlans(evt.code, evt.data?.requiredLevel);
    d.appendChild(b);
  }
  append(d);
  refreshQuota();
  // 额度用完：直接打开会员弹窗（每次启动最多自动弹一次，之后点消息里的「升级」按钮）
  if (evt.code === 'quota_exceeded' && !quotaPromptShown && document.querySelectorAll('.modal:not(.hidden)').length === 0) {
    quotaPromptShown = true;
    openPlans('quota_exceeded');
  }
}
let quotaPromptShown = false;

// 会员开通弹窗
let plansCache = [];
let plansPromo = null; // 首月优惠 { planCode, priceCents }
let planPeriod = 'month';
async function openPlans(reason, requiredLevel) {
  $('planReason').textContent = reason === 'plan_required' ? T('needLevel', { level: levelName(requiredLevel || 1) }) : reason === 'quota_exceeded' ? T('err_quota_exceeded') : T('membershipHint');
  $('orderBox').classList.add('hidden');
  $('planModal').classList.remove('hidden');
  const [r, ch] = await Promise.all([window.api.call('GET', '/aidesk/billing/plans'), window.api.call('GET', '/aidesk/pay/channels')]);
  if (r.ok) {
    plansCache = r.data.plans;
    plansPromo = r.data.promo || null;
  }
  payChannels = ch.ok ? ch.data.channels || [] : [];
  payManual = ch.ok ? ch.data.manual || {} : {};
  renderPlans();
  loadOrders();
}
function renderPlans() {
  document.querySelectorAll('.period-switch button').forEach((b) => b.classList.toggle('active', b.dataset.period === planPeriod));
  const card = (p) => {
    const isCurrent = quota && quota.planCode === p.code;
    const per = p.kind === 'pack' ? '' : p.period === 'year' ? T('perYear') : p.period === 'month' ? T('perMonth') : '';
    const quotaText = p.kind === 'pack' ? T('packTokens', { n: fmtTok(p.tokenAmount) })
      : p.dailyTokenQuota ? T('dailyTokens', { n: fmtTok(p.dailyTokenQuota) }) : T('monthlyTokens', { n: fmtTok(p.monthlyTokenQuota) });
    const btn = p.priceCents > 0 ? `<button class="${p.level === 2 ? 'primary' : 'ghost'}" data-code="${esc(p.code)}">${esc(T(p.kind === 'pack' ? 'buy' : isCurrent ? 'renew' : 'subscribe'))}</button>` : '';
    return `<div class="plan${isCurrent ? ' current' : ''}${p.level === 2 && p.kind !== 'pack' ? ' recommend' : ''}">
      ${isCurrent ? `<span class="tag">${esc(T('currentPlan'))}</span>` : p.level === 2 && p.kind !== 'pack' ? `<span class="tag">${esc(T('recommended'))}</span>` : ''}
      <div class="pn">${esc((lang() === 'en' && p.nameEn) || p.name)}</div>
      ${plansPromo && plansPromo.planCode === p.code
        ? `<div class="pp">¥${yuan(plansPromo.priceCents)}<small>${esc(T('firstMonth'))}</small> <s class="pp-old">¥${yuan(p.priceCents)}</s></div><div class="pp-note">${esc(T('firstMonthNote', { price: yuan(p.priceCents) }))}</div>`
        : `<div class="pp">¥${yuan(p.priceCents)}<small>${esc(per)}</small></div>`}
      <div class="pd">${esc(quotaText)}<br>${p.kind === 'pack' ? '' : esc(T('devicesN', { n: p.maxDevices })) + '<br>'}${esc((lang() === 'en' && p.descriptionEn) || p.description || '')}</div>
      ${btn}</div>`;
  };
  const subs = plansCache.filter((p) => p.kind !== 'pack' && (p.level === 0 || p.period === planPeriod));
  $('planGrid').innerHTML = subs.map(card).join('');
  $('packGrid').innerHTML = plansCache.filter((p) => p.kind === 'pack').map(card).join('');
  document.querySelectorAll('#planGrid button[data-code], #packGrid button[data-code]').forEach((b) => (b.onclick = () => createOrder(b.dataset.code)));
}
document.querySelectorAll('.period-switch button').forEach((b) => (b.onclick = () => ((planPeriod = b.dataset.period), renderPlans())));
$('planClose').onclick = () => $('planModal').classList.add('hidden');

let payChannels = []; // 服务端开放的支付方式；空 = 还没接在线支付，走「联系客服付款」
let payManual = {}; // 联系客服付款时显示的内容：{wechat 客服微信号, qr 客服二维码, payQr 收款码, note 说明}（管理后台参数设置里配）
async function createOrder(planCode) {
  const r = await window.api.call('POST', '/aidesk/billing/orders', { planCode, units: 1 });
  const box = $('orderBox');
  if (!r.ok) return (box.classList.remove('hidden'), (box.textContent = T('err_' + r.error)));
  const o = r.data.order;
  loadOrders();
  if (payChannels.includes('wechat')) return payOrder(o.orderNo);
  showManualPay(o, true);
}
// 还没接在线支付：显示订单号（可复制）、收款码、客服微信，让用户转账时备注订单号，客服确认收款后开通
function showManualPay(o, justCreated) {
  const box = $('orderBox');
  box.classList.remove('hidden');
  const m = payManual || {};
  // 客服微信可能配了好几个（「A 或 B」「A、B」），拆开分别显示、分别复制
  const wechats = String(m.wechat || '').split(/\s*(?:或|、|,|，|\/|\s)\s*/).map((x) => x.trim()).filter(Boolean);
  const img = (src, label) => (/^https?:\/\//.test(src || '') ? `<figure class="pay-img"><img src="${esc(src)}" alt="" data-zoom="${esc(src)}" title="${esc(T('payQrZoom'))}"><figcaption>${esc(label)}</figcaption>
    <div class="pay-img-acts"><button class="ghost small" data-zoom="${esc(src)}">${esc(T('payQrZoom'))}</button><button class="ghost small" data-save="${esc(src)}">${esc(T('payQrSave'))}</button></div></figure>` : '');
  const copyBtn = (v, label) => `<button class="ghost small" data-copy="${esc(v)}">${esc(label || T('copy'))}</button>`;
  box.innerHTML = `<b>${esc(T(justCreated ? 'orderCreated' : 'manualPayTitle'))}</b>
    <div class="pay-sorry">${esc(T('paySorry'))}</div>
    <div class="manual-row">${esc(T('orderInfo', { no: o.orderNo, plan: o.planName || '', amount: yuan(o.amountCents) }))} ${copyBtn(o.orderNo, T('copyOrderNo'))}</div>
    <div class="pay-step"><b>${esc(T('payStep1'))}</b><div class="hint">${esc(T('payStep1Hint', { amount: yuan(o.amountCents) }))}</div>
      ${m.payQr ? `<div class="pay-imgs">${img(m.payQr, T('manualPayQr'))}</div>` : `<div class="hint">${esc(T('payPending'))}</div>`}</div>
    <div class="pay-step"><b>${esc(T('payStep2'))}</b>
      <div class="pay-way"><div><b>${esc(T('payWay1'))}</b><span class="tag-rec">${esc(T('payRecommended'))}</span></div>
        <div class="hint">${esc(T('payWay1Hint'))}</div>
        <div class="manual-row"><button class="primary small" data-proof="${esc(o.orderNo)}">${esc(T('proofUpload'))}</button><span class="hint" id="proofResult"></span></div></div>
      ${wechats.length || m.qr ? `<div class="pay-way"><div><b>${esc(T('payWay2'))}</b></div>
        <div class="hint">${esc(T('payWay2Hint'))}</div>
        ${wechats.map((w) => `<div class="manual-row">${esc(T('supportWechatId'))}<code class="wx-id">${esc(w)}</code>${copyBtn(w)}</div>`).join('')}
        ${m.qr ? `<div class="pay-imgs">${img(m.qr, T('manualSupportQr'))}</div>` : ''}</div>` : ''}
    </div>`;
  box.querySelector('[data-proof]').onclick = () => pickProof(o.orderNo);
  box.querySelectorAll('[data-zoom]').forEach((el) => (el.onclick = () => zoomQr(el.dataset.zoom)));
  box.querySelectorAll('[data-save]').forEach((el) => (el.onclick = async () => {
    if (await window.api.imageSaveUrl(el.dataset.save)) showToast(T('payQrSaved'), 'ok');
  }));
  box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); showToast(T('copied'), 'info'); } catch {}
  }));
}

// 收款码放大：盖住整个窗口，方便手机扫；点空白处或按 Esc 关闭
function zoomQr(src) {
  let v = document.getElementById('qrZoom');
  if (!v) {
    v = document.createElement('div');
    v.id = 'qrZoom';
    v.className = 'qr-zoom';
    v.innerHTML = `<img alt=""><p></p><div class="qr-zoom-acts"><button class="primary" data-act="save"></button><button class="ghost" data-act="close"></button></div>`;
    document.body.appendChild(v);
    v.onclick = (e) => { if (e.target === v || e.target.dataset.act === 'close') v.remove(); };
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape' && document.getElementById('qrZoom')) { document.getElementById('qrZoom').remove(); } });
  }
  v.querySelector('img').src = src;
  v.querySelector('p').textContent = T('payQrZoomHint');
  v.querySelector('[data-act="save"]').textContent = T('payQrSave');
  v.querySelector('[data-act="close"]').textContent = T('close');
  v.querySelector('[data-act="save"]').onclick = async () => { if (await window.api.imageSaveUrl(src)) showToast(T('payQrSaved'), 'ok'); };
}

// ---------- 微信扫码付款：显示二维码，每 2 秒查一次订单，付了就开通 ----------
let payPoll = null;
function stopPay() {
  clearTimeout(payPoll);
  payPoll = null;
}
async function payOrder(orderNo) {
  stopPay();
  const qrBox = $('payQr');
  const st = $('payStatus');
  qrBox.className = 'pay-qr';
  qrBox.textContent = T('payLoading');
  st.className = 'pay-status';
  st.textContent = '';
  $('payPlan').textContent = '';
  $('payAmount').textContent = '';
  $('payModal').classList.remove('hidden');
  const r = await window.api.call('POST', '/aidesk/pay/wechat/' + encodeURIComponent(orderNo));
  if (!r.ok) {
    qrBox.textContent = '';
    st.className = 'pay-status err';
    st.textContent = T(r.error === 'order_expired' ? 'payExpired' : r.error === 'order_not_pending' ? 'payNotPending' : 'payFailed');
    return;
  }
  $('payPlan').textContent = r.data.planName || '';
  $('payAmount').textContent = '¥' + yuan(r.data.amountCents);
  const img = await window.api.makeQr(r.data.codeUrl);
  qrBox.innerHTML = img ? `<img src="${img}" alt="">` : '';
  st.textContent = T('payScan');
  const expireAt = r.data.expireAt || Date.now() + 30 * 60000;
  const tick = async () => {
    if ($('payModal').classList.contains('hidden')) return stopPay();
    if (Date.now() > expireAt) {
      qrBox.textContent = '';
      st.className = 'pay-status err';
      st.textContent = T('payExpired');
      return stopPay();
    }
    const s = await window.api.call('GET', '/aidesk/pay/orders/' + encodeURIComponent(orderNo));
    if (s.ok && s.data.status === 'paid') {
      stopPay();
      qrBox.className = 'pay-qr done';
      qrBox.innerHTML = `<span class="ok">✓</span><span>${esc(T('paySuccess'))}</span>`;
      st.textContent = T('payActivated');
      refreshQuota();
      loadOrders();
      if (!$('planModal').classList.contains('hidden')) openPlans();
      return;
    }
    payPoll = setTimeout(tick, 2000);
  };
  payPoll = setTimeout(tick, 2000);
}
$('payClose').onclick = () => {
  stopPay();
  $('payModal').classList.add('hidden');
};

// 上传付款截图：压缩成长边 1600 的 JPEG 发给服务端，AI 核对后通知客服确认（预审通过的先开 8 小时临时会员）
let proofFor = null;
const proofInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
document.body.appendChild(proofInput);
function pickProof(orderNo) {
  proofFor = orderNo;
  proofInput.value = '';
  proofInput.click();
}
async function shrinkToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
proofInput.onchange = async () => {
  const f = proofInput.files[0];
  if (!f || !proofFor) return;
  const out = $('proofResult');
  const say = (t, cls) => {
    if (out) {
      out.textContent = t;
      out.className = 'hint ' + (cls || '');
    } else showToast(t, cls === 'bad' ? 'error' : 'info');
  };
  say(T('proofChecking'));
  let image;
  try {
    image = await shrinkToDataUrl(f);
  } catch {
    return say(T('proofBadImage'), 'bad');
  }
  const r = await window.api.call('POST', '/aidesk/support/proof', { orderNo: proofFor, image });
  if (!r.ok) return say(r.data?.message || T('err_' + r.error), 'bad');
  const d = r.data;
  if (d.pass) say(T(d.provisional ? 'proofPassProvisional' : 'proofPass'), 'ok');
  else say(T('proofFail', { why: (d.fails || []).join('；') }), 'bad');
  loadOrders();
  if (d.provisional) refreshQuota();
};

async function loadOrders() {
  const [r, pr] = await Promise.all([window.api.call('GET', '/aidesk/billing/orders'), window.api.call('GET', '/aidesk/support/proofs')]);
  if (!r.ok) return;
  const proofs = pr.ok ? pr.data.proofs || [] : [];
  // 待付款订单传过截图的，显示核对状态（核对中 / 被驳回）
  const proofTag = (o) => {
    const p = proofs.find((x) => x.orderNo === o.orderNo);
    return p ? ` <span class="proof-tag ${p.status}">${esc(T('proofStatus_' + p.status))}</span>` : '';
  };
  const canPay = (o) => o.status === 'pending' && payChannels.includes('wechat') && Date.now() - new Date(String(o.createTime).replace(' ', 'T') + '+08:00').getTime() < 29 * 60000;
  $('orderList').innerHTML = r.data.orders.length
    ? `<table class="tbl">${r.data.orders.map((o, i) => `<tr><td><span class="order-no" data-copy-no="${esc(o.orderNo)}" title="${esc(T('copyOrderNo'))}">${esc(o.orderNo)}</span></td><td>${esc(o.planName || '')}</td><td class="num">¥${yuan(o.amountCents)}</td><td>${canPay(o) ? `<button class="ghost small" data-pay="${esc(o.orderNo)}">${esc(T('payNow'))}</button>` : o.status === 'pending' && !payChannels.includes('wechat') ? `<button class="ghost small" data-manual="${i}">${esc(T('manualPayHow'))}</button>${proofTag(o)}` : esc(T('orderStatus_' + o.status))}</td><td>${esc(o.createTime || '')}</td></tr>`).join('')}</table>`
    : `<div class="hint">${esc(T('noOrders'))}</div>`;
  $('orderList').querySelectorAll('[data-pay]').forEach((b) => (b.onclick = () => payOrder(b.dataset.pay)));
  // 点订单号就复制（发给客服、转账备注用）
  $('orderList').querySelectorAll('[data-copy-no]').forEach((el) => (el.onclick = async () => {
    try {
      await navigator.clipboard.writeText(el.dataset.copyNo);
      showToast(T('copied'), 'info');
    } catch {}
  }));
  // 待人工确认收款的订单：点「怎么付款」再看一次订单号、收款码和客服
  $('orderList').querySelectorAll('[data-manual]').forEach((b) => (b.onclick = () => showManualPay(r.data.orders[Number(b.dataset.manual)], false)));
}

// ---------- 关于 / 检查更新 ----------
let fullUpdateUrl = null;

async function loadAbout() {
  const info = await window.api.updateInfo();
  $('aboutVersion').textContent = T('currentVersion', { v: info.version });
  $('aboutShell').textContent = info.patched ? T('shellVersionLine', { v: info.shellVersion }) : '';
  if (info.staged) showUpdateState({ status: 'ready', version: info.staged });
}
function showUpdateState(r) {
  $('restartUpdateBtn').classList.toggle('hidden', r.status !== 'ready');
  $('downloadFullBtn').classList.toggle('hidden', r.status !== 'full' || !r.url);
  $('checkUpdateBtn').classList.toggle('hidden', r.status === 'ready');
  const msg = {
    latest: [true, T('upToDate')],
    ready: [true, T('updateReady', { v: r.version })],
    full: [false, T('needFullUpdate', { v: r.version })],
    error: [false, T('updateError', { e: r.error })],
  }[r.status];
  if (msg) {
    $('updateStatus').className = 'form-msg ' + (msg[0] ? 'ok' : 'err');
    $('updateStatus').textContent = msg[1];
  }
  const notes = (lang() === 'en' ? r.notesEn : r.notes) || '';
  $('updateNotes').classList.toggle('hidden', !notes || r.status === 'latest');
  $('updateNotes').textContent = notes;
  fullUpdateUrl = r.url || null;
}
$('checkUpdateBtn').onclick = async () => {
  $('checkUpdateBtn').disabled = true;
  $('updateStatus').className = 'form-msg';
  $('updateStatus').textContent = T('checkingUpdate');
  try {
    showUpdateState(await window.api.checkUpdate());
  } finally {
    $('checkUpdateBtn').disabled = false;
  }
};
async function restartToUpdate() {
  if (!(await window.api.restartToUpdate())) alert(T('busyNoRestart'));
}
$('restartUpdateBtn').onclick = restartToUpdate;
$('downloadFullBtn').onclick = () => fullUpdateUrl && window.api.openExternal(fullUpdateUrl);

// 后台下载好补丁后的横幅
// ---------- MCP ----------
let mcpStatus = [];
let mcpSecrets = {}; // 服务名 -> 已保存的密钥名（只有名字，没有值）
const installProgress = {}; // runtime -> { phase, pct, error, version }
const MCP_EXAMPLE = {
  mcpServers: {
    memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
    remote: { url: 'https://example.com/mcp' },
  },
};
function progressText(rt, name) {
  const p = installProgress[rt] || {};
  const phase = T('rtPhase_' + (p.phase || 'resolve'));
  return T('mcpInstalling', { runtime: name, phase: phase + (p.phase === 'download' && p.pct != null ? ` ${p.pct}%` : '') });
}
function mcpStateText(s) {
  if (s.status === 'ready') return T('mcpReady', { n: s.tools.length });
  if (s.status === 'missing') return T('mcpMissing', { runtime: s.runtimeName });
  if (s.status === 'installing') return progressText(s.missing, s.runtimeName);
  return T('mcpSt_' + s.status);
}
function renderMcpList() {
  const box = $('mcpList');
  if (!box) return;
  box.innerHTML = mcpStatus.length ? '' : `<div class="hint">${esc(T('mcpEmpty'))}</div>`;
  for (const s of mcpStatus) {
    const el = document.createElement('div');
    el.className = 'mcp-item';
    const on = s.status !== 'disabled';
    const err = installProgress[s.missing]?.phase === 'error' ? installProgress[s.missing].error : '';
    let need = '';
    if (s.status === 'missing') {
      need = `<div class="need">${esc(T(s.canInstall ? 'mcpNeedInstallAuto' : 'mcpNeedInstall', { runtime: s.runtimeName }))}
        ${s.canInstall ? `<button class="primary small one">${esc(T('mcpOneClick'))}</button>` : ''}
        <button class="${s.canInstall ? 'ghost' : 'primary'} small inst">${esc(T(s.canInstall ? 'mcpManual' : 'mcpInstall', { runtime: s.runtimeName }))}</button>
        <button class="ghost small re">${esc(T('mcpRecheck'))}</button>
        ${err ? `<div class="err" style="width:100%">${esc(T('mcpInstallFail', { runtime: s.runtimeName, msg: err }))}</div>` : ''}</div>`;
    } else if (s.status === 'auth') {
      need = `<div class="need info">${esc(T('mcpNeedLogin'))} <button class="primary small login">${esc(T('mcpLogin'))}</button></div>`;
    }
    el.innerHTML = `<div class="top"><span class="dot ${esc(s.status)}"></span><span class="nm">${esc(s.name)}</span>
        ${s.remote ? `<span class="remote-tag">${esc(T('mcpRemoteTag'))}</span>` : ''}
        <span class="st">${esc(mcpStateText(s))}</span>
        ${s.remote && s.loggedIn ? `<button class="ghost small logout">${esc(T('mcpLogout'))}</button>` : ''}
        ${on && s.status !== 'installing' && s.status !== 'authorizing' ? `<button class="ghost small re">${esc(T('mcpRestart'))}</button>` : ''}
        <button class="ghost small tg">${esc(T(on ? 'mcpDisable' : 'mcpEnable'))}</button></div>
      <div class="cmd">${esc(s.command)}</div>
      ${mcpSecrets[s.name]?.length ? `<div class="sec">🔒 ${esc(T('mcpSecretsSaved', { keys: mcpSecrets[s.name].join(', ') }))}</div>` : ''}
      ${need}
      ${s.status === 'error' && s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
      ${s.status === 'auth' && s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
      ${s.tools.length ? `<details><summary>${esc(T('mcpTools', { n: s.tools.length }))}</summary><ul>${s.tools
        .map((t) => `<li><code>${esc(t.name)}</code> ${esc(t.description)}</li>`).join('')}</ul></details>` : ''}`;
    el.querySelectorAll('.re').forEach((b) => b.addEventListener('click', async () => (mcpStatus = await window.api.mcpRestart(s.name), renderMcpList())));
    el.querySelector('.inst')?.addEventListener('click', () => window.api.openExternal(s.installUrl));
    el.querySelector('.one')?.addEventListener('click', () => installRuntime(s.missing));
    el.querySelector('.login')?.addEventListener('click', async () => (mcpStatus = await window.api.mcpLogin(s.name), renderMcpList()));
    el.querySelector('.logout')?.addEventListener('click', async () => (mcpStatus = await window.api.mcpLogout(s.name), renderMcpList()));
    el.querySelector('.tg').addEventListener('click', async () => {
      mcpStatus = await window.api.mcpToggle(s.name, !on);
      renderMcpList();
      const r = await window.api.mcpGet();
      $('mcpConfig').value = JSON.stringify({ mcpServers: r.config }, null, 2);
    });
    box.appendChild(el);
  }
}
function installRuntime(rt) {
  installProgress[rt] = { phase: 'resolve' };
  window.api.mcpInstall(rt);
  renderMcpList();
  renderMcpBanners();
}
function onRuntimeInstall(evt) {
  installProgress[evt.runtime] = evt;
  renderConnectors();
  renderMcpList();
  renderMcpBanners();
}
// 缺少运行环境时：
//  - 「全部自动执行」模式：主进程直接安装，这里只显示进度；
//  - 其他模式：弹窗问用户要不要装（每种环境每次启动只问一次），不装就在顶部留提示条。
const mcpBannerDismissed = new Set();
const mcpAsked = new Set();
function missingByRuntime() {
  const by = {};
  for (const s of mcpStatus) if (s.status === 'missing' || s.status === 'installing') (by[s.missing] ||= { ...s, names: [] }).names.push(s.name);
  return by;
}
function renderMcpBanners() {
  const box = $('mcpBanners');
  box.innerHTML = '';
  for (const [rt, r] of Object.entries(missingByRuntime())) {
    const p = installProgress[rt];
    const busy = r.status === 'installing' || (p && !['done', 'error'].includes(p.phase));
    if (!busy && mcpBannerDismissed.has(rt)) continue;
    const el = document.createElement('div');
    el.className = 'banner warning';
    if (busy) {
      el.innerHTML = `<div class="bt"><b>${esc(progressText(rt, r.runtimeName))}</b>${esc(T('mcpInstallingBody', { names: r.names.join('、') }))}</div>`;
    } else {
      const failed = p?.phase === 'error' ? T('mcpInstallFail', { runtime: r.runtimeName, msg: p.error }) : '';
      el.innerHTML = `<div class="bt"><b>${esc(T('mcpBannerTitle', { runtime: r.runtimeName }))}</b>${esc(failed || T('mcpBannerBody', { names: r.names.join('、'), runtime: r.runtimeName }))}</div>
        ${r.canInstall ? `<button class="one">${esc(T('mcpOneClick'))}</button>` : ''}
        <button class="i">${esc(T(r.canInstall ? 'mcpManual' : 'mcpInstall', { runtime: r.runtimeName }))}</button><button class="c">${esc(T('mcpRecheck'))}</button><button class="x">${esc(T('dismiss'))}</button>`;
      el.querySelector('.one')?.addEventListener('click', () => installRuntime(rt));
      el.querySelector('.i').onclick = () => window.api.openExternal(r.installUrl);
      el.querySelector('.c').onclick = async () => {
        for (const n of r.names) mcpStatus = await window.api.mcpRestart(n);
        renderMcpBanners();
      };
      el.querySelector('.x').onclick = () => {
        mcpBannerDismissed.add(rt);
        el.remove();
      };
    }
    box.appendChild(el);
  }
  askToInstall();
}
function askToInstall() {
  if (($('approvalSel').value || settings.approval) === 'all') return; // 主进程会自动装
  if (!$('askModal').classList.contains('hidden') || !$('confirmModal').classList.contains('hidden')) return;
  for (const [rt, r] of Object.entries(missingByRuntime())) {
    if (!r.canInstall || r.status !== 'missing' || mcpAsked.has(rt) || installProgress[rt]) continue;
    mcpAsked.add(rt);
    $('askTitle').textContent = T('mcpAskTitle', { runtime: r.runtimeName });
    $('askBody').textContent = T('mcpAskBody', { names: r.names.join('、'), runtime: r.runtimeName });
    $('askYes').textContent = T('mcpAskYes');
    $('askNo').textContent = T('mcpAskNo');
    $('askModal').classList.remove('hidden');
    $('askYes').onclick = () => {
      $('askModal').classList.add('hidden');
      installRuntime(rt);
    };
    $('askNo').onclick = () => {
      $('askModal').classList.add('hidden');
      askToInstall(); // 可能还有别的环境要问
    };
    return;
  }
}
async function loadMcp() {
  const r = await window.api.mcpGet();
  mcpStatus = r.status;
  mcpSecrets = r.secrets || {};
  $('mcpConfig').value = Object.keys(r.config).length ? JSON.stringify({ mcpServers: r.config }, null, 2) : '';
  $('mcpConfig').placeholder = JSON.stringify(MCP_EXAMPLE, null, 2);
  $('mcpMsg').textContent = '';
  renderMcpList();
}
$('mcpSave').onclick = async () => {
  const r = await window.api.mcpSave($('mcpConfig').value);
  $('mcpMsg').className = 'form-msg ' + (r.ok ? 'ok' : 'err');
  $('mcpMsg').textContent = r.ok ? T('mcpSaved') : r.error;
  if (r.ok) {
    mcpStatus = r.status;
    renderMcpList();
    renderMcpBanners();
  }
};
$('mcpExample').onclick = () => {
  $('mcpConfig').value = JSON.stringify(MCP_EXAMPLE, null, 2);
  $('mcpMsg').textContent = '';
};

// ---------- 安全输入框 ----------
function showSecretRequest(evt) {
  $('secretTitle').textContent = T('secretTitle', { title: evt.title, server: evt.server });
  $('secretDesc').textContent = evt.description || '';
  const help = $('secretHelp');
  help.classList.toggle('hidden', !evt.helpUrl);
  help.textContent = T('secretHelp');
  help.onclick = () => window.api.openExternal(evt.helpUrl);
  $('secretNote').textContent = T('secretNote');
  $('secretInput').value = '';
  $('secretInput').type = 'password';
  $('secretShow').textContent = T('secretShow');
  $('secretShow').onclick = () => {
    const hidden = $('secretInput').type === 'password';
    $('secretInput').type = hidden ? 'text' : 'password';
    $('secretShow').textContent = T(hidden ? 'secretHide' : 'secretShow');
  };
  $('secretOk').textContent = T('save');
  $('secretCancel').textContent = T('cancel');
  $('secretModal').classList.remove('hidden');
  setTimeout(() => $('secretInput').focus(), 50);
  const done = (value) => {
    $('secretModal').classList.add('hidden');
    $('secretInput').value = '';
    window.api.secretReply(evt.id, value);
  };
  $('secretOk').onclick = () => {
    const v = $('secretInput').value.trim();
    if (v) done(v);
  };
  $('secretCancel').onclick = () => done(null);
  $('secretInput').onkeydown = (e) => {
    if (e.key === 'Enter') $('secretOk').click();
    if (e.key === 'Escape') done(null);
  };
}

// 发送前检查：消息里像是密码 / Token，提醒用户（内容会发给模型厂商并保存在聊天记录里）
const SECRET_PATTERNS = [
  /(密码|口令|password|passwd|pwd)\s*(是|为|[:：=])\s*\S{4,}/i,
  /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[bpa]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.)/,
];
const looksSecret = (text) => SECRET_PATTERNS.some((r) => r.test(text));
function confirmSendSecret() {
  return new Promise((resolve) => {
    $('askTitle').textContent = T('secretWarnTitle');
    $('askBody').textContent = T('secretWarnBody');
    $('askYes').textContent = T('secretWarnBack');
    $('askNo').textContent = T('secretWarnSend');
    $('askModal').classList.remove('hidden');
    $('askYes').onclick = () => {
      $('askModal').classList.add('hidden');
      resolve(false);
    };
    $('askNo').onclick = () => {
      $('askModal').classList.add('hidden');
      resolve(true);
    };
  });
}

// ---------- 连接器 ----------
let connList = [];
let connConfig = {};
let connTab = 'discover';
let connMode = 'mcp'; // mcp 连接器 / skill 技能
let skillList = [];
const skillBusy = new Set();
let connCat = 'all';
const connBusy = new Set();
const CONN_CATS = ['all', 'featured', 'office', 'dev', 'design', 'map', 'search', 'other'];
const cName = (c) => (lang() === 'en' && c.nameEn) || c.name;
const cDesc = (c) => (lang() === 'en' && c.descriptionEn) || c.description || '';
// 随客户端打包的连接器 / 技能图标（src/renderer/connector-icons/<code>.png，128px）
const BUNDLED_ICONS = new Set(
  ('amap atlassian baidu-map bocha context7 didi fetch figma gitee github linear memory minimax notion pixso sentry ' +
    'sequential-thinking skill-docx skill-flyai skill-frontend-design skill-kdocs skill-lark skill-pdf skill-pptx skill-qqmail ' +
    'skill-taobao skill-xlsx tencent-docs tencent-map tianyancha time yuque zhipu-search').split(' ')
);
function connIcon(c) {
  if (c.code && BUNDLED_ICONS.has(c.code)) return `<div class="conn-ico img"><img src="connector-icons/${esc(c.code)}.png" alt=""></div>`;
  if (c.icon && /^https:\/\//.test(c.icon)) return `<div class="conn-ico img"><img src="${esc(c.icon)}" alt=""></div>`;
  const color = /^#[0-9a-fA-F]{3,8}$/.test(c.color || '') ? c.color : '#64748B';
  return `<div class="conn-ico" style="background:${color};border-color:${color}">${esc((cName(c) || '?').slice(0, 1).toUpperCase())}</div>`;
}
async function openConnectors(tab) {
  connTab = tab || connTab;
  $('connModal').classList.remove('hidden');
  refreshSkills().then(() => connMode === 'skill' && renderConnectors());
  const r = await window.api.connectorList(false);
  applyConnData(r);
  renderConnectors();
  // 后台刷新一次目录（服务器上新增的连接器）
  window.api.connectorList(true).then((r2) => {
    applyConnData(r2);
    renderConnectors();
  });
}
let connLoadFailed = false;
let skillCatalog = [];
function applyConnData(r) {
  connList = r.connectors || [];
  skillCatalog = connList.filter((c) => c.kind === 'skill');
  connList = connList.filter((c) => c.kind !== 'skill');
  connLoadFailed = !!r.loadFailed;
  mcpStatus = r.status || mcpStatus;
  connConfig = r.config || {};
}
function connState(code) {
  return mcpStatus.find((s) => s.name === code);
}
function renderConnectors() {
  if ($('connModal').classList.contains('hidden')) return;
  document.querySelectorAll('#connModes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === connMode));
  $('connCustom').classList.toggle('hidden', connMode !== 'mcp');
  $('skillInstallBtn').classList.toggle('hidden', connMode !== 'skill');
  $('connSearch').placeholder = T(connMode === 'skill' ? 'skillSearch' : 'connSearch');
  document.querySelector('#connTabs [data-ctab=mine]').textContent = T(connMode === 'skill' ? 'skillMine' : 'connMine');
  if (connMode === 'skill') return renderSkills();
  document.querySelectorAll('#connTabs button').forEach((b) => b.classList.toggle('active', b.dataset.ctab === connTab));
  $('connCats').classList.toggle('hidden', connTab !== 'discover');
  $('connCats').innerHTML = CONN_CATS.filter((c) => c === 'all' || c === 'featured' || connList.some((x) => x.category === c))
    .map((c) => `<button data-cat="${c}" class="${c === connCat ? 'active' : ''}">${esc(T(c === 'all' ? 'connAll' : c === 'featured' ? 'connFeatured' : 'cat_' + c))}</button>`).join('');
  $('connCats').querySelectorAll('button').forEach((b) => (b.onclick = () => ((connCat = b.dataset.cat), renderConnectors())));
  const q = $('connSearch').value.trim().toLowerCase();
  const match = (c) => !q || [c.name, c.nameEn, c.description, c.descriptionEn, c.publisher, c.code].some((v) => (v || '').toLowerCase().includes(q));
  let items;
  if (connTab === 'discover') {
    items = connList.filter((c) => (connCat === 'all' || (connCat === 'featured' ? c.featured : c.category === connCat)) && match(c));
  } else {
    // 已添加：目录里的 + 用户自己配置的（自定义）
    const added = Object.keys(connConfig);
    items = added.map((name) => connList.find((c) => c.code === name) || { code: name, name, custom: true, description: connState(name)?.command || '' }).filter(match);
  }
  const grid = $('connGrid');
  if (connTab === 'discover' && connLoadFailed) {
    grid.innerHTML = `<div class="conn-empty">${esc(T('connLoadFailed'))}<br><br><button class="primary small" id="connRetry">${esc(T('connRetry'))}</button></div>`;
    $('connRetry').onclick = async () => {
      applyConnData(await window.api.connectorList(true));
      renderConnectors();
    };
    return;
  }
  grid.innerHTML = items.length ? '' : `<div class="conn-empty">${esc(T(connTab === 'mine' && !q ? 'connMineEmpty' : 'connEmpty'))}</div>`;
  for (const c of items) {
    const st = connState(c.code);
    const added = !!connConfig[c.code];
    const el = document.createElement('div');
    el.className = 'conn-item';
    const tags = [];
    if (c.custom) tags.push(`<span class="conn-tag">${esc(T('connCustomTag'))}</span>`);
    if (c.scope === 'enterprise') tags.push(`<span class="conn-tag ent" title="${esc(T('connEnterpriseHint'))}">${esc(T('connEnterprise'))}</span>`);
    if (!added && c.authType === 'oauth') tags.push(`<span class="conn-tag">${esc(T('connNeedLogin'))}</span>`);
    if (!added && c.authType === 'secret') tags.push(`<span class="conn-tag">${esc(T('connNeedKey'))}</span>`);
    if (!added && c.transport === 'local') tags.push(`<span class="conn-tag">${esc(T('connLocal'))}</span>`);
    // 右侧只放按钮；状态文字放在名称下方（长的状态文字不会把卡片挤变形）
    let act = '';
    let stateLine = '';
    if (connBusy.has(c.code)) stateLine = `<div class="conn-state"><span class="dot starting"></span>${esc(T('connAdding'))}</div>`;
    else if (!added) act = `<button class="primary conn-plus" title="${esc(T('connAdd'))}">+</button>`;
    else {
      const ready = st?.status === 'ready';
      stateLine = `<div class="conn-state"><span class="dot ${esc(st?.status || 'starting')}"></span>${esc(ready ? T('connAdded') + (st.tools.length ? ` · ${T('mcpTools', { n: st.tools.length })}` : '') : st ? mcpStateText(st) : T('mcpSt_starting'))}</div>`;
      if (st?.status === 'auth') act += `<button class="primary small c-login">${esc(T('mcpLogin'))}</button>`;
      if (st?.status === 'missing' && st.canInstall) act += `<button class="primary small c-inst">${esc(T('mcpOneClick'))}</button>`;
      if (st?.status === 'error') act += `<button class="ghost small c-re">${esc(T('mcpRestart'))}</button>`;
      act += `<button class="ghost small c-rm">${esc(T('connRemove'))}</button>`;
    }
    el.innerHTML = `${c.custom ? connIcon({ name: c.name, color: '#64748B' }) : connIcon(c)}
      <div class="conn-body">
        <div class="conn-name">${esc(cName(c))} ${tags.join('')}</div>
        ${stateLine}
        <div class="conn-desc" title="${esc(cDesc(c))}">${esc(cDesc(c))}</div>
        <div class="conn-meta">${c.publisher ? esc(T('connBy', { who: c.publisher })) : ''}${c.helpUrl ? ` · <a class="c-help">${esc(T('connHelp'))}</a>` : ''}</div>
        ${added && st?.status === 'error' && st.error ? `<div class="err" style="font-size:11px;margin-top:4px;max-height:60px;overflow:auto">${esc(st.error.slice(0, 300))}</div>` : ''}
      </div>
      <div class="conn-act">${act}</div>`;
    el.querySelector('.conn-plus')?.addEventListener('click', () => addConnector(c));
    el.querySelector('.c-login')?.addEventListener('click', async () => ((mcpStatus = await window.api.mcpLogin(c.code)), renderConnectors()));
    el.querySelector('.c-inst')?.addEventListener('click', () => installRuntime(st.missing));
    el.querySelector('.c-re')?.addEventListener('click', async () => ((mcpStatus = await window.api.mcpRestart(c.code)), renderConnectors()));
    el.querySelector('.c-help')?.addEventListener('click', () => window.api.openExternal(c.helpUrl));
    el.querySelector('.c-rm')?.addEventListener('click', async () => {
      if (!confirm(T('connRemoveConfirm', { name: cName(c) }))) return;
      const r = await window.api.connectorRemove(c.code);
      mcpStatus = r.status;
      delete connConfig[c.code];
      renderConnectors();
    });
    grid.appendChild(el);
  }
}
async function addConnector(c) {
  connBusy.add(c.code);
  renderConnectors();
  try {
    const r = await window.api.connectorAdd(c.code);
    if (r.ok) connConfig[c.code] = true;
    else if (r.error) showToast(r.error);
    // 连接状态可能在返回前就通过事件更新过了，这里重新取一次最新的，避免被旧状态覆盖
    mcpStatus = (await window.api.mcpGet()).status;
  } finally {
    connBusy.delete(c.code);
    renderConnectors();
  }
}
// ---------- 技能 ----------
async function refreshSkills() {
  skillList = (await window.api.skillsList()).skills || [];
}
function renderSkills() {
  document.querySelectorAll('#connTabs button').forEach((b) => b.classList.toggle('active', b.dataset.ctab === connTab));
  const q = $('connSearch').value.trim().toLowerCase();
  const match = (...vals) => !q || vals.some((v) => (v || '').toLowerCase().includes(q));
  const grid = $('connGrid');
  if (connTab === 'discover') {
    $('connCats').classList.remove('hidden');
    $('connCats').innerHTML = CONN_CATS.filter((c) => c === 'all' || c === 'featured' || skillCatalog.some((x) => x.category === c))
      .map((c) => `<button data-cat="${c}" class="${c === connCat ? 'active' : ''}">${esc(T(c === 'all' ? 'connAll' : c === 'featured' ? 'connFeatured' : 'cat_' + c))}</button>`).join('');
    $('connCats').querySelectorAll('button').forEach((b) => (b.onclick = () => ((connCat = b.dataset.cat), renderConnectors())));
    if (connLoadFailed) {
      grid.innerHTML = `<div class="conn-empty">${esc(T('connLoadFailed'))}</div>`;
      return;
    }
    const items = skillCatalog.filter((c) => (connCat === 'all' || (connCat === 'featured' ? c.featured : c.category === connCat)) && match(c.name, c.nameEn, c.description, c.descriptionEn, c.publisher));
    grid.innerHTML = items.length ? '' : `<div class="conn-empty">${esc(T('connEmpty'))}</div>`;
    for (const c of items) {
      const installed = skillList.some((s) => s.origin && s.origin === c.url);
      const el = document.createElement('div');
      el.className = 'conn-item';
      const act = skillBusy.has(c.url) ? '' : installed ? '' : `<button class="primary conn-plus" title="${esc(T('connAdd'))}">+</button>`;
      el.innerHTML = `${connIcon(c)}
        <div class="conn-body">
          <div class="conn-name">${esc(cName(c))} ${installed ? `<span class="conn-tag ok">${esc(T('skillInstalledTag'))}</span>` : ''}</div>
          ${skillBusy.has(c.url) ? `<div class="conn-state"><span class="dot starting"></span>${esc(T('skillDownloading'))}</div>` : ''}
          <div class="conn-desc" title="${esc(cDesc(c))}">${esc(cDesc(c))}</div>
          <div class="conn-meta">${c.publisher ? esc(T('connBy', { who: c.publisher })) : ''}${c.helpUrl ? ` · <a class="c-help">${esc(T('connHelp'))}</a>` : ''}</div>
        </div>
        <div class="conn-act">${act}</div>`;
      el.querySelector('.conn-plus')?.addEventListener('click', () => installSkill(c.url));
      el.querySelector('.c-help')?.addEventListener('click', () => window.api.openExternal(c.helpUrl));
      grid.appendChild(el);
    }
    return;
  }
  // 已安装
  $('connCats').classList.add('hidden');
  const items = skillList.filter((s) => match(s.name, s.title, s.description));
  grid.innerHTML = items.length ? '' : `<div class="conn-empty">${esc(T(q ? 'connEmpty' : 'skillMineEmpty'))}</div>`;
  for (const s of items) {
    const cat = skillCatalog.find((c) => c.url === s.origin);
    const el = document.createElement('div');
    el.className = 'conn-item';
    el.innerHTML = `${connIcon(cat ? { ...cat, name: s.title } : { name: s.title, color: '#64748B' })}
      <div class="conn-body">
        <div class="conn-name">${esc(s.title)} <span class="conn-tag">${esc(T(s.source === 'shuttle' ? 'skillSourceShuttle' : 'skillSourceExternal'))}</span>${s.enabled ? '' : ` <span class="conn-tag">${esc(T('skillDisabled'))}</span>`}</div>
        <div class="conn-desc" title="${esc(s.description)}">${esc(s.description)}</div>
        <div class="conn-meta"><a class="c-open">${esc(T('skillOpen'))}</a></div>
      </div>
      <div class="conn-act">
        <button class="ghost small s-tg">${esc(T(s.enabled ? 'skillDisable' : 'skillEnable'))}</button>
        ${s.source === 'shuttle' ? `<button class="ghost small s-rm">${esc(T('skillRemove'))}</button>` : ''}
      </div>`;
    el.querySelector('.c-open').onclick = () => window.api.skillsOpen(s.name);
    el.querySelector('.s-tg').onclick = async () => {
      skillList = (await window.api.skillsToggle(s.name, !s.enabled)).skills;
      renderConnectors();
    };
    el.querySelector('.s-rm')?.addEventListener('click', async () => {
      if (!confirm(T('skillRemoveConfirm', { name: s.title }))) return;
      skillList = (await window.api.skillsRemove(s.name)).skills;
      renderConnectors();
    });
    grid.appendChild(el);
  }
}
async function installSkill(source) {
  skillBusy.add(source);
  renderConnectors();
  try {
    const r = await window.api.skillsInstall(source);
    if (r.ok) {
      skillList = r.skills;
      showToast(T('skillInstalled', { names: r.names.join('、') }), 'ok');
    } else showToast(T('skillInstallFail', { msg: r.error }));
    return r;
  } finally {
    skillBusy.delete(source);
    renderConnectors();
  }
}
document.querySelectorAll('#connModes button').forEach((b) => (b.onclick = async () => {
  connMode = b.dataset.mode;
  connTab = 'discover';
  connCat = 'all';
  if (connMode === 'skill') await refreshSkills();
  renderConnectors();
}));
$('skillInstallBtn').onclick = () => {
  $('skillSource').value = '';
  $('skillMsg').textContent = '';
  $('skillModal').classList.remove('hidden');
  setTimeout(() => $('skillSource').focus(), 50);
};
$('skillCancel').onclick = () => $('skillModal').classList.add('hidden');
$('skillPick').onclick = async () => {
  const dir = await window.api.skillsPickLocal();
  if (dir) $('skillSource').value = dir;
};
$('skillGo').onclick = async () => {
  const src = $('skillSource').value.trim();
  if (!src) return;
  $('skillGo').disabled = true;
  $('skillMsg').className = 'form-msg';
  $('skillMsg').textContent = T('skillDownloading');
  const r = await installSkill(src);
  $('skillGo').disabled = false;
  if (r?.ok) {
    $('skillModal').classList.add('hidden');
    connTab = 'mine';
    renderConnectors();
  } else {
    $('skillMsg').className = 'form-msg err';
    $('skillMsg').textContent = T('skillInstallFail', { msg: r?.error || '' });
  }
};

$('mcpOpenConn').onclick = () => {
  $('settingsModal').classList.add('hidden');
  connMode = 'mcp';
  openConnectors('discover');
};
$('connBtn').onclick = () => openConnectors('discover');
$('connClose').onclick = () => $('connModal').classList.add('hidden');
$('connSearch').oninput = () => renderConnectors();
$('connCustom').onclick = () => {
  $('connModal').classList.add('hidden');
  openSettings('mcp');
};
document.querySelectorAll('#connTabs button').forEach((b) => (b.onclick = () => ((connTab = b.dataset.ctab), renderConnectors())));

function showPatchBanner(evt) {
  $('patchBanner')?.remove();
  const el = document.createElement('div');
  el.id = 'patchBanner';
  el.className = 'banner info';
  el.innerHTML = `<div class="bt"><b>${esc(T('updateReadyBanner', { v: evt.version }))}</b>${esc(((lang() === 'en' ? evt.notesEn : evt.notes) || '').split('\n')[0])}</div>
    <button class="r">${esc(T('restartNow'))}</button><button class="x">${esc(T('dismiss'))}</button>`;
  el.querySelector('.r').onclick = restartToUpdate;
  el.querySelector('.x').onclick = () => el.remove();
  $('banners').prepend(el);
}

async function init() {
  settings = await window.api.getSettings();
  window.api.mcpGet().then((r) => {
    mcpStatus = r.status;
    renderMcpBanners();
  });
  applyI18n();
  renderModelSel();
  renderWorkspace();
  $('approvalSel').value = settings.approval;
  markApproval();
  applyAppearance();
  clearLog();
  setTimeout(() => loadExperts(), 6000); // 主进程启动 5 秒后检测外援，这里稍后再取
  // 一进来先检查登录状态：已登录直接进入，否则显示登录 / 注册页
  const status = await window.api.authStatus();
  document.body.classList.remove('booting');
  if (status.user) enterApp(status.user);
  else {
    showAuth('login');
    if (status.error && status.error !== 'unauthorized') $('loginError').textContent = T('err_' + status.error);
  }
}
init();

// ---------- 语音输入：点麦克风开始 / 结束，或在输入框里按住 Option（Alt）说话 ----------
// 用 AudioContext 采集 PCM（MediaRecorder 只能录 webm，腾讯云不支持），停止后编码成 16k WAV 发给后端识别。
{
  const MAX_SEC = 60;
  let rec = null; // { stream, ctx, node, chunks, started, timer }
  let busy = false; // 识别中
  const btn = $('micBtn');
  const setUi = (state, sec) => {
    btn.classList.toggle('recording', state === 'rec');
    btn.classList.toggle('busy', state === 'busy');
    $('micTime').classList.toggle('hidden', state !== 'rec');
    if (state === 'rec') $('micTime').textContent = `0:${String(sec || 0).padStart(2, '0')}`;
  };
  async function start() {
    if (rec || busy) return;
    if (!(await window.api.micRequest())) return showToast(T('voiceNoMic'));
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      return showToast(T(/NotFound|DevicesNotFound/.test(e.name) ? 'voiceNoDevice' : 'voiceNoMic'));
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    node.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node);
    node.connect(ctx.destination);
    rec = { stream, ctx, node, chunks, started: Date.now() };
    setUi('rec', 0);
    rec.timer = setInterval(() => {
      const sec = Math.floor((Date.now() - rec.started) / 1000);
      setUi('rec', sec);
      if (sec >= MAX_SEC) stop();
    }, 250);
  }
  async function stop() {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearInterval(r.timer);
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    const rate = r.ctx.sampleRate;
    r.ctx.close();
    const samples = r.chunks.reduce((n, c) => n + c.length, 0);
    if (samples < rate * 0.5) {
      setUi('idle');
      return showToast(T('voiceTooShort'));
    }
    busy = true;
    setUi('busy');
    try {
      const wav = window.ShuttleVoice.toWav16k(r.chunks, rate);
      const res = await window.api.call('POST', '/aidesk/asr', { audio: window.ShuttleVoice.bytesToBase64(wav) });
      // api:call 返回 { ok, error, data }
      const text = res && res.ok ? String(res.data.text || '').trim() : '';
      if (res && res.error === 'too_many_requests') showToast(T('voiceBusy'));
      else if (!res || !res.ok) showToast(T('voiceFail', { msg: (res && res.error) || '' }));
      else if (!text) showToast(T('voiceEmpty'));
      else {
        const inp = $('input');
        inp.value = inp.value ? inp.value.replace(/\s*$/, '') + (/[\s，。！？,.!?]$/.test(inp.value) ? '' : ' ') + text : text;
        inp.dispatchEvent(new Event('input'));
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }
    } catch (e) {
      showToast(T('voiceFail', { msg: e.message }));
    } finally {
      busy = false;
      setUi('idle');
    }
  }
  btn.onclick = () => (rec ? stop() : start());
  // 按住 Option / Alt 0.4 秒开始录音，松开结束（只在输入框里、且没有按其他键时生效）
  let holdTimer = null;
  let holding = false;
  $('input').addEventListener('keydown', (e) => {
    if (e.key !== 'Alt' || e.repeat || rec || busy) {
      if (e.key !== 'Alt') clearTimeout(holdTimer);
      return;
    }
    holdTimer = setTimeout(() => {
      holding = true;
      start();
    }, 400);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key !== 'Alt') return;
    clearTimeout(holdTimer);
    if (holding) {
      holding = false;
      stop();
    }
  });
}

// ---------- 设置 → 定时任务 ----------
{
  const WD = () => (lang() === 'en' ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] : ['一', '二', '三', '四', '五', '六', '日']);
  let editingId = null;
  const fmtAt = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  function syncFormFields() {
    const t = $('sfType').value;
    const show = (cls, on) => document.querySelector('#schedForm .' + cls).classList.toggle('hidden', !on);
    show('sf-week', t === 'weekly');
    show('sf-day', t === 'monthly');
    show('sf-time', t === 'daily' || t === 'weekly' || t === 'monthly');
    show('sf-minutes', t === 'interval');
    show('sf-at', t === 'once');
  }
  function openForm(item) {
    editingId = item ? item.id : null;
    const r = item ? item.rule : { type: 'daily', time: '09:00' };
    $('sfTitle').value = item ? item.title : '';
    $('sfPrompt').value = item ? item.prompt : '';
    $('sfType').value = r.type;
    $('sfTime').value = r.time || '09:00';
    $('sfDay').value = r.day || 1;
    $('sfMinutes').value = r.minutes || 60;
    const tomorrow = new Date(Date.now() + 86400000);
    const p = (n) => String(n).padStart(2, '0');
    $('sfAt').value = r.at || `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(tomorrow.getDate())}T09:00`;
    $('sfWeek').innerHTML = WD().map((w, i) => `<button type="button" data-d="${i + 1}" class="${(r.weekdays || [1, 2, 3, 4, 5]).includes(i + 1) ? 'on' : ''}">${esc(w)}</button>`).join('');
    $('sfWeek').querySelectorAll('button').forEach((b) => (b.onclick = () => b.classList.toggle('on')));
    $('sfWs').textContent = (item && item.workspace) || settings.workspace || '';
    $('sfMsg').textContent = '';
    syncFormFields();
    $('schedForm').classList.remove('hidden');
    $('sfTitle').focus();
  }
  $('sfType').onchange = syncFormFields;
  $('schedAdd').onclick = () => openForm(null);
  $('sfCancel').onclick = () => $('schedForm').classList.add('hidden');
  $('sfSave').onclick = async () => {
    const type = $('sfType').value;
    const rule = { type };
    if (type === 'daily' || type === 'weekly' || type === 'monthly') rule.time = $('sfTime').value;
    if (type === 'weekly') rule.weekdays = [...$('sfWeek').querySelectorAll('button.on')].map((b) => Number(b.dataset.d));
    if (type === 'monthly') rule.day = Number($('sfDay').value);
    if (type === 'interval') rule.minutes = Number($('sfMinutes').value);
    if (type === 'once') rule.at = $('sfAt').value;
    const r = await window.api.schedulesSave({ id: editingId || undefined, title: $('sfTitle').value, prompt: $('sfPrompt').value, rule, workspace: $('sfWs').textContent || undefined });
    if (!r.ok) return formMsg('sfMsg', false, r.error);
    $('schedForm').classList.add('hidden');
    loadSchedules();
  };
  window.loadSchedules = async function loadSchedules() {
    const list = await window.api.schedulesList();
    const box = $('schedList');
    box.innerHTML = list.length ? '' : `<div class="hint sched-empty">${esc(T('schedEmpty'))}</div>`;
    if (!list.length) return;
    const group = document.createElement('div');
    group.className = 'set-group';
    for (const it of list) {
      const row = document.createElement('div');
      row.className = 'set-row sched-row' + (it.enabled === false ? ' off' : '');
      const last = it.lastRunAt ? T('schedLastAt', { at: fmtAt(it.lastRunAt) }) + ' · ' + T('schedLast_' + (it.lastStatus || 'ok')) : '';
      row.innerHTML = `<div class="sched-info"><b>${esc(it.title)}</b><div class="hint">${esc(it.describe)}${it.nextAt ? ' · ' + esc(T('schedNextAt', { at: fmtAt(it.nextAt) })) : ''}</div>
          <div class="hint sched-prompt">${esc(it.prompt)}</div>${last ? `<div class="hint">${esc(last)}${it.lastConvId ? ` · <a class="s-open">${esc(T('schedOpenLast'))}</a>` : ''}</div>` : ''}</div>
        <div class="sched-acts"><input type="checkbox" class="s-on" ${it.enabled === false ? '' : 'checked'} />
          <button class="ghost small s-run">${esc(T('schedRunNow'))}</button><button class="ghost small s-edit">${esc(T('schedEdit'))}</button><button class="ghost small danger s-del">${esc(T('schedDelete'))}</button></div>`;
      row.querySelector('.s-on').onchange = async (e) => {
        await window.api.schedulesSave({ id: it.id, enabled: e.target.checked });
        loadSchedules();
      };
      row.querySelector('.s-run').onclick = async () => {
        const r = await window.api.schedulesRun(it.id);
        if (!r.ok) return showToast(r.error);
        showToast(T('schedStarted', { title: it.title }), 'info');
      };
      row.querySelector('.s-edit').onclick = () => openForm(it);
      row.querySelector('.s-del').onclick = async () => {
        if (!confirm(T('schedDeleteConfirm', { title: it.title }))) return;
        await window.api.schedulesDelete(it.id);
        loadSchedules();
      };
      const open = row.querySelector('.s-open');
      if (open) open.onclick = () => {
        $('settingsModal').classList.add('hidden');
        openConv(it.lastConvId);
      };
      group.appendChild(row);
    }
    box.appendChild(group);
  };
}

// 设置 → 行为：快捷小窗的快捷键说明和「试一下」
$('quickKbd').textContent = navigator.platform.startsWith('Mac') ? '⌘ ⇧ Space' : 'Ctrl + Shift + Space';
$('quickTry').onclick = () => {
  $('settingsModal').classList.add('hidden');
  window.api.quickToggle();
};

// ---------- 截图提问：快捷键 Cmd/Ctrl+Shift+X 或输入框旁的按钮，框选后加进附件 ----------
// dataURL 转成 File 走原来的图片附件逻辑（压缩、数量限制）。CSP 不允许 fetch(data:)，手动解码
function addImageDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  addImageFiles([new File([bytes], 'screenshot.png', { type: m[1] })]);
}
function showScreenPermission() {
  // macOS 没有「屏幕录制」权限：给一个能直接打开系统设置的提示
  let box = $('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.appendChild(box);
  }
  const d = document.createElement('div');
  d.className = 'toast error toast-action';
  d.innerHTML = `<span>${esc(T('screenshotDenied'))}</span><button type="button">${esc(T('screenshotOpenSettings'))}</button>`;
  d.querySelector('button').onclick = () => {
    window.api.captureOpenSettings();
    d.remove();
  };
  box.appendChild(d);
  setTimeout(() => d.remove(), 12000);
}
$('shotBtn').onclick = () => window.api.captureStart();
$('shotBtn').title = T('screenshotBtn') + (navigator.platform.startsWith('Mac') ? '（⌘⇧X）' : '（Ctrl+Shift+X）');

// ---------- 对话里的图片：悬停显示「复制 / 另存为」，右键弹出菜单 ----------
{
  const IMG_SEL = '#log img.gen-img, #log .imgs img';
  const bar = document.createElement('div');
  bar.className = 'img-actions hidden';
  bar.innerHTML = `<button type="button" data-act="copy" title="${esc(T('imgCopy'))}"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button><button type="button" data-act="save" title="${esc(T('imgSaveAs'))}"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>`;
  document.body.appendChild(bar);
  let target = null;
  const place = () => {
    if (!target || !target.isConnected) return bar.classList.add('hidden');
    const r = target.getBoundingClientRect();
    bar.style.top = r.top + 8 + 'px';
    bar.style.left = r.right - bar.offsetWidth - 8 + 'px';
  };
  $('log').addEventListener('mouseover', (e) => {
    const img = e.target.closest(IMG_SEL);
    if (!img) return;
    target = img;
    bar.classList.remove('hidden');
    bar.querySelectorAll('button')[0].title = T('imgCopy');
    bar.querySelectorAll('button')[1].title = T('imgSaveAs');
    place();
  });
  $('log').addEventListener('mouseout', (e) => {
    if (!e.target.closest(IMG_SEL)) return;
    if (e.relatedTarget && (bar.contains(e.relatedTarget) || e.relatedTarget === target)) return;
    bar.classList.add('hidden');
  });
  bar.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget !== target) bar.classList.add('hidden');
  });
  $('log').addEventListener('scroll', place);
  bar.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !target) return;
    if (b.dataset.act === 'copy') {
      const ok = await window.api.imageCopy(target.src);
      showToast(T(ok ? 'imgCopied' : 'imgCopyFail'), ok ? 'ok' : 'error');
    } else window.api.imageSave(target.src);
  });
  $('log').addEventListener('contextmenu', (e) => {
    const img = e.target.closest(IMG_SEL);
    if (!img) return;
    e.preventDefault();
    window.api.imageMenu(img.src);
  });
}
