// MCP 服务需要的运行环境（Node.js、uv）一键安装
//
// 装在 Shuttle 自己的数据目录（userData/runtimes/），不需要管理员密码，也不改动用户电脑上已有的环境；
// 启动 MCP 服务时把这里的 bin 目录加进 PATH。
// 下载后用官方公布的 SHA-256 校验，校验不过就不安装。
// 国内网络优先走镜像（npmmirror、清华 PyPI），失败再换官方源。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const isWin = process.platform === 'win32';
let baseDir = path.join(os.homedir(), '.shuttle-runtimes');
let preferMirror = true;

function init({ dir, mirrorFirst }) {
  if (dir) baseDir = dir;
  if (mirrorFirst !== undefined) preferMirror = mirrorFirst;
}
const nodeDir = () => path.join(baseDir, 'node');
const uvDir = () => path.join(baseDir, 'uv');

/** 已安装运行环境的 bin 目录（加进 MCP 服务的 PATH 最前面） */
function binDirs() {
  const out = [];
  const nb = isWin ? nodeDir() : path.join(nodeDir(), 'bin');
  if (fs.existsSync(path.join(nb, isWin ? 'node.exe' : 'node'))) out.push(nb);
  const ub = path.join(uvDir(), 'bin');
  if (fs.existsSync(path.join(ub, isWin ? 'uv.exe' : 'uv'))) out.push(ub);
  return out;
}
/** 能自动安装的运行环境（python 系统级安装、docker 需要用户自己装） */
const canInstall = (rt) => rt === 'node' || rt === 'uv';

// ---------- 下载工具 ----------
const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

async function fetchText(url, ms = 20000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}
// 依次尝试多个地址，返回第一个成功的结果
async function firstOk(urls, fn) {
  let last;
  for (const u of urls) {
    try {
      return await fn(u);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
async function download(url, dest, onProgress) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000), redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastReport = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      if (onProgress && Date.now() - lastReport > 300) {
        lastReport = Date.now();
        onProgress(total ? Math.round((got / total) * 100) : null, got);
      }
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (total && got !== total) throw new Error('download incomplete');
}
// 解压：macOS / Linux / Windows 10+ 都自带 tar（Windows 的 bsdtar 也能解 zip）
function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) =>
    execFile(tar, ['-xf', archive, '-C', destDir], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (e, _o, err) =>
      e ? reject(new Error('extract failed: ' + (err || e.message))) : resolve()
    )
  );
}
function tmpDir(name) {
  const d = path.join(baseDir, '.tmp-' + name + '-' + Date.now());
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const rm = (p) => {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
};

// ---------- Node.js ----------
function nodeAsset(version) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `node-${version}-darwin-${arch}.tar.gz`;
  if (isWin) return `node-${version}-win-${arch}.zip`;
  return `node-${version}-linux-${arch}.tar.gz`;
}
async function installNode(onProgress) {
  const official = 'https://nodejs.org/dist';
  const mirror = 'https://npmmirror.com/mirrors/node';
  const bases = preferMirror ? [mirror, official] : [official, mirror];
  onProgress({ phase: 'resolve' });
  // 最新的 LTS 版本
  const { base, version } = await firstOk(bases, async (b) => {
    const list = JSON.parse(await fetchText(`${b}/index.json`));
    const lts = list.find((v) => v.lts);
    if (!lts) throw new Error('no LTS');
    return { base: b, version: lts.version };
  });
  const asset = nodeAsset(version);
  const sums = await firstOk([base, ...bases.filter((b) => b !== base)], (b) => fetchText(`${b}/${version}/SHASUMS256.txt`));
  const line = sums.split('\n').find((l) => l.trim().endsWith(' ' + asset));
  if (!line) throw new Error(`no checksum for ${asset}`);
  const expected = line.trim().split(/\s+/)[0];

  const tmp = tmpDir('node');
  try {
    const file = path.join(tmp, asset);
    await firstOk([base, ...bases.filter((b) => b !== base)], async (b) => {
      await download(`${b}/${version}/${asset}`, file, (pct, bytes) => onProgress({ phase: 'download', pct, bytes, version }));
      if ((await sha256File(file)) !== expected) throw new Error('checksum mismatch');
    });
    onProgress({ phase: 'extract', version });
    const out = path.join(tmp, 'x');
    await extract(file, out);
    const inner = fs.readdirSync(out).find((d) => d.startsWith('node-'));
    if (!inner) throw new Error('unexpected archive layout');
    rm(nodeDir());
    fs.renameSync(path.join(out, inner), nodeDir());
    return { version };
  } finally {
    rm(tmp);
  }
}

