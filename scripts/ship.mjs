// 一键发版：把「改版本号 → 发补丁 →（打安装包）→ 更新下载地址 → 发布说明 → 推送 → 公开仓库和标签 → Gitea 发布页」串起来
//
//   node scripts/ship.mjs patch 0.2.11 --notes "更新说明" [--notes-en "English notes"]
//       只发补丁：装了 0.2.0 及以上版本的用户重启就会更新
//   node scripts/ship.mjs full 0.3.0 --notes "更新说明" [--notes-en "..."]
//       补丁 + 重新打 macOS / Windows 安装包 + 上传 + 更新版本表和下载地址
//   加 --dry-run：只做检查、列出要做的步骤，不改任何东西
//   加 --resume：上次 full 在打安装包时失败（补丁已经发出去了），从打安装包那一步接着做
//   加 --installers-only：补丁已经发过、安装包已经在 dist 里打好，只上传安装包并换下载地址（不提交、不打标签）
//   加 --prebuilt：dist 里已经有这个版本的三个安装包，不再重新打，直接上传
//
// 密钥：COS_SECRET_ID / COS_SECRET_KEY、DB_HOST / DB_USER / DB_PASS 优先读环境变量；
//       在 mamahug 主仓库里运行、又没设置时，从 ruoyi-admin 的配置文件里读。
// GITEA_TOKEN 设置了才会自动创建 Gitea 发布页，否则只生成 dist/RELEASE-v<版本>.md，自己贴到发布页。
//
// 「完整安装包」模式不会提高 minShell：老版本用户照样能收到以后的补丁（release.mjs full 会提高，所以这里不用它）。
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONO = path.resolve(ROOT, '..');
const IN_MONO = fs.existsSync(path.join(MONO, 'ruoyi-admin'));
const BUCKET = process.env.COS_BUCKET || 'mamahug-1256157831';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE = `https://${BUCKET}.cos.${REGION}.myqcloud.com/`;
const MANIFEST_KEY = 'shuttle/updates/stable.json';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const [mode, VERSION] = argv;
const flag = (n) => argv.includes('--' + n);
const opt = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NOTES = opt('notes') || '';
const NOTES_EN = opt('notes-en') || NOTES;
const DRY = flag('dry-run');
// --installers-only：补丁早就发过了，只把 dist 里打好的安装包上传、写版本表、换下载地址、重新生成发布说明（不提交、不打标签）
const INSTALLERS_ONLY = flag('installers-only');
const RESUME = flag('resume') || INSTALLERS_ONLY;
const PREBUILT = flag('prebuilt') || INSTALLERS_ONLY;
if (!['patch', 'full'].includes(mode) || !/^\d+\.\d+\.\d+$/.test(VERSION || '') || !NOTES) {
  console.error('用法：node scripts/ship.mjs patch|full <版本号> --notes "更新说明" [--notes-en "..."] [--dry-run]');
  process.exit(1);
}

