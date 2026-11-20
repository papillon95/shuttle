// Shuttle 启动入口（安装包自带，补丁不会替换它）
//
// 补丁更新的原理：安装包里 99% 是 Electron 运行环境，我们自己的代码只有一百多 KB。
// 日常更新只下载新的代码包（.asar），校验签名后放进用户数据目录；下次启动时这里优先加载它，
// 不用重新下载、安装整个软件。
//
// 安全兜底：
//  - 补丁加载时直接报错 → 立即回退到安装包自带的代码，并把这个补丁标记为坏的；
//  - 补丁能加载但窗口没能正常打开（main.js 会在页面加载完成后把 pendingBoot 清零）
//    → 连续两次启动失败后同样标记为坏的，之后不再加载。
const { app } = require('electron');
const path = require('path');
const ofs = require('original-fs'); // 直接读写 .asar 文件本身，不让 Electron 把它当目录处理

if (process.env.AGENT_USER_DATA) app.setPath('userData', process.env.AGENT_USER_DATA);

const BUNDLED_VERSION = require('./package.json').version;
const updatesDir = path.join(app.getPath('userData'), 'updates');
const stateFile = path.join(updatesDir, 'current.json');

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
function readState() {
  try {
    return JSON.parse(ofs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}
function writeState(s) {
  try {
    ofs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
  } catch {}
}

const state = readState();
let patch = null;
if (state && !state.bad && state.file && newer(state.version, BUNDLED_VERSION) && ofs.existsSync(state.file)) {
  if ((state.pendingBoot || 0) >= 2) {
    writeState({ ...state, bad: true, badReason: 'startup failed twice' });
  } else {
    writeState({ ...state, pendingBoot: (state.pendingBoot || 0) + 1 });
    patch = state;
  }
}

global.__shuttle = { bundledVersion: BUNDLED_VERSION, patch: null, stateFile };
if (patch) {
  try {
    global.__shuttle.patch = { version: patch.version, file: patch.file };
    require(path.join(patch.file, 'src', 'main.js'));
  } catch (e) {
    // 补丁代码可能已经执行了一半（注册过事件处理），在同一进程里再加载自带代码会冲突，
    // 所以标记为坏补丁后重启进程，由干净的新进程加载自带版本
    console.error('[Shuttle] 补丁加载失败，回退到安装包自带版本', e);
    writeState({ ...patch, bad: true, badReason: String(e && e.message) });
    app.relaunch();
    app.exit(0);
  }
} else {
  require('./src/main.js');
}
