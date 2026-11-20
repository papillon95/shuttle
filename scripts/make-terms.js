// 把用户协议、隐私政策的 Markdown 转成手机 / 浏览器都能看的网页，放进后端的 aidesk-web/：
//   doc/aidesk/user-agreement.md → terms.html
//   doc/aidesk/privacy-policy.md → privacy.html
// 用法：node aidesk-desktop/scripts/make-terms.js（改了文档后重新跑一遍，再部署后端）
// 只支持文档里用到的写法：# / ## / ### 标题、> 引用、---、- 列表（可缩进一层）、1. 编号、| 表格 |、**加粗**、[文字](链接)、普通段落
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const WEB = path.join(ROOT, 'ruoyi-admin/src/main/resources/aidesk-web');
const DOCS = [
  { src: 'doc/aidesk/user-agreement.md', out: 'terms.html', title: 'Shuttle 用户协议' },
  { src: 'doc/aidesk/privacy-policy.md', out: 'privacy.html', title: 'Shuttle 隐私政策' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([a-z0-9./#:_-]+)\)/gi, '<a href="$2">$1</a>');

function convert(src) {
  const out = [];
  let para = [];
  let table = null; // 正在收集的表格行
  const stack = []; // 打开的列表：{ tag, indent }
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushTable = () => {
    if (!table) return;
    const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const [head, , ...body] = table;
    out.push('<div class="table"><table><thead><tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
      body.map((r) => '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
    table = null;
  };
  const closeLists = (indent = -1) => {
    while (stack.length && stack[stack.length - 1].indent > indent) out.push(`</li></${stack.pop().tag}>`);
  };
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/^\|.*\|$/.test(line)) {
      flushPara();
      closeLists();
      (table = table || []).push(line);
      continue;
    }
    flushTable();
    const m = /^(\s*)(?:(-)|(\d+)\.)\s+(.*)$/.exec(line);
    if (m) {
      flushPara();
      const indent = m[1].length;
      const tag = m[2] ? 'ul' : 'ol';
      const top = stack[stack.length - 1];
      if (!top || indent > top.indent) {
        out.push(`<${tag}>`);
        stack.push({ tag, indent });
      } else {
        closeLists(indent);
        const cur = stack[stack.length - 1];
        if (cur && cur.indent === indent && cur.tag === tag) out.push('</li>');
        else {
          if (cur && cur.indent === indent) out.push(`</li></${stack.pop().tag}>`);
          out.push(`<${tag}>`);
          stack.push({ tag, indent });
        }
      }
      out.push(`<li>${inline(m[4])}`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    // 列表项下面缩进的段落：属于上一级的列表项，先收起更深的子列表
    if (/^\s{3,}\S/.test(line) && stack.length) {
      closeLists(line.length - line.trimStart().length - 1);
      out.push(`<p>${inline(line.trim())}</p>`);
      continue;
    }
    closeLists();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) (flushPara(), out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`));
    else if (/^>\s?/.test(line)) (flushPara(), out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`));
    else if (/^---+$/.test(line)) (flushPara(), out.push('<hr>'));
    else para.push(line);
  }
  flushPara();
  flushTable();
  closeLists();
  return out.join('\n');
}

const page = (title, body) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="icon" type="image/png" href="icon-192.png?v=2">
<style>
:root { --bg: #f8f8f6; --panel: #fff; --text: #1f2328; --muted: #6b7078; --border: #e6e5e1; --head: #f4f4f1; --accent: #2f6fde; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1c1f; --panel: #232428; --text: #e6e6e6; --muted: #9a9ea6; --border: #34363b; --head: #2a2b30; --accent: #6b9bff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.75 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-text-size-adjust: 100%; }
main { max-width: 820px; margin: 0 auto; padding: 32px 20px 64px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 28px 28px 36px; }
h1 { font-size: 24px; margin: 0 0 12px; }
h2 { font-size: 18px; margin: 32px 0 10px; padding-top: 12px; border-top: 1px solid var(--border); }
h3 { font-size: 15.5px; margin: 20px 0 6px; }
blockquote { margin: 0 0 4px; color: var(--muted); font-size: 13px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
ol, ul { padding-left: 1.4em; margin: 6px 0; }
li { margin: 4px 0; }
li > ul, li > ol { margin: 4px 0; }
p { margin: 8px 0; }
strong { font-weight: 600; }
a { color: var(--accent); }
.table { overflow-x: auto; margin: 10px 0 14px; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; line-height: 1.6; }
th, td { text-align: left; vertical-align: top; padding: 8px 12px; border-bottom: 1px solid var(--border); }
th { background: var(--head); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
td:first-child { min-width: 6.5em; font-weight: 500; }
.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; color: var(--muted); font-size: 14px; }
.brand img { width: 32px; height: 32px; }
.brand nav { margin-left: auto; display: flex; gap: 14px; }
.brand nav a { text-decoration: none; }
@media (max-width: 560px) { main { padding: 16px 12px 40px; } .card { padding: 20px 16px 28px; border-radius: 12px; } h1 { font-size: 21px; } table { font-size: 12.5px; } th, td { padding: 6px 8px; } }
</style>
</head>
<body>
<main>
<div class="brand"><img src="icon-192.png?v=2" alt="">Shuttle 梭子<nav><a href="terms.html">用户协议</a><a href="privacy.html">隐私政策</a></nav></div>
<div class="card">
${body}
</div>
</main>
</body>
</html>
`;

for (const d of DOCS) {
  const html = page(d.title, convert(fs.readFileSync(path.join(ROOT, d.src), 'utf8')));
  fs.writeFileSync(path.join(WEB, d.out), html);
  console.log('wrote', d.out, Buffer.byteLength(html), 'bytes');
}