// ---------- 工具 ----------
const C = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
function die(msg) {
  console.error(C.r('✗ ' + msg));
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts, env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) die(`命令失败：${cmd} ${args.join(' ')}`);
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (r.status !== 0) die(`命令失败：${cmd} ${args.join(' ')}\n${r.stderr || ''}`);
  return r.stdout.trim();
}
const git = (...a) => capture('git', ['-C', MONO, ...a]);
function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
// 从 YAML 文本里按「父键 → 子键」粗略取值（只用于读本仓库的配置文件）
function yamlValue(file, parents, key) {
  if (!fs.existsSync(file)) return undefined;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let depth = 0;
  for (const line of lines) {
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (depth < parents.length && m[2] === parents[depth]) depth++;
    else if (depth === parents.length && m[2] === key) {
      return m[3].replace(/\s+#.*$/, '').replace(/^\$\{[A-Z_]+:(.*)\}$/, '$1').replace(/^["']|["']$/g, '');
    }
  }
  return undefined;
}

let step = 0;
const STEPS = mode === 'full' ? 11 : 9;
const say = (t) => console.log('\n' + C.b(`▶ ${++step}/${STEPS} ${t}`));

// ---------- 1. 检查 ----------
say('检查');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = await (await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`)).json();
console.log(`  线上版本 ${manifest.version}，本地 package.json ${pkg.version}，要发 ${VERSION}（${mode === 'full' ? '补丁 + 完整安装包' : '补丁'}）`);
if (RESUME) {
  if (mode !== 'full' || manifest.version !== VERSION || pkg.version !== VERSION) die(`--resume 只用于 full，且线上和 package.json 都已是 ${VERSION}（现在线上 ${manifest.version}、本地 ${pkg.version}）`);
} else if (!newer(VERSION, manifest.version)) die(`${VERSION} 不比线上的 ${manifest.version} 新`);
if (!IN_MONO) die('请在 mamahug 主仓库的 aidesk-desktop 目录里运行（推送和同步公开仓库要用到主仓库）');
// 分支和工作区的问题：正式发版直接停下；演练模式只提示
const problems = [];
const branch = git('branch', '--show-current');
if (branch !== 'master') problems.push(`当前在分支 ${branch}，请先合并到 master 再发版`);
const dirty = git('status', '--porcelain', '--', 'aidesk-desktop').split('\n').filter((l) => l && !/\.DS_Store$/.test(l) && !(RESUME && /package(-lock)?\.json$/.test(l)));
if (dirty.length) problems.push('aidesk-desktop 里有没提交的改动，先提交：\n' + dirty.join('\n'));
if (problems.length && !DRY) die(problems.join('\n'));
for (const p of problems) console.log(C.r('  ! ' + p));
const remotes = git('remote').split('\n');
if (!remotes.includes('aidesk-public')) die('缺少 git 远程 aidesk-public（公开仓库）');

const cfg = path.join(MONO, 'ruoyi-admin/src/main/resources');
const COS_ID = process.env.COS_SECRET_ID || yamlValue(path.join(cfg, 'application.yml'), ['tencent', 'cos'], 'secret-id');
const COS_KEY = process.env.COS_SECRET_KEY || yamlValue(path.join(cfg, 'application.yml'), ['tencent', 'cos'], 'secret-key');
if (!COS_ID || !COS_KEY) die('缺少 COS 密钥（COS_SECRET_ID / COS_SECRET_KEY）');
let db = null;
if (mode === 'full') {
  const url = yamlValue(path.join(cfg, 'application-dev.yml'), ['spring', 'datasource', 'druid', 'master'], 'url') || '';
  db = {
    host: process.env.DB_HOST || (/mysql:\/\/([^:/]+)/.exec(url) || [])[1],
    port: Number(process.env.DB_PORT || (/mysql:\/\/[^:/]+:(\d+)/.exec(url) || [])[1] || 3306),
    user: process.env.DB_USER || yamlValue(path.join(cfg, 'application-dev.yml'), ['spring', 'datasource', 'druid', 'master'], 'username'),
    password: process.env.DB_PASS || yamlValue(path.join(cfg, 'application-dev.yml'), ['spring', 'datasource', 'druid', 'master'], 'password'),
    database: process.env.DB_NAME || (/mysql:\/\/[^/]+\/(\w+)/.exec(url) || [])[1] || 'mamahug',
  };
  if (!db.host || !db.user || !db.password) die('缺少数据库连接（DB_HOST / DB_USER / DB_PASS）');
}
const signKey = process.env.SHUTTLE_SIGN_KEY || path.join(os.homedir(), '.config/shuttle/release-ed25519.pem');
if (!fs.existsSync(signKey)) die(`找不到补丁签名私钥 ${signKey}`);
const GITEA_TOKEN = process.env.GITEA_TOKEN;
if (db) console.log(C.d(`  数据库 ${db.user}@${db.host}:${db.port}/${db.database}`));
console.log(C.g(problems.length ? '  ✓ 密钥、签名私钥没问题' : '  ✓ 分支、工作区、密钥、签名私钥都没问题') + (GITEA_TOKEN ? '' : C.d('（没设 GITEA_TOKEN：发布页需要手动创建）')));

if (DRY) {
  const plan = [
    `把 package.json 版本改成 ${VERSION}`,
    '打补丁、签名、上传，更新版本清单',
    '下载线上补丁，核对 SHA-256 和签名',
    ...(mode === 'full' ? ['打 macOS（arm64 + x64）和 Windows x64 安装包', '上传安装包，写入版本表，更新清单里的下载地址（minShell 不变）'] : []),
    `生成发布说明 dist/RELEASE-v${VERSION}.md`,
    `提交版本号并推送 master`,
    `同步公开仓库 main，打标签 v${VERSION}`,
    '同步 GitHub（papillon95/shuttle）',
    GITEA_TOKEN ? '创建 Gitea 发布页' : '（跳过 Gitea 发布页：没有 GITEA_TOKEN）',
  ];
  console.log('\n' + C.b('演练模式，不会改任何东西。将会依次：'));
  plan.forEach((p, i) => console.log(`  ${i + 2}. ${p}`));
  process.exit(0);
}

// ---------- 2. 版本号 ----------
say(`版本号改成 ${VERSION}`);
if (RESUME) console.log(C.d('  接着上次：版本号已改好'));
else run('npm', ['version', VERSION, '--no-git-tag-version', '--allow-same-version']);

// ---------- 3. 补丁 ----------
const cosEnv = { COS_SECRET_ID: COS_ID, COS_SECRET_KEY: COS_KEY };
say('发补丁');
if (RESUME) console.log(C.d('  接着上次：补丁已发布'));
else run('node', ['scripts/release.mjs', 'patch', '--notes', NOTES, '--notes-en', NOTES_EN], { env: cosEnv });

// ---------- 4. 校验 ----------
say('核对线上补丁');
{
  const m = await (await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`)).json();
  const buf = Buffer.from(await (await fetch(m.patch.url)).arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const pub = /PUBLIC_KEY = `([\s\S]*?)`/.exec(fs.readFileSync(path.join(ROOT, 'src/updater.js'), 'utf8'))[1];
  const sigOk = crypto.verify(null, Buffer.from(`${m.version}\n${hash}`), pub, Buffer.from(m.patch.signature, 'base64'));
  if (m.version !== VERSION || hash !== m.patch.sha256 || !sigOk) die(`补丁核对失败：版本 ${m.version}，SHA 一致 ${hash === m.patch.sha256}，签名 ${sigOk}`);
  console.log(C.g(`  ✓ 补丁 ${VERSION}：SHA-256 一致，签名有效，minShell ${m.patch.minShell}`));
}

