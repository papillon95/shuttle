// Markdown 渲染：主窗口和快捷小窗共用。
// 依赖页面里先定义好的 esc()（HTML 转义）和 T()（文案），这里只用函数声明，调用时才去取它们。
// ---------- Markdown ----------
// 够用的 Markdown：标题、段落、列表（两级）、引用、表格、分隔线、代码块，行内的代码 / 粗体 / 斜体 / 删除线 / 链接
// 所有内容先转义再加标签，模型输出里的 HTML 不会被执行；链接点击后用系统浏览器打开（只允许 http/https）
function mdInline(t) {
  const codes = [];
  let s = esc(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, txt, url) => `<a data-href="${url}" title="${url}">${txt}</a>`)
    .replace(/(^|[\s（(：:])(https?:\/\/[^\s<）)，。]+)/g, (_, pre, url) => `${pre}<a data-href="${url}">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const tableCells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
function mdBlock(text) {
  const lines = text.split('\n');
  let out = '';
  let para = [];
  const flushPara = () => {
    if (para.length) out += `<p>${para.map(mdInline).join('<br>')}</p>`;
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      flushPara();
      continue;
    }
    // 标题
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara();
      const lv = Math.min(m[1].length, 4);
      out += `<div class="h h${lv}">${mdInline(m[2].replace(/\s#+\s*$/, ''))}</div>`;
      continue;
    }
    // 分隔线
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out += '<hr>';
      continue;
    }
    // 表格：表头 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const head = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      i--;
      const td = (tag, c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${mdInline(c)}</${tag}>`;
      out += `<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    // 引用
    if (/^\s*>/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out += `<blockquote>${mdBlock(q.join('\n'))}</blockquote>`;
      continue;
    }
    // 列表（缩进 2 个空格以上算第二级）
    if (/^\s*([-*+•]|\d+[.)、])\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && (/^\s*([-*+•]|\d+[.)、])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const l = lines[i++];
        const lm = /^(\s*)([-*+•]|\d+[.)、])\s+(.*)$/.exec(l);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, '  ').length, ordered: /\d/.test(lm[2]), text: lm[3] });
        else items[items.length - 1].text += ' ' + l.trim();
      }
      i--;
      const base = items[0].indent;
      let html = '';
      const stack = [];
      for (const it of items) {
        const lv = it.indent > base + 1 ? 1 : 0;
        const tag = it.ordered ? 'ol' : 'ul';
        while (stack.length > lv + 1) html += `</li></${stack.pop()}>`;
        if (stack.length === lv) {
          html += `<${tag}>`;
          stack.push(tag);
        } else html += '</li>';
        html += `<li>${mdInline(it.text)}`;
      }
      while (stack.length) html += `</li></${stack.pop()}>`;
      out += html;
      continue;
    }
    para.push(line);
  }
  flushPara();
  return out;
}
// ---------- 代码高亮 ----------
// 轻量的通用高亮：注释、字符串、数字、关键字、类型名、函数名、注解。不追求完全准确，按语言族挑注释写法和关键字。
const HL_KW = new Set(('abstract and as assert async await break case catch class const continue def default defer del delete do elif else enum export extends ' +
  'final finally fn for from func function go goto if impl implements import in instanceof interface is lambda let loop match mod module mut namespace new ' +
  'nonlocal not or package pass private protected pub public raise return select static struct super switch synchronized this throw throws trait try type ' +
  'typeof use val var void volatile when where while with yield true false null nil None True False undefined self Self ' +
  'then fi done esac echo export local function source sudo ' +
  'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT AND OR NOT NULL AS DISTINCT UNION PRIMARY KEY DEFAULT IS IN LIKE BETWEEN COUNT').split(' '));
const HL_TYPES = new Set('int long short byte char float double boolean bool string str number any unknown never object u8 u16 u32 u64 i8 i16 i32 i64 f32 f64 usize isize dict list tuple set'.split(' '));
function hlRegex(lang) {
  const l = lang.toLowerCase();
  const hash = /^(py|python|sh|bash|zsh|shell|console|ruby|rb|yaml|yml|toml|r|perl|pl|ps1|powershell|dockerfile|makefile|conf|ini)$/.test(l);
  const sql = /^(sql|mysql|pgsql|postgres|sqlite)$/.test(l);
  const com = hash ? '#.*' : sql ? '--.*|\\/\\*[\\s\\S]*?\\*\\/' : '\\/\\/.*|\\/\\*[\\s\\S]*?\\*\\/' + (/^(html|xml|vue|svg)$/.test(l) ? '|<!--[\\s\\S]*?-->' : '');
  return new RegExp(
    '(' + com + ')' + // 1 注释
    '|("""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)' + // 2 字符串
    '|(@[A-Za-z_][\\w.]*|\\$\\{?[A-Za-z_]\\w*\\}?)' + // 3 注解 / shell 变量
    '|\\b(0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?[lLfFdD]?)\\b' + // 4 数字
    '|([A-Za-z_][\\w]*)(?=\\s*\\()' + // 5 函数调用
    '|([A-Za-z_][\\w]*)', // 6 标识符
    'g'
  );
}
function highlight(code, lang) {
  const l = String(lang || '').toLowerCase();
  if (!l || /^(text|txt|plain|plaintext|md|markdown|output|log|diff)$/.test(l) || code.length > 60000) return esc(code);
  const json = l === 'json' || l === 'jsonc';
  const shellish = /^(sh|bash|zsh|shell|console|ps1|powershell|bat|cmd)$/.test(l);
  const re = hlRegex(l);
  let out = '';
  let last = 0;
  let mt;
  const span = (cls, t) => `<span class="tk-${cls}">${esc(t)}</span>`;
  while ((mt = re.exec(code))) {
    out += esc(code.slice(last, mt.index));
    last = re.lastIndex;
    const [t, c, s, a, n, f, id] = mt;
    if (c) out += span('com', c);
    else if (s) out += span(json && /^\s*:/.test(code.slice(last)) ? 'attr' : 'str', s);
    else if (a) out += span('attr', a);
    else if (n) out += span('num', n);
    else if (f) out += HL_KW.has(f) ? span('kw', f) : span('fn', f);
    else if (id) out += HL_KW.has(id) || (/^(sql|mysql|pgsql|postgres|sqlite)$/.test(l) && HL_KW.has(id.toUpperCase())) ? span('kw', id) : HL_TYPES.has(id) || (!shellish && /^[A-Z][a-z]\w*$/.test(id)) ? span('type', id) : esc(id);
    else out += esc(t);
  }
  return out + esc(code.slice(last));
}
function md(text) {
  // 流式输出时最后一个代码块可能还没闭合：先当作代码块显示
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) text += '\n```';
  const parts = text.split(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i += 3) {
    html += mdBlock(parts[i]);
    if (i + 2 < parts.length) {
      const lang = parts[i + 1] || '';
      html += `<div class="code"><div class="code-head"><span>${esc(lang || 'text')}</span><button class="code-copy" type="button">${esc(T('copy'))}</button></div><pre><code>${highlight(parts[i + 2].replace(/\n$/, ''), lang)}</code></pre></div>`;
    }
  }
  return html;
}
