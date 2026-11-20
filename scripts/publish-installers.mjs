// 已经打好当前版本的安装包（dist/Shuttle-<版本>-*.dmg / .exe）后，单独上传并更新下载地址：
//   上传到 COS → 写版本表 aidesk_app_version（官网下载页读这里）→ 更新清单 stable.json 里的完整安装包链接（minShell 不动）
// 用法：node scripts/publish-installers.mjs --notes "中文说明" --notes-en "English notes"
// 和 ship full 的区别：不改版本号、不发补丁、不重新打包。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONO = path.resolve(ROOT, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const BUCKET = process.env.COS_BUCKET || 'mamahug-1256157831';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE = `https://${BUCKET}.cos.${REGION}.myqcloud.com/`;
const MANIFEST_KEY = 'shuttle/updates/stable.json';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ''; };
const NOTES = arg('--notes');
const NOTES_EN = arg('--notes-en') || NOTES;
if (!NOTES) throw new Error('缺少 --notes');

function yamlValue(file, parents, key) {
  if (!fs.existsSync(file)) return undefined;
  let depth = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (depth < parents.length && m[2] === parents[depth]) depth++;
    else if (depth === parents.length && m[2] === key) return m[3].replace(/\s+#.*$/, '').replace(/^\$\{[A-Z_]+:(.*)\}$/, '$1').replace(/^["']|["']$/g, '');
  }
  return undefined;
}
const cfg = path.join(MONO, 'ruoyi-admin/src/main/resources');
const COS_ID = process.env.COS_SECRET_ID || yamlValue(path.join(cfg, 'application.yml'), ['tencent', 'cos'], 'secret-id');
const COS_KEY = process.env.COS_SECRET_KEY || yamlValue(path.join(cfg, 'application.yml'), ['tencent', 'cos'], 'secret-key');
const dev = path.join(cfg, 'application-dev.yml');
const ds = ['spring', 'datasource', 'druid', 'master'];
const url = yamlValue(dev, ds, 'url') || '';
const db = {
  host: (/mysql:\/\/([^:/]+)/.exec(url) || [])[1],
  port: Number((/mysql:\/\/[^:/]+:(\d+)/.exec(url) || [])[1] || 3306),
  user: yamlValue(dev, ds, 'username'),
  password: yamlValue(dev, ds, 'password'),
  database: (/mysql:\/\/[^/]+\/(\w+)/.exec(url) || [])[1] || 'mamahug',
};

// 1. 上传
const r = spawnSync('node', [path.join(ROOT, 'scripts/upload-installers.mjs')], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, COS_SECRET_ID: COS_ID, COS_SECRET_KEY: COS_KEY } });
if (r.status !== 0) process.exit(1);
const installers = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', `installers-v${VERSION}.json`), 'utf8'));

// 2. 版本表
const mysql = (await import('mysql2/promise')).default;
const conn = await mysql.createConnection({ ...db, connectTimeout: 15000 });
for (const [platform, arch, f] of [['mac', 'arm64', installers['mac-arm64']], ['mac', 'x64', installers['mac-x64']], ['windows', 'x64', installers['win-x64']]]) {
  await conn.execute(
    `INSERT INTO aidesk_app_version (platform, arch, version, download_url, file_size, sha256, release_notes, release_notes_en, min_supported, is_published, publish_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, NOW())
     ON DUPLICATE KEY UPDATE download_url = VALUES(download_url), file_size = VALUES(file_size), sha256 = VALUES(sha256), release_notes = VALUES(release_notes), release_notes_en = VALUES(release_notes_en)`,
    [platform, arch, VERSION, f.url, f.size, f.sha256, NOTES.slice(0, 250), NOTES_EN.slice(0, 250)]
  );
}
await conn.end();
console.log('✓ 版本表已写入 3 条安装包记录');

// 3. 清单里的完整安装包链接（minShell 不动）
const COS = (await import('cos-nodejs-sdk-v5')).default;
const cos = new COS({ SecretId: COS_ID, SecretKey: COS_KEY });
const m = await (await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`)).json();
m.full = { 'mac-arm64': installers['mac-arm64'].url, 'mac-x64': installers['mac-x64'].url, 'win-x64': installers['win-x64'].url };
const mf = path.join(os.tmpdir(), 'shuttle-stable.json');
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
await new Promise((res, rej) => cos.uploadFile({ Bucket: BUCKET, Region: REGION, Key: MANIFEST_KEY, FilePath: mf, ContentType: 'application/json', CacheControl: 'no-cache' }, (e) => (e ? rej(e) : res())));
console.log(`✓ 清单里的下载地址已换成 ${VERSION}，minShell 仍是 ${m.minShell}`);
