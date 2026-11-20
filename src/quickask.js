// 全局快捷键小窗：在任何软件里按 Cmd/Ctrl+Shift+Space 弹出一个 Spotlight 式输入框，回答直接在小窗里流式显示。
// 剪贴板里 30 秒内复制过的文字会自动作为「引用」带上（翻译、改写、解释最常用）。
// 回答不使用工具（快、便宜）；需要读文件、上网的话点「在主窗口继续」。
const path = require('path');
const { app, BrowserWindow, globalShortcut, screen, clipboard, ipcMain } = require('electron');

const SHORTCUT = 'CommandOrControl+Shift+Space';
const WIDTH = 640;
const RECENT_MS = 30 * 1000;
const MAX_QUOTE = 6000;

// ---------- 纯函数（scripts/test-quick.mjs 单测） ----------
/** 剪贴板文字算不算「最近复制的」：30 秒内变过、非空、不太长 */
function recentClip(state, now = Date.now()) {
  const text = String(state?.text || '').trim();
  if (!text || !state.changedAt || now - state.changedAt > RECENT_MS) return '';
  return text.length > MAX_QUOTE ? text.slice(0, MAX_QUOTE) : text;
}
/** 组装发给模型的消息：有引用时把引用放在问题前面 */
function buildMessages(question, quote, lang = 'zh') {
  const en = lang === 'en';
  const system = en
    ? 'You are Shuttle\'s quick assistant. Answer concisely and directly in the user\'s language; use Markdown only when it helps (lists, code). When text is quoted, the question is about that text (translate, rewrite, explain, summarize…). If no instruction is given, infer the most likely need: translate non-native text, otherwise explain it briefly.'
    : '你是 Shuttle 的快捷助手。回答简洁直接，和用户用同一种语言；只有需要时才用 Markdown（列表、代码）。用户引用了一段文字时，问题就是针对这段文字的（翻译、改写、解释、总结……）。没给明确要求时推测最可能的需求：外文就翻译成中文，中文就简要解释。';
  const q = String(question || '').trim();
  const user = quote
    ? `${en ? 'Quoted text' : '引用的内容'}：\n"""\n${quote}\n"""\n\n${q || (en ? '(no instruction)' : '（没有具体要求）')}`
    : q;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------- 窗口 ----------
let win = null;
let opts = null;
let clip = { text: '', changedAt: 0 };
let current = null; // { abort: AbortController, question, quote, answer }
let shownAt = 0;
let sticky = false; // 输入了内容或已有回答：点别处不自动关（Esc 或再按快捷键关闭）

function init(o) {
  opts = o;
  // 记录剪贴板变化的时间（启动时已有的内容不算「最近复制」）
  clip = { text: clipboard.readText(), changedAt: 0 };
  setInterval(() => {
    const t = clipboard.readText();
    if (t !== clip.text) clip = { text: t, changedAt: Date.now() };
  }, 800);
  try {
    if (!globalShortcut.register(SHORTCUT, toggle)) console.warn('[quick] 快捷键被占用：' + SHORTCUT);
  } catch (e) {
    console.warn('[quick] 注册快捷键失败', e.message);
  }

  ipcMain.handle('quick:state', () => ({ quote: recentClip(clip), lang: opts.lang(), loggedIn: opts.loggedIn(), model: opts.modelLabel() }));
  ipcMain.handle('quick:ask', (_e, question, quote) => ask(question, quote));
  ipcMain.handle('quick:stop', () => current?.abort.abort());
  ipcMain.handle('quick:resize', (_e, h) => {
    if (!win) return;
    const height = Math.max(64, Math.min(560, Math.round(h)));
    const b = win.getBounds();
    if (b.height !== height) win.setBounds({ ...b, height });
  });
  ipcMain.handle('quick:hide', hide);
  ipcMain.handle('quick:sticky', (_e, v) => (sticky = !!v));
  ipcMain.handle('quick:toggle', () => toggle());
  ipcMain.handle('quick:continue', () => {
    if (!current?.answer) return { ok: false };
    const r = opts.continueInMain(current.question, current.answer, current.quote);
    if (r.ok) hide();
    return r;
  });
  ipcMain.handle('quick:copy', () => current?.answer && clipboard.writeText(current.answer));
}

function create() {
  win = new BrowserWindow({
    width: WIDTH,
    height: 72,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    // macOS 用浮动面板（NSPanel）：在别的软件前台时也能拿到键盘焦点，又不会把 Shuttle 主窗口一起带到前面
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
  win.on('blur', () => {
    // 刚弹出时系统可能先发一次失焦（焦点还没切过来），忽略；
    // 正在回答、已经有内容时也不关，方便边看边做别的，用 Esc 或再按一次快捷键关闭
    if (Date.now() - shownAt < 600 || current?.streaming || sticky) return;
    hide();
  });
  win.on('closed', () => (win = null));
}

function show() {
  if (!win) create();
  // 放在鼠标所在显示器的中上方
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({ x: Math.round(d.x + (d.width - WIDTH) / 2), y: Math.round(d.y + d.height * 0.2), width: WIDTH, height: 72 });
  const go = () => {
    sticky = false;
    shownAt = Date.now();
    win.webContents.send('quick:open');
    win.show();
    // Shuttle 不在前台时，先把输入焦点抢过来，否则输入框打不了字
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.focus();
    win.webContents.focus();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', go);
  else go();
}
function hide() {
  current?.abort.abort();
  if (win && win.isVisible()) win.hide();
}
function toggle() {
  if (win && win.isVisible()) hide();
  else show();
}

async function ask(question, quote) {
  sticky = true;
  current?.abort.abort();
  const abort = new AbortController();
  const c = (current = { abort, question, quote, answer: '', streaming: true });
  const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);
  try {
    const answer = await opts.ask(buildMessages(question, quote, opts.lang()), (delta) => {
      c.answer += delta;
      send('quick:delta', delta);
    }, abort.signal);
    c.answer = answer || c.answer;
    send('quick:done', { ok: true });
  } catch (e) {
    send('quick:done', { ok: false, error: abort.signal.aborted ? '' : e.message });
  } finally {
    c.streaming = false;
  }
}

function dispose() {
  try {
    globalShortcut.unregister(SHORTCUT);
  } catch {}
}

module.exports = { SHORTCUT, init, toggle, dispose, recentClip, buildMessages };
