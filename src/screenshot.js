// 截图提问：按 Cmd/Ctrl+Shift+X（或输入框旁的截图按钮），在鼠标所在的屏幕上框选一块，截图加进输入框的附件。
//
// 流程：先隐藏 Shuttle 主窗口 → 用 desktopCapturer 截下整个屏幕 → 打开一个盖住该屏幕的全屏窗口，
// 以整屏截图做背景让用户框选（这样不会截到遮罩本身）→ 按选区从原图裁剪 → 恢复主窗口，把图片交给界面。
// macOS 需要「屏幕录制」权限；没有权限时截出来是空图，提示用户去系统设置打开。
const path = require('path');
const { BrowserWindow, desktopCapturer, screen, globalShortcut, systemPreferences, ipcMain, shell, nativeImage } = require('electron');

const SHORTCUT = 'CommandOrControl+Shift+X';

// ---------- 纯函数（scripts/test-crop.mjs 单测） ----------
/**
 * 选区（覆盖窗口里的 CSS 像素）→ 原图上的裁剪框（物理像素）。
 * sel: { x, y, width, height }，可以是从右下往左上拖出来的负宽高；scale: 屏幕缩放（Retina 为 2）；
 * imgW / imgH：整屏截图的实际像素大小。结果取整并限制在图片范围内；太小（不到 4 像素）返回 null。
 */
function cropRect(sel, scale, imgW, imgH) {
  let { x, y, width, height } = sel;
  if (width < 0) (x += width), (width = -width);
  if (height < 0) (y += height), (height = -height);
  let left = Math.max(0, Math.round(x * scale));
  let top = Math.max(0, Math.round(y * scale));
  const right = Math.min(imgW, Math.round((x + width) * scale));
  const bottom = Math.min(imgH, Math.round((y + height) * scale));
  const w = right - left;
  const h = bottom - top;
  if (w < 4 || h < 4) return null;
  return { x: left, y: top, width: w, height: h };
}

let mainWin = null;
let onCaptured = () => {};
let onDenied = () => {};
let busy = false;
let overlay = null;
let pending = null; // { image, display, wasVisible }

function init(opts) {
  mainWin = opts.window;
  onCaptured = opts.onCaptured || onCaptured;
  onDenied = opts.onDenied || onDenied;
  try {
    if (!globalShortcut.register(SHORTCUT, start)) console.warn('[screenshot] 快捷键被占用：' + SHORTCUT);
  } catch (e) {
    console.warn('[screenshot] 注册快捷键失败', e.message);
  }
  ipcMain.handle('capture:start', () => start());
  ipcMain.handle('capture:open-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));
  ipcMain.on('capture:done', (_e, sel) => finish(sel));
  ipcMain.on('capture:cancel', () => finish(null));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function restoreMain(focus) {
  if (!mainWin || mainWin.isDestroyed()) return;
  if (pending?.wasVisible || focus) {
    mainWin.show();
    if (focus) mainWin.focus();
  }
}

async function start() {
  if (busy) return;
  busy = true;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = !!mainWin && mainWin.isVisible() && !mainWin.isMinimized();
  try {
    // 截图前隐藏主窗口，避免把自己截进去
    if (wasVisible) {
      mainWin.hide();
      await sleep(220);
    }
    const sf = display.scaleFactor || 1;
    let image;
    if (process.env.SHUTTLE_FAKE_SCREEN) {
      // 仅开发测试用：没有屏幕录制能力的环境里，用生成的测试图代替真实屏幕
      image = fakeScreen(display, sf);
    } else {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) },
      });
      const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
      image = src?.thumbnail;
    }
    const denied = process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted';
    if (!image || image.isEmpty() || denied) {
      pending = { wasVisible };
      restoreMain(true);
      pending = null;
      busy = false;
      onDenied();
      return;
    }
    pending = { image, display, wasVisible };
    openOverlay(display, image);
  } catch (e) {
    console.warn('[screenshot]', e && e.message ? e.message : String(e));
    pending = { wasVisible };
    restoreMain(true);
    pending = null;
    busy = false;
    onDenied(); // 截不到屏幕基本都是权限问题，提示用户去开
  }
}

// 测试图：左右两半不同颜色，方便检查裁剪位置（BGRA 原始像素）
function fakeScreen(display, sf) {
  const w = Math.round(display.size.width * sf);
  const h = Math.round(display.size.height * sf);
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      buf[i] = left ? 220 : 40; // B
      buf[i + 1] = 120; // G
      buf[i + 2] = left ? 40 : 220; // R
      buf[i + 3] = 255;
    }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

function openOverlay(display, image) {
  const b = display.bounds;
  overlay = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    hasShadow: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { preload: path.join(__dirname, 'capture-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
  overlay.webContents.once('did-finish-load', () => {
    overlay.webContents.send('capture:image', image.toDataURL());
    overlay.setBounds(b);
    overlay.show();
    overlay.focus();
  });
  overlay.on('closed', () => {
    overlay = null;
    // 被意外关掉（比如切换桌面）时当作取消
    if (pending) finish(null);
  });
}

function finish(sel) {
  const p = pending;
  pending = null;
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
  busy = false;
  if (!p) return;
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.show();
  mainWin.focus();
  if (!sel || !p.image) return;
  const size = p.image.getSize();
  const r = cropRect(sel, size.width / p.display.bounds.width, size.width, size.height);
  if (!r) return;
  onCaptured(p.image.crop(r).toDataURL());
}

function dispose() {
  try {
    globalShortcut.unregister(SHORTCUT);
  } catch {}
}

module.exports = { SHORTCUT, init, start, dispose, cropRect };
