// 补建 Gitea 发布页：把 dist/RELEASE-v<版本>.md 发到公开仓库的发布页（已经有的跳过）。
// 用法（令牌在 Gitea「设置 → 应用 → 生成令牌」，勾选仓库读写）：
//   GITEA_TOKEN=xxxx node scripts/gitea-releases.mjs 0.3.42 0.3.51
// 只给一个版本号就只补那一个。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = process.env.GITEA_TOKEN;
if (!TOKEN) {
  console.error('请先设置 GITEA_TOKEN（Gitea → 设置 → 应用 → 生成令牌）');
  process.exit(1);
}
const [from, to = from] = process.argv.slice(2);
if (!from) {
  console.error('用法：GITEA_TOKEN=xxxx node scripts/gitea-releases.mjs 0.3.42 0.3.51');
  process.exit(1);
}
const remote = execFileSync('git', ['remote', 'get-url', 'aidesk-public'], { cwd: ROOT, encoding: 'utf8' }).trim().replace(/\/\/[^@/]+@/, '//');
const m = /^(https?:\/\/.+?)\/([^/]+)\/([^/]+?)(\.git)?$/.exec(remote);
if (!m) throw new Error('看不懂公开仓库地址 ' + remote);
const [, base, owner, repo] = m;
const api = `${base}/api/v1/repos/${owner}/${repo}`;
const headers = { 'Content-Type': 'application/json', Authorization: `token ${TOKEN}` };

const num = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const versions = fs.readdirSync(path.join(ROOT, 'dist'))
  .map((f) => /^RELEASE-v(\d+\.\d+\.\d+)\.md$/.exec(f)?.[1])
  .filter((v) => v && cmp(v, from) >= 0 && cmp(v, to) <= 0)
  .sort(cmp);
if (!versions.length) {
  console.error(`dist 里没有 ${from}～${to} 的发布说明`);
  process.exit(1);
}

let made = 0;
for (const v of versions) {
  const tag = `v${v}`;
  const got = await fetch(`${api}/releases/tags/${tag}`, { headers });
  if (got.ok) {
    console.log(`  · ${tag} 已经有发布页，跳过`);
    continue;
  }
  const body = fs.readFileSync(path.join(ROOT, 'dist', `RELEASE-${tag}.md`), 'utf8');
  const r = await fetch(`${api}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ tag_name: tag, name: `Shuttle 梭子 ${tag}`, body, draft: false, prerelease: false }),
  });
  if (!r.ok) {
    console.error(`  ✗ ${tag} 创建失败：HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    continue;
  }
  const j = await r.json();
  made++;
  console.log(`  ✓ ${tag} ${j.html_url || ''}`);
}
console.log(`完成：新建 ${made} 个发布页`);
