// 只上传完整安装包（不改版本清单），打印大小和 SHA-256，供更新下载地址用
//   COS_SECRET_ID=… COS_SECRET_KEY=… node scripts/upload-installers.mjs
// 和 release.mjs full 的区别：不会把 minShell 提到这个版本，老版本用户照常收到以后的补丁。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import COS from 'cos-nodejs-sdk-v5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const BUCKET = process.env.COS_BUCKET || 'mamahug-1256157831';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE = `https://${BUCKET}.cos.${REGION}.myqcloud.com/`;
if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY) throw new Error('缺少环境变量 COS_SECRET_ID / COS_SECRET_KEY');
const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });

const files = { 'mac-arm64': `Shuttle-${VERSION}-mac-arm64.dmg`, 'mac-x64': `Shuttle-${VERSION}-mac-x64.dmg`, 'win-x64': `Shuttle-${VERSION}-win-x64.exe` };
const types = { dmg: 'application/x-apple-diskimage', exe: 'application/vnd.microsoft.portable-executable' };
const out = {};
for (const [k, f] of Object.entries(files)) {
  const file = path.join(ROOT, 'dist', f);
  if (!fs.existsSync(file)) throw new Error(`没找到 ${file}`);
  const buf = fs.readFileSync(file);
  const key = `shuttle/releases/v${VERSION}/${f}`;
  await cos.uploadFile({ Bucket: BUCKET, Region: REGION, Key: key, FilePath: file, SliceSize: 8 * 1024 * 1024, ContentType: types[f.split('.').pop()], ContentDisposition: `attachment; filename="${f}"` });
  out[k] = { url: BASE + key, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  console.log('已上传', f);
}
fs.writeFileSync(path.join(ROOT, 'dist', `installers-v${VERSION}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