// ---------- 5/6. 完整安装包 ----------
let installers = null;
if (mode === 'full') {
  say('打 macOS 和 Windows 安装包（十几分钟）');
  // 两个架构的 dmg 用同名临时磁盘，偶尔卸载失败（hdiutil detach 返回 16 / 1）：先清掉残留的，失败了再清一次重试
  const detachStale = () => {
    for (const v of fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : []) {
      if (/^Shuttle /.test(v)) spawnSync('hdiutil', ['detach', '-force', path.join('/Volumes', v)], { stdio: 'ignore' });
    }
  };
  const built = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'].every((f) => fs.existsSync(path.join(ROOT, 'dist', `Shuttle-${VERSION}-${f}`)));
  if (PREBUILT && built) console.log(C.d('  用 dist 里已经打好的安装包'));
  else {
    if (PREBUILT) die('--prebuilt：dist 里缺这个版本的安装包');
    detachStale();
    if (spawnSync('npm', ['run', 'dist:mac'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
      console.log(C.d('  dmg 打包失败，清理临时磁盘后重试一次'));
      detachStale();
      if (spawnSync('npm', ['run', 'dist:mac'], { cwd: ROOT, stdio: 'inherit' }).status !== 0) {
        // 临时磁盘一直卸载不了（资源忙）：改用不挂载磁盘的办法生成 dmg
        console.log(C.d('  还是失败，改用 scripts/mac-dmg.sh（不挂载临时磁盘）'));
        detachStale();
        run('bash', ['scripts/mac-dmg.sh', VERSION]);
      }
    }
    run('npm', ['run', 'dist:win']);
  }

  say('上传安装包、写版本表、更新下载地址');
  run('node', ['scripts/upload-installers.mjs'], { env: cosEnv });
  installers = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', `installers-v${VERSION}.json`), 'utf8'));

  // 版本表（官网下载页和客户端「检查更新」读这里）
  const notesShort = NOTES.slice(0, 250);
  const rows = [
    ['mac', 'arm64', installers['mac-arm64']],
    ['mac', 'x64', installers['mac-x64']],
    ['windows', 'x64', installers['win-x64']],
  ];
  const mysql = (await import('mysql2/promise')).default;
  const conn = await mysql.createConnection({ ...db, connectTimeout: 15000 });
  for (const [platform, arch, f] of rows) {
    await conn.execute(
      `INSERT INTO aidesk_app_version (platform, arch, version, download_url, file_size, sha256, release_notes, release_notes_en, min_supported, is_published, publish_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NOW())
       ON DUPLICATE KEY UPDATE download_url = VALUES(download_url), file_size = VALUES(file_size), sha256 = VALUES(sha256), release_notes = VALUES(release_notes), release_notes_en = VALUES(release_notes_en)`,
      [platform, arch, VERSION, f.url, f.size, f.sha256, notesShort, NOTES_EN.slice(0, 250)]
    );
  }
  await conn.end();
  console.log(C.g('  ✓ 版本表已写入 3 条安装包记录'));

  // 清单里的完整安装包链接（minShell 不动）
  const COS = (await import('cos-nodejs-sdk-v5')).default;
  const cos = new COS({ SecretId: COS_ID, SecretKey: COS_KEY });
  const m = await (await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`)).json();
  m.full = { 'mac-arm64': installers['mac-arm64'].url, 'mac-x64': installers['mac-x64'].url, 'win-x64': installers['win-x64'].url };
  const mf = path.join(os.tmpdir(), 'shuttle-stable.json');
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  await new Promise((res, rej) =>
    cos.uploadFile({ Bucket: BUCKET, Region: REGION, Key: MANIFEST_KEY, FilePath: mf, ContentType: 'application/json', CacheControl: 'no-cache' }, (e) => (e ? rej(e) : res()))
  );
  console.log(C.g(`  ✓ 清单里的下载地址已换成 ${VERSION}，minShell 仍是 ${m.minShell}`));
}

// ---------- 发布说明 ----------
say('生成发布说明');
const m = await (await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`)).json();
const fullVer = /\/v(\d+\.\d+\.\d+)\//.exec(Object.values(m.full || {})[0] || '')?.[1];
let info = installers;
if (!info && fullVer && fs.existsSync(path.join(ROOT, 'dist', `installers-v${fullVer}.json`))) info = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', `installers-v${fullVer}.json`), 'utf8'));
const sizeOf = async (k) => info?.[k]?.size || Number((await fetch(m.full[k], { method: 'HEAD' })).headers.get('content-length')) || 0;
const mb = (n) => (n ? `${Math.round(n / 1024 / 1024)} MB` : '');
const label = { 'mac-arm64': 'macOS（Apple 芯片 M1/M2/M3/M4）', 'mac-x64': 'macOS（Intel 芯片）', 'win-x64': 'Windows 10/11（64 位）' };
const rowsMd = [];
for (const k of ['mac-arm64', 'mac-x64', 'win-x64']) {
  if (!m.full?.[k]) continue;
  rowsMd.push(`| ${label[k]} | [${m.full[k].split('/').pop()}](${m.full[k]}) | ${mb(await sizeOf(k))} |`);
}
const bullets = NOTES.split(/[；;]\s*/).map((s) => s.trim().replace(/[。.]$/, '')).filter(Boolean);
const md = [
  `## Shuttle 梭子 v${VERSION}`,
  '',
  '### 更新内容',
  ...bullets.map((b) => `- ${b}`),
  '',
  '> 0.2.0 及以上版本的用户会自动收到更新，重启 Shuttle 即可，不用重新下载安装包。',
  '',
  '### 下载',
  fullVer && fullVer !== VERSION ? `安装包是 v${fullVer}，安装后第一次打开会自动更新到 v${VERSION}。\n` : '',
  '| 系统 | 下载 | 大小 |',
  '|---|---|---|',
  ...rowsMd,
  '',
  ...(info
    ? ['<details><summary>SHA-256 校验值</summary>', '', '```', ...['mac-arm64', 'mac-x64', 'win-x64'].filter((k) => info[k]).map((k) => `${info[k].sha256}  ${info[k].url.split('/').pop()}`), '```', '</details>', '']
    : []),
  '### 首次打开',
  '安装包暂未签名，系统会拦一下：',
  '- **macOS**：提示「无法验证开发者」时，打开「系统设置 → 隐私与安全性」，在下方点「仍要打开」。',
  '- **Windows**：出现「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。',
  '',
]
  .filter((l) => l !== null)
  .join('\n');
const mdFile = path.join(ROOT, 'dist', `RELEASE-v${VERSION}.md`);
fs.mkdirSync(path.dirname(mdFile), { recursive: true });
fs.writeFileSync(mdFile, md);
console.log(C.g(`  ✓ ${path.relative(MONO, mdFile)}`));
if (INSTALLERS_ONLY) {
  console.log('\n' + C.g(C.b(`✓ v${VERSION} 安装包已上传，下载地址已更新`)) + C.d('（--installers-only：没有提交、打标签、同步仓库）'));
  process.exit(0);
}

// ---------- 提交、推送 ----------
say('提交版本号并推送 master');
git('add', 'aidesk-desktop/package.json', 'aidesk-desktop/package-lock.json');
git('commit', '-q', '-m', `chore(aidesk-desktop): v${VERSION}`);
run('git', ['-C', MONO, 'push', '-q', 'origin', 'master'], { env: { GIT_TERMINAL_PROMPT: '0' } });

say('同步公开仓库并打标签');
git('subtree', 'split', '--prefix=aidesk-desktop', '-b', 'aidesk-desktop-public');
run('git', ['-C', MONO, 'push', '-q', 'aidesk-public', 'aidesk-desktop-public:main'], { env: { GIT_TERMINAL_PROMPT: '0' } });
git('tag', '-a', `aidesk-desktop-v${VERSION}`, 'aidesk-desktop-public', '-m', `Shuttle v${VERSION}`);
run('git', ['-C', MONO, 'push', '-q', 'aidesk-public', `aidesk-desktop-v${VERSION}:refs/tags/v${VERSION}`], { env: { GIT_TERMINAL_PROMPT: '0' } });
console.log(C.g(`  ✓ 公开仓库 main 已同步，标签 v${VERSION}`));

// ---------- GitHub 开源仓库 ----------
// 失败不影响这次发版（补丁和安装包都已经发出去了），只提醒之后手动补同步
say('同步 GitHub');
{
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/sync-github.sh')], { cwd: MONO, encoding: 'utf8' });
  const tail = `${r.stdout || ''}${r.stderr || ''}`.split(/[\r\n]+/).filter((l) => l && !/^Rewrite /.test(l)).slice(-3).join('\n');
  if (r.status === 0) console.log(C.g(`  ${tail.split('\n').pop()}`));
  else console.log(C.r(`  ✗ 同步 GitHub 失败，发版不受影响，稍后手动运行 aidesk-desktop/scripts/sync-github.sh\n${tail}`));
}

// ---------- Gitea 发布页 ----------
say('Gitea 发布页');
if (!GITEA_TOKEN) {
  console.log(C.d(`  没有 GITEA_TOKEN，跳过。把 ${path.relative(MONO, mdFile)} 贴到公开仓库的发布页即可。`));
} else {
  // 远程地址形如 https://richbrian.site/git/<owner>/<repo>.git
  const remote = git('remote', 'get-url', 'aidesk-public').replace(/\/\/[^@/]+@/, '//');
  const mm = /^(https?:\/\/.+?)\/([^/]+)\/([^/]+?)(\.git)?$/.exec(remote);
  if (!mm) die(`看不懂公开仓库地址 ${remote}`);
  const [, base, owner, repo] = mm;
  const r = await fetch(`${base}/api/v1/repos/${owner}/${repo}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${GITEA_TOKEN}` },
    body: JSON.stringify({ tag_name: `v${VERSION}`, name: `Shuttle 梭子 v${VERSION}`, body: md, draft: false, prerelease: false }),
  });
  if (!r.ok) die(`创建发布页失败：HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  console.log(C.g(`  ✓ ${j.html_url || '发布页已创建'}`));
}

console.log('\n' + C.g(C.b(`✓ v${VERSION} 发布完成`)));