// ---------- uv（Python 生态的 MCP 服务大多用 uvx 启动；uv 会按需自动下载 Python） ----------
function uvWheelTag() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? /macosx_\d+_\d+_arm64/ : /macosx_\d+_\d+_x86_64/;
  if (isWin) return process.arch === 'arm64' ? /win_arm64/ : /win_amd64/;
  return process.arch === 'arm64' ? /manylinux.*aarch64/ : /manylinux.*x86_64/;
}
// 版本和校验值：优先 PyPI 官方 JSON；连不上时解析清华镜像的 simple 页（链接里带 #sha256=）
async function uvRelease() {
  const tag = uvWheelTag();
  try {
    const j = JSON.parse(await fetchText('https://pypi.org/pypi/uv/json'));
    const f = j.urls.find((u) => u.filename.endsWith('.whl') && tag.test(u.filename));
    if (f) return { version: j.info.version, filename: f.filename, sha256: f.digests.sha256, urlPath: new URL(f.url).pathname };
  } catch {}
  const html = await fetchText('https://pypi.tuna.tsinghua.edu.cn/simple/uv/');
  const links = [...html.matchAll(/href="([^"]+?)#sha256=([0-9a-f]{64})"[^>]*>([^<]+\.whl)</g)]
    .map((m) => ({ href: m[1], sha256: m[2], filename: m[3] }))
    .filter((l) => tag.test(l.filename) && !/[a-z]\d*\.whl$|rc|dev/.test(l.filename.split('-')[1]));
  const ver = (f) => f.split('-')[1].split('.').map(Number);
  links.sort((a, b) => {
    const x = ver(a.filename), y = ver(b.filename);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  const l = links[0];
  if (!l) throw new Error('uv wheel not found');
  return { version: l.filename.split('-')[1], filename: l.filename, sha256: l.sha256, url: new URL(l.href, 'https://pypi.tuna.tsinghua.edu.cn/simple/uv/').href };
}
async function installUv(onProgress) {
  onProgress({ phase: 'resolve' });
  const rel = await uvRelease();
  const urls = rel.url
    ? [rel.url]
    : preferMirror
      ? [`https://pypi.tuna.tsinghua.edu.cn${rel.urlPath}`, `https://files.pythonhosted.org${rel.urlPath}`]
      : [`https://files.pythonhosted.org${rel.urlPath}`, `https://pypi.tuna.tsinghua.edu.cn${rel.urlPath}`];
  const tmp = tmpDir('uv');
  try {
    const file = path.join(tmp, rel.filename.replace(/\.whl$/, '.zip'));
    await firstOk(urls, async (u) => {
      await download(u, file, (pct, bytes) => onProgress({ phase: 'download', pct, bytes, version: rel.version }));
      if ((await sha256File(file)) !== rel.sha256) throw new Error('checksum mismatch');
    });
    onProgress({ phase: 'extract', version: rel.version });
    const out = path.join(tmp, 'x');
    await extract(file, out);
    const scripts = fs.readdirSync(out).find((d) => d.endsWith('.data'));
    const src = scripts && path.join(out, scripts, 'scripts');
    if (!src || !fs.existsSync(src)) throw new Error('unexpected wheel layout');
    rm(uvDir());
    const bin = path.join(uvDir(), 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(bin, f));
      if (!isWin) fs.chmodSync(path.join(bin, f), 0o755);
    }
    return { version: rel.version };
  } finally {
    rm(tmp);
  }
}

// 同一个运行环境同时只装一次
const running = new Map();
function install(rt, onProgress = () => {}) {
  if (!canInstall(rt)) return Promise.reject(new Error(`cannot auto-install ${rt}`));
  if (running.has(rt)) return running.get(rt);
  fs.mkdirSync(baseDir, { recursive: true });
  const p = (rt === 'node' ? installNode(onProgress) : installUv(onProgress)).finally(() => running.delete(rt));
  running.set(rt, p);
  return p;
}
const isInstalling = (rt) => running.has(rt);

module.exports = { init, binDirs, canInstall, install, isInstalling };
