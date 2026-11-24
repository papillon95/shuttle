// 内置浏览器：窗口右侧的浏览器面板，AI 通过工具读取页面、点击、输入，用户也可以随时自己操作（比如登录、输验证码）。
//
// 用 Electron 的 WebContentsView 叠在主窗口上，位置由界面里的占位元素决定（界面把它的位置大小发过来）。
// 登录状态等数据存在单独的 persist:shuttle-browser 分区，和 Shuttle 自己的界面、用户的 Chrome 都分开。
// 网页内容永远只是数据：这里不执行网页给的任何「指令」，只按 AI 的工具调用操作。
const { WebContentsView } = require('electron');

let win = null;
let view = null;
let visible = false; // 面板是否打开
let suspended = false; // 界面弹窗盖住时暂时隐藏（原生视图总在网页内容之上，会挡住弹窗）
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let onEvent = () => {};
// 当前页面的问题记录（换页时清空）：控制台报错、加载失败的资源
let pageIssues = [];
const addIssue = (s) => {
  if (pageIssues.length < 40 && !pageIssues.includes(s)) pageIssues.push(s);
};

function init(opts) {
  win = opts.window;
  onEvent = opts.onEvent || onEvent;
}

function state() {
  const wc = view?.webContents;
  return {
    type: 'browser-state',
    url: wc ? wc.getURL() : '',
    title: wc ? wc.getTitle() : '',
    loading: wc ? wc.isLoading() : false,
    canBack: wc ? wc.navigationHistory.canGoBack() : false,
    canForward: wc ? wc.navigationHistory.canGoForward() : false,
  };
}
const emit = () => onEvent(state());

/** 页面里还没有打开过任何网址（新建的空视图）：这时执行脚本会一直等下去，不会返回 */
const hasPage = () => !!view?.webContents.getURL();
/**
 * 在页面里执行脚本，带超时：没打开网页、页面崩溃或卡住时报错，而不是让 AI 一直等
 * （Electron 的 executeJavaScript 在页面没加载过 / 卡住时不会返回）
 */
function js(code, timeout = 15000) {
  const wc = view?.webContents;
  if (!wc || !hasPage()) return Promise.reject(Object.assign(new Error('no_page'), { code: 'no_page' }));
  if (wc.isCrashed()) return Promise.reject(Object.assign(new Error('page_crashed'), { code: 'page_crashed' }));
  let t;
  return Promise.race([
    wc.executeJavaScript(code, true),
    new Promise((_, reject) => (t = setTimeout(() => reject(Object.assign(new Error('page_timeout'), { code: 'page_timeout' })), timeout))),
  ]).finally(() => clearTimeout(t));
}

function ensureView() {
  if (view) return view;
  view = new WebContentsView({
    webPreferences: { partition: 'persist:shuttle-browser', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = view.webContents;
  // 去掉 UA 里的 Electron / Shuttle 字样，有些网站会把它当成异常浏览器
  wc.setUserAgent(wc.getUserAgent().replace(/\s*(Electron|Shuttle|shuttle)\/[\d.]+/g, ''));
  // 新窗口（target=_blank）在当前视图里打开
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) wc.loadURL(url);
    return { action: 'deny' };
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(ev, emit);
  // 记录页面问题，读取页面时一起交给 AI，方便它检查自己做的网页对不对
  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame && !d.isSameDocument) pageIssues = [];
  });
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 3) addIssue(`[console.error] ${String(message).slice(0, 300)}${sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''}`);
  });
  wc.on('render-process-gone', (_e, d) => {
    addIssue(`[页面崩溃] ${d?.reason || ''}`);
    emit();
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (code !== -3) addIssue(`[${isMainFrame ? '页面打不开' : '资源加载失败'}] ${desc} ${url}`);
  });
  wc.session.webRequest.onCompleted({ urls: ['*://*/*'] }, (d) => {
    if (d.webContentsId === wc.id && d.statusCode >= 400 && d.resourceType !== 'mainFrame') addIssue(`[HTTP ${d.statusCode}] ${d.resourceType} ${d.url.slice(0, 200)}`);
  });
  wc.session.webRequest.onErrorOccurred({ urls: ['file://*/*'] }, (d) => {
    if (d.webContentsId === wc.id) addIssue(`[资源加载失败] ${d.error} ${d.url.slice(0, 200)}`);
  });
  view.setBackgroundColor('#ffffff');
  win.contentView.addChildView(view);
  applyBounds();
  return view;
}

