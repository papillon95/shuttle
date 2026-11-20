// 补丁更新：检查版本清单 → 下载新代码包 → 校验指纹和签名 → 下次启动由 boot.js 加载
//
// 版本清单（发版脚本 scripts/release.mjs 生成，放在腾讯云 COS）：
// {
//   "version": "0.2.1", "notes": "...", "notesEn": "...",
//   "patch": { "url": ".../shuttle-0.2.1.asar", "size": 150000, "sha256": "...", "minShell": "0.2.0", "signature": "base64" },
//   "full":  { "mac-arm64": "...dmg", "mac-x64": "...dmg", "win-x64": "...exe" }
// }
// minShell：补丁要求的最低安装包版本（Electron 运行环境升级时需要重新下载完整安装包）。
// signature：用发布者私钥对「版本号\n sha256」做的 Ed25519 签名；客户端只信任下面这把公钥，
// 即使有人篡改了 COS 上的文件，也无法让客户端加载未经签名的代码。
const { app } = require('electron');
const path = require('path');
const crypto = require('crypto');
const ofs = require('original-fs');

const MANIFEST_URL = process.env.SHUTTLE_UPDATE_MANIFEST || 'https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/updates/stable.json';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF0njHy8YgYQlz1n6y8K/B32kQ9CJrJ2pu3ooi/Z+Cqo=
-----END PUBLIC KEY-----`;

// 正在运行的代码版本（打过补丁就是补丁版本）
const currentVersion = () => require('../package.json').version;
// 安装包（Electron 运行环境）版本
const shellVersion = () => (global.__shuttle && global.__shuttle.bundledVersion) || app.getVersion();
const isPatched = () => !!(global.__shuttle && global.__shuttle.patch);
const updatesDir = () => path.join(app.getPath('userData'), 'updates');
const stateFile = () => path.join(updatesDir(), 'current.json');

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
function platformKey() {
  if (process.platform === 'win32') return 'win-x64';
  return process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'linux-x64';
}
function readState() {
  try {
    return JSON.parse(ofs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

// 页面正常加载后调用：说明这个补丁能用，清零启动失败计数
function markBootOk() {
  const s = readState();
  if (s && isPatched() && s.version === global.__shuttle.patch.version && s.pendingBoot) {
    ofs.writeFileSync(stateFile(), JSON.stringify({ ...s, pendingBoot: 0 }, null, 2));
  }
}

// 已下载、等待重启生效的补丁版本
function stagedVersion() {
  const s = readState();
  return s && !s.bad && newer(s.version, currentVersion()) && ofs.existsSync(s.file) ? s.version : null;
}

async function fetchManifest() {
  const res = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
  return res.json();
}

/**
 * 检查更新。返回：
 *  { status: 'latest' }                       已是最新
 *  { status: 'ready', version, notes }        补丁已下载，重启生效
 *  { status: 'full', version, notes, url }    需要下载完整安装包
 *  { status: 'error', error }
 * autoDownload=true 时发现补丁会顺便下载好。
 */
async function check({ autoDownload = true } = {}) {
  try {
    const m = await fetchManifest();
    const lang = (s) => ({ notes: m.notes || '', notesEn: m.notesEn || m.notes || '', ...s });
    if (!newer(m.version, currentVersion())) return { status: 'latest', current: currentVersion() };
    if (stagedVersion() === m.version) return lang({ status: 'ready', version: m.version });
    const p = m.patch;
    if (p && !newer(p.minShell || '0.0.0', shellVersion())) {
      if (!autoDownload) return lang({ status: 'patch', version: m.version, size: p.size });
      await downloadPatch(m);
      return lang({ status: 'ready', version: m.version, size: p.size });
    }
    return lang({ status: 'full', version: m.version, url: m.full && m.full[platformKey()] });
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function downloadPatch(m) {
  const p = m.patch;
  const res = await fetch(p.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`patch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha256 !== p.sha256) throw new Error('补丁文件校验失败（sha256 不一致）');
  const ok = crypto.verify(null, Buffer.from(`${m.version}\n${sha256}`), PUBLIC_KEY, Buffer.from(p.signature || '', 'base64'));
  if (!ok) throw new Error('补丁签名无效，已拒绝');

  ofs.mkdirSync(updatesDir(), { recursive: true });
  const file = path.join(updatesDir(), `shuttle-${m.version}.asar`);
  ofs.writeFileSync(file + '.tmp', buf);
  ofs.renameSync(file + '.tmp', file);
  ofs.writeFileSync(stateFile(), JSON.stringify({ version: m.version, file, sha256, pendingBoot: 0, downloadedAt: new Date().toISOString() }, null, 2));

  // 清理旧补丁（保留新下载的和当前正在运行的）
  const running = isPatched() ? path.basename(global.__shuttle.patch.file) : null;
  for (const f of ofs.readdirSync(updatesDir())) {
    if (f.endsWith('.asar') && f !== path.basename(file) && f !== running) {
      try {
        ofs.unlinkSync(path.join(updatesDir(), f));
      } catch {}
    }
  }
}

function restart() {
  app.relaunch();
  app.quit();
}

function info() {
  return { version: currentVersion(), shellVersion: shellVersion(), patched: isPatched(), staged: stagedVersion() };
}

module.exports = { check, restart, info, markBootOk, currentVersion };
