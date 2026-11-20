// 读取办公文档：.docx / .xlsx / .pptx 本质是 zip + XML，这里自己解析；.pdf 用 vendor 进来的 pdfjs。
// 不依赖任何 npm 包（客户端补丁只打包 src/ 和 package.json）。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { t } = require('./i18n');

let lang = 'zh';
const T = (key, vars) => t(lang, key, vars);
function setLang(l) {
  lang = l;
}

const DOC_EXTS = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);
// 每个工作表最多输出的行数
const MAX_SHEET_ROWS = 500;

function isDocument(p) {
  return DOC_EXTS.has(path.extname(p).toLowerCase());
}

// ---------- zip 读取 ----------

// 解析 zip 中央目录，返回 { 文件名: 读取函数 }。只支持 store(0) 和 deflate(8)，办公文档够用。
function readZip(buf) {
  // 从尾部找"中央目录结束记录"（签名 0x06054b50），后面可能跟最多 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(T('docBadZip'));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(T('docBadZip'));
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries[name] = () => {
      // 本地文件头的文件名/扩展字段长度可能和中央目录不同，要以本地头为准
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(T('docBadZip'));
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (name) => name in entries,
    names: () => Object.keys(entries),
    text: (name) => (entries[name] ? entries[name]().toString('utf8') : null),
  };
}

// ---------- XML 小工具 ----------

function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

// 取出 xml 中所有 <tag>…</tag> 的文本（tag 如 w:t、a:t、t），自闭合的跳过
function texts(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  let m;
  while ((m = re.exec(xml))) out += decodeXml(m[1]);
  return out;
}

// Markdown 表格的单元格：去掉换行和竖线
function cell(s) {
  return String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

function mdTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (r) => '| ' + Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(' | ') + ' |';
  const out = [line(rows[0]), '| ' + Array(width).fill('---').join(' | ') + ' |'];
  for (const r of rows.slice(1)) out.push(line(r));
  return out.join('\n');
}

// ---------- docx ----------

// 段落文本：<w:t> 拼接，<w:tab/> 转制表符，<w:br/> 转换行
function docxParagraph(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0] === '<w:tab/>') out += '\t';
    else out += '\n';
  }
  return out;
}

// 找到与 start 处开标签配对的闭标签结束位置（处理嵌套表格）
function matchEnd(xml, start, tag) {
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else depth++;
  }
  return xml.length;
}

function docxTable(xml) {
  const rows = [];
  for (const tr of xml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) || []) {
    const cells = (tr.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) || []).map((tc) =>
      (tc.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) || []).map(docxParagraph).join(' ')
    );
    rows.push(cells);
  }
  return mdTable(rows);
}

function readDocx(zip) {
  const xml = zip.text('word/document.xml');
  if (xml == null) throw new Error(T('docBadFormat', { ext: 'docx' }));
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1];
  const blocks = [];
  // 按顺序扫描顶层段落和表格
  const re = /<w:tbl[\s>]|<w:p[\s>]|<w:p\/>/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[0] === '<w:p/>') {
      blocks.push('');
      continue;
    }
    const tag = m[0].startsWith('<w:tbl') ? 'w:tbl' : 'w:p';
    const end = matchEnd(body, m.index, tag);
    const part = body.slice(m.index, end);
    blocks.push(tag === 'w:tbl' ? '\n' + docxTable(part) + '\n' : docxParagraph(part));
    re.lastIndex = end;
  }
  return blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- xlsx ----------

