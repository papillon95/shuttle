#!/usr/bin/env node
// Shuttle 发版脚本
//
//   补丁更新（只改了我们自己的代码，最常用，用户只下载约 150KB）：
//     node scripts/release.mjs patch --notes "修复了……" [--notes-en "Fixed ..."]
//
//   完整更新（升级了 Electron 或改了 boot.js，需要先 npm run dist:mac / dist:win 打好安装包）：
//     node scripts/release.mjs full --notes "……"
//     之后旧版本的补丁会要求用户下载新安装包（minShell 提升到这个版本）。
//
//   环境变量（不要写进代码仓库）：
//     COS_SECRET_ID / COS_SECRET_KEY        腾讯云 COS 密钥
//     COS_BUCKET（默认 mamahug-1256157831）  COS_REGION（默认 ap-guangzhou）
//     SHUTTLE_SIGN_KEY  补丁签名私钥路径，默认 ~/.config/shuttle/release-ed25519.pem（务必备份，丢了就发不了补丁）
//     SHUTTLE_CHANNEL   版本清单名，默认 stable（测试时用 test，客户端设置 SHUTTLE_UPDATE_MANIFEST 指向它）
//   可选参数：--min-shell 0.2.0  指定补丁要求的最低安装包版本（默认沿用清单里的）
//
// 版本号取 package.json 的 version：发版前先改它（npm version patch --no-git-tag-version）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import COS from 'cos-nodejs-sdk-v5';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const [mode, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (!['patch', 'full'].includes(mode)) {
  console.error('用法：node scripts/release.mjs patch|full --notes "更新说明" [--notes-en "..."]');
  process.exit(1);
}

const BUCKET = process.env.COS_BUCKET || 'mamahug-1256157831';
const REGION = process.env.COS_REGION || 'ap-guangzhou';
const BASE = `https://${BUCKET}.cos.${REGION}.myqcloud.com/`;
const CHANNEL = process.env.SHUTTLE_CHANNEL || 'stable';
const MANIFEST_KEY = `shuttle/updates/${CHANNEL}.json`;
if (!process.env.COS_SECRET_ID || !process.env.COS_SECRET_KEY) {
  console.error('缺少环境变量 COS_SECRET_ID / COS_SECRET_KEY');
  process.exit(1);
}
const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });

async function upload(key, file, contentType, extra = {}) {
  await cos.uploadFile({ Bucket: BUCKET, Region: REGION, Key: key, FilePath: file, SliceSize: 8 * 1024 * 1024, ContentType: contentType, ...extra });
  return BASE + key;
}
async function readManifest() {
  try {
    const res = await fetch(`${BASE}${MANIFEST_KEY}?t=${Date.now()}`);
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const manifest = await readManifest();
manifest.version = VERSION;
manifest.notes = arg('notes') || manifest.notes || '';
manifest.notesEn = arg('notes-en') || arg('notes') || '';
manifest.publishedAt = new Date().toISOString();

if (mode === 'full') {
  // 上传三个安装包；之后的补丁要求至少是这个安装包版本
  const files = { 'mac-arm64': `Shuttle-${VERSION}-mac-arm64.dmg`, 'mac-x64': `Shuttle-${VERSION}-mac-x64.dmg`, 'win-x64': `Shuttle-${VERSION}-win-x64.exe` };
  const types = { dmg: 'application/x-apple-diskimage', exe: 'application/vnd.microsoft.portable-executable' };
  manifest.full = {};
  for (const [k, f] of Object.entries(files)) {
    const file = path.join(ROOT, 'dist', f);
    if (!fs.existsSync(file)) throw new Error(`没找到 ${file}，先运行 npm run dist:mac 和 npm run dist:win`);
    manifest.full[k] = await upload(`shuttle/releases/v${VERSION}/${f}`, file, types[f.split('.').pop()], { ContentDisposition: `attachment; filename="${f}"` });
    console.log('已上传', f);
  }
  manifest.minShell = VERSION;
}

// 补丁包：boot.js 之外的全部代码（src + package.json），完整安装包发布时也同时生成，方便以后从这个版本打补丁
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-patch-'));
fs.cpSync(path.join(ROOT, 'src'), path.join(stage, 'src'), { recursive: true });
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: VERSION, main: 'src/main.js' }, null, 2));
const patchFile = path.join(os.tmpdir(), `shuttle-${VERSION}.asar`);
await asar.createPackage(stage, patchFile);
const buf = fs.readFileSync(patchFile);
const hash = sha256(buf);
const keyPath = process.env.SHUTTLE_SIGN_KEY || path.join(os.homedir(), '.config/shuttle/release-ed25519.pem');
const signature = crypto.sign(null, Buffer.from(`${VERSION}\n${hash}`), fs.readFileSync(keyPath, 'utf8')).toString('base64');
const patchUrl = await upload(`shuttle/patches/v${VERSION}/shuttle-${VERSION}.asar`, patchFile, 'application/octet-stream');
if (arg('min-shell')) manifest.minShell = arg('min-shell');
manifest.patch = { url: patchUrl, size: buf.length, sha256: hash, minShell: manifest.minShell || VERSION, signature };
console.log(`补丁包 ${(buf.length / 1024).toFixed(0)} KB，已签名并上传`);

// 版本清单（禁止缓存，客户端每次都拿到最新的）
const manifestFile = path.join(os.tmpdir(), `shuttle-${CHANNEL}.json`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
await upload(MANIFEST_KEY, manifestFile, 'application/json', { CacheControl: 'no-cache' });
console.log(`版本清单已更新：${BASE}${MANIFEST_KEY}`);
console.log(JSON.stringify({ version: manifest.version, minShell: manifest.minShell, patch: { size: manifest.patch.size, url: manifest.patch.url } }, null, 2));
fs.rmSync(stage, { recursive: true, force: true });
