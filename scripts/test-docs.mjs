// 自测 src/docs.js：现场生成最小的 docx / xlsx / pptx / pdf，读取后断言能读出预期文字。
// 用法：node scripts/test-docs.mjs（全部通过退出码 0）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = require(path.join(root, 'src/docs.js'));
const tools = require(path.join(root, 'src/tools.js'));

// ---------- 最小 zip 写入器 ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: { 名称: 字符串 }；deflate 为 true 时用 deflate 压缩，否则 store
function makeZip(files, deflate = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(files).length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ---------- 样例文档 ----------

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'word/document.xml':
    `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>` +
    '<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">销售 &amp; 市场 </w:t></w:r><w:r><w:t>&lt;第一季度&gt;</w:t></w:r></w:p>' +
    '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>月份</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc></w:tr>' +
    '<w:tr><w:tc><w:p><w:r><w:t>一月</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>结尾段落</w:t></w:r></w:p>' +
    '</w:body></w:document>',
}, true);

const sheetXml = (rows) =>
  '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  rows +
  '</sheetData></worksheet>';
const xlsx = makeZip({
  'xl/workbook.xml':
    '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    '<sheet name="销量" sheetId="1" r:id="rId1"/><sheet name="R&amp;D" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml':
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">' +
    '<si><t>月份</t></si><si><t>销量</t></si><si><r><t>一</t></r><r><t>月</t></r></si><si><t>二月</t></si></sst>',
  'xl/worksheets/sheet1.xml': sheetXml(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>达标</t></is></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" t="b"><v>1</v></c></row>' +
      '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><f>B2*2</f><v>2469</v></c><c r="C3" t="b"><v>0</v></c></row>'
  ),
  'xl/worksheets/sheet2.xml': sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="C1"><v>-7</v></c></row>'),
});

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (...paras) =>
  `<?xml version="1.0"?><p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody>` +
  paras.map((t) => `<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`).join('') +
  '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
// 故意让 slide10 排在 slide2 前面，验证按数字排序
const pptx = makeZip({
  'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation/>',
  'ppt/slides/slide1.xml': slide('封面标题', '副标题'),
  'ppt/slides/slide10.xml': slide('最后一页'),
  'ppt/slides/slide2.xml': slide('第二页内容 &quot;引用&quot;'),
});

// 手写 PDF：每页一个文本对象，pages 为每页文字（空字符串表示无文字的页）
// 以 < 开头的文字按十六进制字符串原样写入；font 可替换默认的 Helvetica
function makePdf(pages, font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>') {
  const objs = [];
  const n = pages.length;
  // 1 目录，2 页树，3 字体，之后每页占两个对象（页 + 内容流）
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
  objs[3] = font;
  pages.forEach((text, i) => {
    const str = text.startsWith('<') ? text : `(${text})`;
    const stream = text ? `BT /F1 24 Tf 72 700 Td ${str} Tj ET` : '0 0 1 rg 72 72 200 200 re f';
    objs[4 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`;
    objs[5 + i * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------- 断言 ----------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuttle-docs-'));
const write = (name, buf) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
};
write('a.docx', docx);
write('b.xlsx', xlsx);
write('c.pptx', pptx);
write('d.pdf', makePdf(['Hello PDF page one', 'Second page text here']));
write('e.pdf', makePdf(['', '']));
// 中文 PDF：未嵌入字体的 CID 字体 + UniGB-UCS2-H 编码，需要 vendor 的 cmaps 才能还原文字
const cjkFont =
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>] >>';
const ucs2 = (s) => '<' + Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase() + '>';
write('h.pdf', makePdf([ucs2('中文测试文档第一页'), ucs2('第二页的中文内容')], cjkFont));

let failed = 0;
function check(label, text, expects, rejects = []) {
  const miss = expects.filter((e) => !text.includes(e));
  const bad = rejects.filter((e) => text.includes(e));
  if (miss.length || bad.length) {
    failed++;
    console.error(`✗ ${label}`);
    if (miss.length) console.error('  缺少：', miss);
    if (bad.length) console.error('  不应出现：', bad);
    console.error(text.split('\n').map((l) => '  | ' + l).join('\n'));
  } else console.log(`✓ ${label}`);
}

try {
  const d = await docs.readDocument(path.join(dir, 'a.docx'));
  check('docx 段落、实体、表格', d, ['季度报告', '销售 & 市场 <第一季度>', '| 月份 | 销量 |', '| --- | --- |', '| 一月 | 120 |', '结尾段落']);
  if (d.indexOf('季度报告') > d.indexOf('| 月份') || d.indexOf('| 一月') > d.indexOf('结尾段落')) check('docx 顺序', 'x', ['顺序正确']);

  const x = await docs.readDocument(path.join(dir, 'b.xlsx'));
  check('xlsx 多工作表、共享/内联字符串、数字、布尔', x, [
    '## 工作表「销量」（3 行 × 3 列）',
    '| 月份 | 销量 | 达标 |',
    '| 一月 | 1234.5 | TRUE |',
    '| 二月 | 2469 | FALSE |',
    '## 工作表「R&D」（1 行 × 3 列）',
    '| 项目 |  | -7 |',
  ]);

  const p = await docs.readDocument(path.join(dir, 'c.pptx'));
  check('pptx 按页顺序', p, ['--- 第 1 页 ---\n封面标题\n副标题', '--- 第 2 页 ---\n第二页内容 "引用"', '--- 第 3 页 ---\n最后一页']);

  const pdf = await docs.readDocument(path.join(dir, 'd.pdf'));
  check('pdf 多页', pdf, ['--- 第 1 页 ---\nHello PDF page one', '--- 第 2 页 ---\nSecond page text here'], ['扫描件']);

  // 真实的中文 PDF（Chromium 打印生成，字体子集嵌入 + ToUnicode），并检查康熙部首被规范成常用汉字
  const cjk = await docs.readDocument(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'zh-report.pdf'));
  check('pdf 中文', cjk, ['季度销售报告', '第一季度销售额为 128 万元，同比增长 15%。', '--- 第 2 页 ---\n第二页', '华东区表现最好，占总销售额的 42%。'], ['扫描件', '⼀', '⽐', '⻓', '⻚']);

  const scan = await docs.readDocument(path.join(dir, 'e.pdf'));
  check('pdf 扫描件提示', scan, ['（共 2 页）这可能是扫描件，没有可提取的文字。']);

  // 经由 read_file 工具：行号 + start/end 截取
  const r = await tools.readFile(dir, 'b.xlsx', 1, 3);
  check('read_file 行号与截取', r, ['    1  ## 工作表「销量」', '    3  | --- | --- | --- |'], ['一月']);
  const txt = write('f.txt', 'plain\ntext');
  check('read_file 普通文本仍同步返回', String(tools.readFile(dir, path.basename(txt))), ['    2  text']);

  tools.setLang('en');
  const en = await docs.readDocument(path.join(dir, 'c.pptx'));
  check('英文文案', en, ['--- Page 1 ---']);
  tools.setLang('zh');

  try {
    await tools.readFile(dir, write('g.docx', Buffer.from('not a zip')));
    check('损坏文件报错', '', ['应抛错']);
  } catch (e) {
    check('损坏文件报错', e.message, ['读取文档失败']);
  }
} catch (e) {
  failed++;
  console.error('✗ 异常：', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