// "AB12" → 列号（从 0 开始）
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || ['A'])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(zip) {
  const wb = zip.text('xl/workbook.xml');
  if (wb == null) throw new Error(T('docBadFormat', { ext: 'xlsx' }));
  // 共享字符串：每个 <si> 可能由多个 <r><t> 富文本片段组成
  const shared = [];
  const sst = zip.text('xl/sharedStrings.xml');
  if (sst) for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(texts(si.replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't'));
  // 工作表名 → 文件：通过 workbook.xml.rels 的 r:id 对应，找不到时按顺序 sheetN.xml
  const rels = {};
  const relXml = zip.text('xl/_rels/workbook.xml.rels') || '';
  for (const r of relXml.match(/<Relationship\s[^>]*>/g) || []) {
    let target = attr(r, 'Target') || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    rels[attr(r, 'Id')] = path.posix.normalize(target);
  }
  const sheets = (wb.match(/<sheet\s[^>]*>/g) || []).map((s, i) => ({
    name: attr(s, 'name') || `Sheet${i + 1}`,
    file: rels[attr(s, 'r:id')] || `xl/worksheets/sheet${i + 1}.xml`,
  }));
  const parts = [];
  for (const sh of sheets) {
    const xml = zip.text(sh.file) || '';
    const rows = [];
    for (const rm of xml.match(/<row\s[^>]*\/>|<row[\s>][\s\S]*?<\/row>/g) || []) {
      const rowNo = Number(attr(rm.match(/<row[^>]*>/)[0], 'r')) || rows.length + 1;
      if (rm.endsWith('/>') && !rm.includes('</row>')) continue;
      const row = [];
      for (const cm of rm.match(/<c\s[^>]*\/>|<c[\s>][\s\S]*?<\/c>/g) || []) {
        const head = cm.match(/<c[^>]*>/)[0];
        const ref = attr(head, 'r');
        const type = attr(head, 't');
        const v = (cm.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (type === 's') val = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') val = texts(cm, 't');
        else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) val = decodeXml(v);
        row[ref ? colIndex(ref) : row.length] = val;
      }
      rows[rowNo - 1] = row;
    }
    // 补齐空行、空单元格，去掉尾部全空行
    const dense = Array.from(rows, (r) => Array.from(r || [], (c) => c ?? ''));
    while (dense.length && dense[dense.length - 1].every((c) => c === '')) dense.pop();
    const cols = Math.max(0, ...dense.map((r) => r.length));
    let body = mdTable(dense.slice(0, MAX_SHEET_ROWS));
    if (dense.length > MAX_SHEET_ROWS) body += '\n' + T('docSheetMore', { n: MAX_SHEET_ROWS, total: dense.length });
    parts.push(T('docSheet', { name: sh.name, rows: dense.length, cols }) + '\n' + (body || T('docSheetEmpty')));
  }
  return parts.join('\n\n');
}

// ---------- pptx ----------

function readPptx(zip) {
  const slides = zip
    .names()
    .map((n) => n.match(/^ppt\/slides\/slide(\d+)\.xml$/))
    .filter(Boolean)
    .sort((a, b) => a[1] - b[1]);
  if (!slides.length && !zip.has('ppt/presentation.xml')) throw new Error(T('docBadFormat', { ext: 'pptx' }));
  return slides
    .map((m, i) => {
      const xml = zip.text(m[0]);
      // 每个 <a:p> 是一个段落
      const paras = (xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/g) || []).map((p) => texts(p, 'a:t')).filter((s) => s.trim());
      return T('docPage', { n: i + 1 }) + '\n' + paras.join('\n');
    })
    .join('\n\n');
}

// ---------- pdf ----------

const PDFJS_DIR = path.join(__dirname, 'vendor', 'pdfjs');
let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Electron 33 内置 Node 20，没有 process.getBuiltinModule，pdfjs 4.x 依赖它读 cmaps，这里补上
      if (typeof process.getBuiltinModule !== 'function') {
        process.getBuiltinModule = (name) => require(name.replace(/^node:/, ''));
      }
      // 先把 worker 模块加载到 globalThis.pdfjsWorker，pdfjs 会直接在主线程里用它（不起真正的 worker）
      const worker = await import(pathToFileURL(path.join(PDFJS_DIR, 'pdf.worker.min.mjs')).href);
      globalThis.pdfjsWorker = worker;
      // pdfjs 加载时会因为没有 canvas 打印几条"渲染可能异常"的警告，只取文字用不到 canvas，屏蔽掉
      const log = console.log;
      console.log = (...a) => {
        if (!/^Warning: Cannot (load|polyfill)/.test(String(a[0]))) log(...a);
      };
      let lib;
      try {
        lib = await import(pathToFileURL(path.join(PDFJS_DIR, 'pdf.min.mjs')).href);
      } finally {
        console.log = log;
      }
      lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS_DIR, 'pdf.worker.min.mjs')).href;
      return lib;
    })().catch((e) => {
      pdfjsPromise = null;
      throw e;
    });
  }
  return pdfjsPromise;
}