function applyBounds() {
  if (!view) return;
  const show = visible && !suspended && bounds.width > 20 && bounds.height > 20;
  view.setVisible(show);
  if (show) view.setBounds(bounds);
}

/** 界面告诉我们面板占位元素的位置（CSS 像素，和窗口内容坐标一致） */
function setBounds(r) {
  bounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  applyBounds();
}
function setSuspended(s) {
  suspended = !!s;
  applyBounds();
}
function show() {
  visible = true;
  ensureView();
  applyBounds();
  onEvent({ type: 'browser-show' });
  emit();
}
function hide() {
  visible = false;
  applyBounds();
}
const isOpen = () => visible;

// ---------- 导航 ----------
// 可选的搜索站点：AI 按内容挑（经验种草 → 小红书，观点问答 → 知乎，视频 → B站…）；
// 地址栏里也可以写「知乎 关键词」「小红书 关键词」。知乎、小红书、微博要登录才能看全，用户在内置浏览器里登录一次就行
// （搜狗微信搜索、抖音网页版对自动打开的页面返回空白，暂不支持）
const SEARCH_SITES = {
  baidu: { names: ['百度', 'baidu'], url: 'https://www.baidu.com/s?wd=' },
  bing: { names: ['必应', 'bing'], url: 'https://cn.bing.com/search?q=' },
  zhihu: { names: ['知乎', 'zhihu'], url: 'https://www.zhihu.com/search?type=content&q=' },
  xiaohongshu: { names: ['小红书', 'xhs', 'xiaohongshu'], url: 'https://www.xiaohongshu.com/search_result?keyword=' },
  bilibili: { names: ['b站', '哔哩哔哩', 'bilibili'], url: 'https://search.bilibili.com/all?keyword=' },
  weibo: { names: ['微博', 'weibo'], url: 'https://s.weibo.com/weibo?q=' },
};
function searchUrl(site, q, lang) {
  const s = SEARCH_SITES[site] || (lang === 'en' ? SEARCH_SITES.bing : SEARCH_SITES.baidu);
  return s.url + encodeURIComponent(q);
}
function normalizeUrl(input, lang, site) {
  const s = String(input || '').trim();
  if (!s) return 'about:blank';
  if (/^(https?|file):\/\//i.test(s)) return s;
  // 本机地址（本地开发服务器）用 http
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return 'https://' + s;
  // 不像网址就当搜索词：指定了站点用那个站点搜；「知乎 xxx」这种写法也认
  if (site && SEARCH_SITES[site]) return searchUrl(site, s, lang);
  const m = s.match(/^(\S+)\s+(.+)$/);
  if (m) {
    const hit = Object.keys(SEARCH_SITES).find((k) => SEARCH_SITES[k].names.includes(m[1].toLowerCase()));
    if (hit) return searchUrl(hit, m[2], lang);
  }
  return searchUrl(null, s, lang);
}
// 等页面加载完（最多 timeout 毫秒），再多等一会儿让脚本渲染
function settle(timeout = 15000) {
  const wc = view.webContents;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      wc.removeListener('did-stop-loading', onStop);
      setTimeout(resolve, 600);
    };
    const onStop = () => finish();
    const t = setTimeout(finish, timeout);
    // 给点击触发的导航一点时间开始
    setTimeout(() => {
      if (!wc.isLoading()) finish();
      else wc.once('did-stop-loading', onStop);
    }, 350);
  });
}
async function navigate(input, lang, site) {
  show();
  const url = normalizeUrl(input, lang, site);
  try {
    await view.webContents.loadURL(url);
  } catch (e) {
    // 重定向、被中断等情况 loadURL 会抛错，但页面通常已经打开了
    if (!/ERR_ABORTED/.test(e.message)) throw e;
  }
  await settle();
  return url;
}
async function back() {
  ensureView();
  if (!view.webContents.navigationHistory.canGoBack()) return false;
  view.webContents.navigationHistory.goBack();
  await settle();
  return true;
}
function forward() {
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
}
function reload() {
  view?.webContents.reload();
}
// 当前打开的本地文件（file://）路径，不是本地文件时返回 null
function currentFile() {
  const u = view?.webContents.getURL() || '';
  if (!/^file:\/\//i.test(u)) return null;
  try {
    return require('url').fileURLToPath(u.split('#')[0].split('?')[0]);
  } catch {
    return null;
  }
}

// ---------- 读取页面 ----------
// 给可操作的元素编号（data-shuttle-id），返回编号列表和正文。编号在同一页面里保持不变。
const SNAPSHOT_JS = (maxText, maxEls) => `(() => {
  const SEL = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=textbox], [role=combobox], [role=option], [contenteditable=""], [contenteditable=true], [onclick]';
  window.__shuttleSeq = window.__shuttleSeq || 0;
  const vh = innerHeight, vw = innerWidth;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const kind = (el) => {
    const t = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (t === 'a' || role === 'link') return 'link';
    if (t === 'button' || role === 'button' || t === 'summary') return 'button';
    if (t === 'select' || role === 'combobox') return 'select';
    if (t === 'textarea' || role === 'textbox' || el.isContentEditable) return 'textbox';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(ty)) return 'button';
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'password') return 'password';
      return 'textbox';
    }
    return role || 'clickable';
  };
  const items = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el) || el.disabled) continue;
    const r = el.getBoundingClientRect();
    const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    let id = el.getAttribute('data-shuttle-id');
    if (!id) { id = String(++window.__shuttleSeq); el.setAttribute('data-shuttle-id', id); }
    const k = kind(el);
    const name = clean(el.getAttribute('aria-label') || (k === 'textbox' || k === 'password' || k === 'select' ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.value || el.getAttribute('name') || '').slice(0, 80);
    const extra = [];
    if ((k === 'textbox') && el.getAttribute('placeholder')) extra.push('提示:' + clean(el.getAttribute('placeholder')).slice(0, 40));
    if ((k === 'textbox') && el.value) extra.push('当前值:' + clean(el.value).slice(0, 40));
    if (k === 'checkbox' || k === 'radio') extra.push(el.checked ? '已选' : '未选');
    if (k === 'select' && el.selectedOptions && el.selectedOptions[0]) extra.push('当前:' + clean(el.selectedOptions[0].text).slice(0, 30));
    if (!name && k === 'link' && !extra.length) continue;
    items.push({ id, k, name, extra: extra.join(' '), inView, top: r.top });
  }
  // 先列当前屏幕里的，再列下面的
  items.sort((a, b) => (a.inView === b.inView ? a.top - b.top : a.inView ? -1 : 1));
  const text = clean(document.body ? document.body.innerText : '').slice(0, ${maxText});
  // 页面体检：显示不出来的图片、横向超出屏幕的内容、几乎空白的页面
  const checks = [];
  const broken = [...document.images].filter((im) => im.complete && im.naturalWidth === 0 && (im.currentSrc || im.src)).map((im) => (im.currentSrc || im.src).split('/').pop().slice(0, 60));
  if (broken.length) checks.push('图片显示不出来：' + broken.slice(0, 8).join('、'));
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 4) {
    const wide = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.right > vw + 4 && r.width > 0 && getComputedStyle(el).position !== 'fixed'; }).slice(0, 3)
      .map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.classList[0] ? '.' + el.classList[0] : ''));
    checks.push('内容横向超出屏幕（页面宽 ' + sw + 'px，窗口 ' + vw + 'px）' + (wide.length ? '，超出的元素：' + wide.join('、') : ''));
  }
  if (document.body && clean(document.body.innerText).length < 5 && !document.querySelector('img, svg, canvas, video')) checks.push('页面几乎是空白的');
  return {
    checks,
    url: location.href,
    title: document.title,
    text,
    scroll: { y: Math.round(scrollY), max: Math.round(Math.max(0, document.documentElement.scrollHeight - vh)) },
    elements: items.slice(0, ${maxEls}),
    total: items.length,
  };
})()`;

async function snapshot(maxText = 6000, maxEls = 120) {
  ensureView();
  try {
    const snap = await js(SNAPSHOT_JS(maxText, maxEls));
    snap.issues = pageIssues.slice();
    snap.size = { width: bounds.width, height: bounds.height };
    return snap;
  } catch (e) {
    return { url: view.webContents.getURL(), title: view.webContents.getTitle(), text: '', elements: [], total: 0, error: e.code || e.message };
  }
}

// 元素信息：用于确认弹窗和安全判断
async function elementInfo(id) {
  ensureView();
  return js(
    `(() => { const el = document.querySelector('[data-shuttle-id="${String(id).replace(/[^0-9]/g, '')}"]');
      if (!el) return null;
      const t = el.tagName.toLowerCase();
      const form = el.form || el.closest('form');
      return { tag: t, type: (el.type || '').toLowerCase(), name: String(el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        password: t === 'input' && (el.type || '').toLowerCase() === 'password',
        sensitiveField: /card|cvv|cvc|身份证|银行卡|卡号|支付密码/i.test((el.getAttribute('name') || '') + ' ' + (el.getAttribute('autocomplete') || '') + ' ' + (el.getAttribute('placeholder') || '')) || /cc-/.test(el.getAttribute('autocomplete') || ''),
        submitsForm: !!form && (t === 'button' ? (el.type || 'submit') === 'submit' : ['submit', 'image'].includes((el.type || '').toLowerCase())) };
    })()`
  );
}

// 把元素滚到屏幕中间，返回它的中心坐标
async function center(id) {
  return js(
    `(() => { const el = document.querySelector('[data-shuttle-id="${String(id).replace(/[^0-9]/g, '')}"]');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height };
    })()`
  );
}

// ---------- 操作 ----------
// 用真实的鼠标、键盘事件，前端框架（React / Vue）也能正常响应
async function click(id) {
  ensureView();
  const c = await center(id);
  if (!c) return false;
  await new Promise((r) => setTimeout(r, 120));
  const wc = view.webContents;
  if (c.w > 0 && c.h > 0) {
    wc.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  } else {
    await js(`document.querySelector('[data-shuttle-id="${String(id).replace(/[^0-9]/g, '')}"]').click()`);
  }
  await settle();
  return true;
}

async function type(id, text, { clear = true, submit = false } = {}) {
  ensureView();
  const c = await center(id);
  if (!c) return false;
  const wc = view.webContents;
  // 先点一下获得焦点，再全选（清空原有内容）后输入
  wc.sendInputEvent({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
  await js(
    `(() => { const el = document.querySelector('[data-shuttle-id="${String(id).replace(/[^0-9]/g, '')}"]'); if (!el) return; el.focus();
      ${clear ? `if ('value' in el && typeof el.select === 'function') el.select(); else if (el.isContentEditable) document.execCommand('selectAll');` : ''} })()`
  );
  if (clear) wc.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' }), wc.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await wc.insertText(String(text));
  if (submit) await press('Enter');
  else await new Promise((r) => setTimeout(r, 300));
  return true;
}

const KEYS = { enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', up: 'Up', down: 'Down', left: 'Left', right: 'Right', pagedown: 'PageDown', pageup: 'PageUp', space: 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right' };
async function press(key) {
  ensureView();
  const k = KEYS[String(key).toLowerCase()] || key;
  const wc = view.webContents;
  wc.sendInputEvent({ type: 'keyDown', keyCode: k });
  if (k === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: k });
  await settle(10000);
  return true;
}

async function scroll(direction) {
  ensureView();
  await js(`window.scrollBy({ top: ${direction === 'up' ? -1 : 1} * Math.round(innerHeight * 0.8), behavior: 'instant' })`);
  await new Promise((r) => setTimeout(r, 400));
}

// 截图（给能看图的模型用）：返回 JPEG 的 data URL，宽度缩到 1024 以内
async function screenshot() {
  ensureView();
  if (!hasPage()) throw Object.assign(new Error('no_page'), { code: 'no_page' });
  let t;
  const img = await Promise.race([
    view.webContents.capturePage(),
    new Promise((_, reject) => (t = setTimeout(() => reject(Object.assign(new Error('page_timeout'), { code: 'page_timeout' })), 15000))),
  ]).finally(() => clearTimeout(t));
  const size = img.getSize();
  const scaled = size.width > 1024 ? img.resize({ width: 1024 }) : img;
  return 'data:image/jpeg;base64,' + scaled.toJPEG(70).toString('base64');
}

module.exports = { SEARCH_SITES, normalizeUrl, hasPage, currentFile, init, show, hide, isOpen, setBounds, setSuspended, navigate, back, forward, reload, snapshot, elementInfo, click, type, press, scroll, screenshot, state };
