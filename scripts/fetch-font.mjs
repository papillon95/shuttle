// 打安装包前把中文界面字体（思源黑体 Noto Sans SC，SIL OFL 开源授权）下载到 fonts/：
// 装在安装包里（不在 src 里，所以补丁不会变大），Windows / Linux 新装的用户第一次打开就是这个字体。
// 文件不进 git，打包时按需下载并核对 SHA-256。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'fonts', 'NotoSansSC-VF.woff2');
const URL = 'https://mamahug-1256157831.cos.ap-guangzhou.myqcloud.com/shuttle/fonts/NotoSansSC-VF.woff2';
const SHA = 'b5a0c63d8ea2ad277712f1c88209604b5acf007c8e2d0bffa313e3f1ad8642f1';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(FILE) && sha(fs.readFileSync(FILE)) === SHA) {
  console.log('字体已就绪：fonts/NotoSansSC-VF.woff2');
} else {
  const r = await fetch(URL);
  if (!r.ok) throw new Error('下载字体失败：HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha(buf) !== SHA) throw new Error('字体 SHA-256 不一致');
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, buf);
  console.log('已下载字体：fonts/NotoSansSC-VF.woff2（' + (buf.length / 1048576).toFixed(1) + ' MB）');
}