// 有些字体把「一」「长」「页」这类字映射成长得一样的部首字符（⼀ ⻓ ⻚），搜索和引用会对不上：
// 康熙部首区（U+2F00–2FD5）用 NFKC 转回常用汉字；部首补充区（U+2E80–2EFF）没有兼容分解，查表转换。
// 只处理这两个区，不对全文做 NFKC（那会把中文全角标点改成半角）。
const RADICAL_SUPPLEMENT = {"⺁":"厂","⺇":"几","⺈":"⺈","⺋":"㔾","⺍":"⺍","⺎":"兀","⺏":"尣","⺐":"尢","⺑":"𡯂","⺒":"巳","⺓":"幺","⺛":"旡","⺝":"月","⺟":"母","⺠":"民","⺡":"氵","⺢":"氺","⺣":"灬","⺤":"爫","⺥":"爫","⺦":"丬","⺧":"牜","⺨":"犭","⺩":"王","⺪":"疋","⺫":"罒","⺬":"示","⺭":"礻","⺮":"⺮","⺯":"糹","⺰":"纟","⺱":"罓","⺲":"罒","⺳":"网","⺴":"罓","⺵":"罒","⺶":"羊","⺷":"羊","⺸":"羋","⺹":"耂","⺺":"肀","⺻":"聿","⺼":"月","⺽":"臼","⺾":"艹","⺿":"艹","⻀":"艹","⻁":"虎","⻂":"衤","⻃":"覀","⻄":"西","⻅":"见","⻆":"角","⻇":"角","⻈":"讠","⻉":"贝","⻊":"足","⻋":"车","⻌":"辶","⻍":"辶","⻎":"辶","⻏":"阝","⻐":"钅","⻑":"長","⻒":"镸","⻓":"长","⻔":"门","⻕":"门","⻖":"阝","⻗":"雨","⻘":"青","⻙":"韦","⻚":"页","⻛":"风","⻜":"飞","⻝":"食","⻞":"食","⻟":"飠","⻠":"饣","⻡":"首","⻢":"马","⻣":"骨","⻤":"鬼","⻥":"鱼","⻦":"鸟","⻧":"卤","⻨":"麦","⻩":"黄","⻪":"黾","⻫":"斉","⻬":"齐","⻭":"歯","⻮":"齿","⻯":"竜","⻰":"龙","⻱":"龜","⻲":"亀","⻳":"龟"};
function fixRadicals(text) {
  return text.replace(/[\u2E80-\u2EFF\u2F00-\u2FD5]/g, (c) => RADICAL_SUPPLEMENT[c] || c.normalize('NFKC'));
}

async function readPdf(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    cMapUrl: path.join(PDFJS_DIR, 'cmaps') + path.sep,
    cMapPacked: true,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pages = [];
    let chars = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const it of content.items) {
        if (typeof it.str !== 'string') continue;
        text += it.str;
        if (it.hasEOL) text += '\n';
      }
      text = fixRadicals(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      chars += text.replace(/\s/g, '').length;
      pages.push(T('docPage', { n: i }) + '\n' + text);
      page.cleanup();
    }
    // 平均每页不到 10 个字符，基本是扫描件或纯图片
    if (chars < Math.max(10, doc.numPages * 10)) {
      return T('docPdfScanned', { n: doc.numPages }) + (chars ? '\n\n' + pages.join('\n\n') : '');
    }
    return pages.join('\n\n');
  } finally {
    await doc.destroy();
  }
}

// ---------- 入口 ----------

async function readDocument(abs) {
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  if (ext === '.pdf') return readPdf(buf);
  const zip = readZip(buf);
  if (ext === '.docx') return readDocx(zip);
  if (ext === '.xlsx') return readXlsx(zip);
  if (ext === '.pptx') return readPptx(zip);
  throw new Error(T('docBadFormat', { ext }));
}

module.exports = { fixRadicals, setLang, isDocument, readDocument, readZip, decodeXml };
