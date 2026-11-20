// 命令输出瘦身：在交给模型之前去掉对它没用的内容，省 token（思路参考 RTK 这类工具）。
// 只删「看了也没信息量」的东西：颜色码、进度条、重复行、大段相似的下载 / 测试通过日志；
// 输出很长时，先保留出错的位置（前后几行），再从开头、结尾往中间补，中间的正常日志省略。
'use strict';

// ANSI 颜色 / 光标控制码，以及 OSC 序列（终端标题、超链接）
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// 出错的位置（中英文、常见编译器 / 测试框架的写法）
const ERR = /\w*(?:error|exception)\b|\b(caused by|err!|failed|failure|failures|fail|fatal|exception|traceback|panic|assert(?:ion)?(?:error)?|cannot|can't|not found|undefined reference|segmentation fault|denied|refused|timed? ?out)\b|✗|✖|×|❌|报错|错误|失败|异常|找不到/i;

const FAILED_BUDGET = 6000; // 命令失败时：输出超过这么多字，只留出错处和首尾（模型主要看报错）
const MAX_CHARS = 16000; // 命令成功时：超过这么多字才裁
const CONTEXT = 3; // 出错行前后各留几行

// 进度条：一行里只有进度块、百分比、下载量、速度这些
const PROGRESS = /^[\s\[\]()|#=>\-.·•█▉▊▋▌▍▎▏░▒▓■□⣾⣽⣻⢿⡿⣟⣯⣷⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\\/]*\d{1,3}(?:\.\d+)?\s*%[\s\S]{0,80}$/;
// 相似行要是「日志」（有连续 3 个以上字母或汉字），表格 / CSV 这类纯数据不合并
const WORDY = /[a-z一-龥]{3,}/i;
// 带路径 / 文件名的行（文件列表、grep 结果、编译到哪个文件）是有用的内容，不能当重复日志合并
const PATHY = /[/\\]|\b[\w-]+\.[a-z][a-z0-9]{0,4}\b/i;

// 用于判断「相似行」：数字、十六进制哈希都抹掉
function shape(line) {
  return line.replace(/[0-9a-f]{7,}/gi, 'H').replace(/\d+(?:\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim();
}

function squeeze(text, msgs = {}, failed = false) {
  if (!text) return text;
  const say = (k, n) => (msgs[k] || '').replace('{n}', n);
  let s = String(text).replace(ANSI, '');
  // \r 覆盖写：进度条在同一行反复刷新，只留最后一次
  s = s.replace(/\r\n/g, '\n').split('\n').map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() || '' : l)).join('\n');
  let lines = s.split('\n').map((l) => l.replace(/\s+$/, ''));

  // 1. 去掉纯进度行，连续空行只留一行
  const a = [];
  for (const l of lines) {
    if (PROGRESS.test(l) && !ERR.test(l)) continue;
    if (!l && a.length && !a[a.length - 1]) continue;
    a.push(l);
  }

  // 2. 连续相似的日志行（下载进度、一条条「测试通过」）：留前 2 行和最后 1 行；完全相同的行合并
  const b = [];
  for (let i = 0; i < a.length; ) {
    let j = i + 1;
    const sh = shape(a[i]);
    if (sh) while (j < a.length && shape(a[j]) === sh) j++;
    const run = j - i;
    if (run >= 6 && !PATHY.test(a[i]) && WORDY.test(a[i].replace(/[0-9a-f]{7,}/gi, '')) && !a.slice(i, j).some((l) => ERR.test(l))) {
      b.push(a[i], a[i + 1], say('similar', run - 3), a[j - 1]);
    } else if (run >= 3 && a.slice(i, j).every((l) => l === a[i])) {
      b.push(a[i], say('repeat', run - 1));
    } else {
      b.push(...a.slice(i, j));
    }
    i = j;
  }
  lines = b;

  // 3. 还很长：先保留出错的地方（前后几行），再从开头、结尾往中间补，直到字数预算用完
  let out = lines.join('\n');
  const budget = failed ? FAILED_BUDGET : MAX_CHARS;
  if (out.length > budget && lines.length > 20) {
    const keep = new Set();
    let used = 0;
    const take = (i) => {
      if (i < 0 || i >= lines.length || keep.has(i)) return true;
      if (used + lines[i].length + 1 > budget) return false;
      keep.add(i);
      used += lines[i].length + 1;
      return true;
    };
    let errs = 0;
    for (let i = 0; i < lines.length && errs < 40; i++) {
      if (!ERR.test(lines[i])) continue;
      errs++;
      for (let k = i - CONTEXT; k <= i + CONTEXT; k++) take(k);
    }
    // 开头最多占四成，剩下的给结尾（结尾通常是总结 / 最后的报错）
    for (let i = 0; i < lines.length && used < budget * 0.4; i++) if (!take(i)) break;
    for (let i = lines.length - 1; i >= 0; i--) if (!take(i)) break;
    const c = [];
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
      if (keep.has(i)) {
        if (skipped) c.push(say('skipped', skipped)), (skipped = 0);
        c.push(lines[i]);
      } else skipped++;
    }
    if (skipped) c.push(say('skipped', skipped));
    out = c.join('\n');
  }

  // 4. 硬上限（极长的单行，比如压缩过的 JSON）
  if (out.length > MAX_CHARS + 2000) out = out.slice(0, MAX_CHARS / 2) + '\n' + say('cut', out.length - MAX_CHARS) + '\n' + out.slice(-MAX_CHARS / 2);
  return out.replace(/^\n+/, '').trimEnd();
}

module.exports = { squeeze };
