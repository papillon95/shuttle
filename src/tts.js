// 配音（语音合成）：把文字按句子拆开，逐句调平台的 /aidesk/tts/speech，拼成一个音频文件；可选按真实时长生成 SRT 字幕。
// 逐句合成的好处：每句的时长是精确的，字幕时间轴不用猜；单次请求也不会超过厂商 600 字符的上限。
// 依赖由 main.js 注入（调接口、确认框、进度），这里不碰 Electron。
const fs = require('fs');
const path = require('path');

const MAX_SENTENCES = 400;
const SENTENCE_MAX = 300; // 单句最多多少计费字符，再长就按逗号拆（厂商上限 600）
const SUB_LINE = 18; // 字幕每行大约多少个字
const GAP_MS = 150; // 句子之间加一点停顿

// 常用音色（qwen3-tts-flash）：给模型挑选用
const VOICES = {
  Cherry: '芊悦，女，阳光亲切（默认）',
  Serena: '苏瑶，女，温柔',
  Maia: '四月，女，知性温柔',
  Ethan: '晨煦，男，阳光有活力',
  Andre: '安德雷，男，沉稳有磁性',
  Neil: '阿闻，男，新闻播音',
  Elias: '墨讲师，讲解 / 课程',
  Kai: '凯，男，舒缓放松',
  Moon: '月白，男，率性帅气',
  Momo: '茉兔，女，俏皮可爱',
  Bella: '萌宝，小女孩',
  Arthur: '徐大爷，男，质朴老人',
  Vincent: '田叔，男，沙哑烟嗓',
  Seren: '小婉，女，舒缓助眠',
  Jennifer: '詹妮弗，女，美式英语，品牌感',
  Aiden: '艾登，男，美式英语',
  Jada: '上海话，女',
  Dylan: '北京话，男',
  Li: '南京话，男',
  Marcus: '陕西话，男',
  Roy: '闽南话，男',
  Peter: '天津话，男',
  Sunny: '四川话，女',
  Eric: '四川话（成都），男',
  Rocky: '粤语，男',
  Kiki: '粤语，女',
};
const LANGS = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian' };

/** 厂商的计费字符数：汉字算 2 个，其余算 1 个（和后端一致） */
function billedChars(s) {
  let n = 0;
  for (const ch of String(s)) n += /\p{Script=Han}/u.test(ch) ? 2 : 1;
  return n;
}

/** 按句子拆：句号、问号、感叹号、分号、换行；太长的句子再按逗号拆，还长就硬切 */
function splitSentences(text) {
  const out = [];
  const parts = String(text).replace(/\r/g, '').split(/(?<=[。！？!?；;…]+[”」』"']?)|(?<=[a-z0-9)"'][.])\s+(?=\S)|\n+/i);
  for (let p of parts) {
    p = (p || '').trim();
    if (!p) continue;
    if (billedChars(p) <= SENTENCE_MAX) {
      out.push(p);
      continue;
    }
    let cur = '';
    for (const seg of p.split(/(?<=[，,、：:])/)) {
      if (cur && billedChars(cur + seg) > SENTENCE_MAX) {
        out.push(cur.trim());
        cur = '';
      }
      cur += seg;
      while (billedChars(cur) > SENTENCE_MAX) {
        let cut = 0;
        let n = 0;
        for (const ch of cur) {
          n += billedChars(ch);
          if (n > SENTENCE_MAX) break;
          cut += ch.length;
        }
        out.push(cur.slice(0, cut).trim());
        cur = cur.slice(cut);
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  // 只有标点、没有可读内容的片段并到前一句
  const merged = [];
  let joinNext = false;
  for (const s of out) {
    if ((joinNext || !/[\p{L}\p{N}]/u.test(s)) && merged.length) merged[merged.length - 1] += (joinNext ? ' ' : '') + s;
    else merged.push(s);
    // 英文缩写（Mr. Dr. e.g.）后面的句点不是句子结束
    joinNext = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|No)\.$/i.test(merged[merged.length - 1]);
  }
  return merged;
}

/** 解析 WAV：返回 { sampleRate, channels, bits, pcm } */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a wav file');
  let off = 12;
  let fmt = null;
  let pcm = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'data' && (size === 0 || size === 0xffffffff || start + size > buf.length)) size = buf.length - start; // 流式写出的 wav 可能没填长度
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    else if (id === 'data') pcm = buf.subarray(start, start + size);
    off = start + size + (size % 2);
  }
  if (!fmt || !pcm) throw new Error('bad wav file');
  if (fmt.format !== 1) throw new Error('unsupported wav encoding ' + fmt.format);
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, pcm };
}

function wavHeader(sampleRate, channels, bits, dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataLen, 40);
  return h;
}

/** 把多段 WAV 拼成一个，中间加 gapMs 毫秒静音；返回 { wav, durations(ms, 每段), total(ms) } */
function joinWavs(bufs, gapMs = GAP_MS) {
  const parts = bufs.map(parseWav);
  const f = parts[0];
  for (const p of parts) if (p.sampleRate !== f.sampleRate || p.channels !== f.channels || p.bits !== f.bits) throw new Error('audio segments have different formats');
  const bps = (f.sampleRate * f.channels * f.bits) / 8;
  const align = (f.channels * f.bits) / 8;
  const gap = Buffer.alloc(Math.round((bps * gapMs) / 1000 / align) * align);
  const chunks = [];
  const durations = [];
  parts.forEach((p, i) => {
    chunks.push(p.pcm);
    durations.push((p.pcm.length / bps) * 1000);
    if (i < parts.length - 1) chunks.push(gap);
  });
  const data = Buffer.concat(chunks);
  return { wav: Buffer.concat([wavHeader(f.sampleRate, f.channels, f.bits, data.length), data]), durations, total: (data.length / bps) * 1000, gapMs: (gap.length / bps) * 1000 };
}

const srtTime = (ms) => {
  ms = Math.max(0, Math.round(ms));
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

/** 一句话拆成字幕行：按逗号等断开，每行不超过 SUB_LINE 个字左右 */
function subLines(sentence) {
  const clean = sentence.replace(/[。！？!?；;…]+[”」』"']?$/u, '').trim() || sentence.trim();
  const segs = clean.split(/(?<=[，,、：:])/).map((x) => x.trim()).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const s of segs) {
    if (cur && [...(cur + s)].length > SUB_LINE) {
      lines.push(cur);
      cur = '';
    }
    cur += s;
    while ([...cur].length > SUB_LINE * 1.6) {
      const a = [...cur];
      lines.push(a.slice(0, SUB_LINE).join(''));
      cur = a.slice(SUB_LINE).join('');
    }
  }
  if (cur) lines.push(cur);
  // 中文字幕习惯不带标点：行尾的去掉，行内的换成空格
  return lines.map((l) => l.replace(/[，,、：:]$/, '').replace(/[，、：]/g, ' ').replace(/\s{2,}/g, ' ').trim());
}

/** 按每句的真实时长生成 SRT；一句里有多行时按字数分配这句的时间 */
function buildSrt(sentences, durations, gapMs) {
  let t = 0;
  let idx = 1;
  const out = [];
  sentences.forEach((s, i) => {
    const lines = subLines(s);
    const total = lines.reduce((x, l) => x + [...l].length, 0) || 1;
    let st = t;
    for (const l of lines) {
      const d = (durations[i] * [...l].length) / total;
      out.push(`${idx++}\n${srtTime(st)} --> ${srtTime(st + d)}\n${l}\n`);
      st += d;
    }
    t += durations[i] + (i < sentences.length - 1 ? gapMs : 0);
  });
  return out.join('\n');
}

async function pool(items, n, fn, signal) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !signal?.aborted) {
      const k = i++;
      await fn(items[k], k);
    }
  }));
}

/**
 * 配音。deps: { model: {provider,id,credits}, remaining(), speak({text, voice, language}) → {ok, audio(Buffer), format, billed, remaining, error, code, detail},
 *   confirm({title, body}) → bool, needConfirm, progress(text), ffmpeg(path?) , signal, lang }
 */
async function run(args, root, deps) {
  const zh = deps.lang !== 'en';
  let text = String(args.text || '');
  if (!text.trim() && args.text_file) {
    const f = path.resolve(root, args.text_file);
    if (!f.startsWith(path.resolve(root)) || !fs.existsSync(f)) return { error: zh ? `找不到文件 ${args.text_file}` : `File not found: ${args.text_file}` };
    text = fs.readFileSync(f, 'utf8');
  }
  if (!text.trim()) return { error: zh ? '请提供要配音的文字（text）或文字文件（text_file）' : 'Provide text or text_file' };
  const voice = VOICES[args.voice] ? args.voice : Object.keys(VOICES).find((v) => v.toLowerCase() === String(args.voice || '').toLowerCase()) || 'Cherry';
  const language = LANGS[args.language] || (Object.values(LANGS).includes(args.language) ? args.language : 'Auto');
  const sentences = splitSentences(text);
  if (!sentences.length) return { error: zh ? '没有可以朗读的文字' : 'Nothing to read' };
  if (sentences.length > MAX_SENTENCES) return { error: zh ? `文字太长（${sentences.length} 句），单次最多 ${MAX_SENTENCES} 句，请分几次配。` : `Too long (${sentences.length} sentences, max ${MAX_SENTENCES}).` };
  const chars = sentences.reduce((n, s) => n + billedChars(s), 0);
  const cachedKey = (s) => deps.cacheDir && path.join(deps.cacheDir, require('crypto').createHash('sha1').update(`${deps.model.id}|${voice}|${language}|${s}`).digest('hex') + '.wav');
  const newChars = sentences.reduce((n, s) => n + (cachedKey(s) && fs.existsSync(cachedKey(s)) ? 0 : billedChars(s)), 0);
  const est = Math.ceil((newChars * (deps.model.credits || 0)) / 1000);
  const remaining = await deps.remaining();
  if (remaining != null && remaining < est) {
    const fit = Math.floor((remaining * 1000) / Math.max(1, deps.model.credits) / 2);
    return { error: zh ? `额度不够：这段配音约需 ${est.toLocaleString()} token，剩余 ${Number(remaining).toLocaleString()}，大约还够 ${fit} 个汉字。可以先配一部分。` : `Not enough quota: needs about ${est} tokens, ${remaining} left.` };
  }

  // 输出文件
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  let rel = String(args.path || `audio/shuttle-${stamp}.wav`).replace(/^[/\\]+/, '');
  let wantMp3 = /\.mp3$/i.test(rel);
  if (!/\.(wav|mp3)$/i.test(rel)) rel += '.wav';
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root))) return { error: zh ? '保存路径必须在当前文件夹里' : 'Path must be inside the folder' };

  if (deps.needConfirm || newChars > 4000) {
    const ok = await deps.confirm({
      title: zh ? `配音 ${sentences.length} 句（约 ${[...text.replace(/\s/g, '')].length} 字），音色 ${voice}，预计扣 ${est.toLocaleString()} token` : `Voice-over: ${sentences.length} sentences, voice ${voice}, about ${est} tokens`,
      body: (zh ? `保存到 ${rel}${args.subtitles ? '（同时生成字幕）' : ''}\n\n` : `Save to ${rel}\n\n`) + text.slice(0, 1500) + (text.length > 1500 ? '…' : ''),
    });
    if (!ok) return { rejected: true };
  }

  // 每句的音频缓存一份（按 音色 + 语言 + 文字），重试或只改了几句时，没改的句子不用重新合成、不重复扣额度
  const crypto = require('crypto');
  const cacheFile = (s) => deps.cacheDir && path.join(deps.cacheDir, crypto.createHash('sha1').update(`${deps.model.id}|${voice}|${language}|${s}`).digest('hex') + '.wav');
  if (deps.cacheDir) {
    fs.mkdirSync(deps.cacheDir, { recursive: true });
    const old = Date.now() - 7 * 86400000;
    for (const f of fs.readdirSync(deps.cacheDir)) {
      try {
        if (fs.statSync(path.join(deps.cacheDir, f)).mtimeMs < old) fs.unlinkSync(path.join(deps.cacheDir, f));
      } catch {}
    }
  }
  const audios = new Array(sentences.length);
  const failed = [];
  let done = 0;
  let billed = 0;
  let lastRemaining = null;
  let fatal = null;
  await pool(sentences, 3, async (s, i) => {
    if (fatal) return;
    const cf = cacheFile(s);
    if (cf && fs.existsSync(cf)) {
      audios[i] = fs.readFileSync(cf);
      done++;
      return;
    }
    let r;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await deps.speak({ text: s, voice, language });
      if (r.ok || !['too_many_requests', 'upstream_error'].includes(r.code) || /审核|Sensitive|DataInspection|Arrearage|InvalidApiKey/i.test(r.detail || '')) break;
      await new Promise((ok) => setTimeout(ok, 1500 * attempt));
    }
    done++;
    deps.progress(zh ? `正在配音 ${done}/${sentences.length}…` : `Voicing ${done}/${sentences.length}…`);
    if (!r.ok) {
      if (['quota_exceeded', 'unauthorized', 'plan_required', 'model_unavailable', 'no_platform_key', 'free_busy'].includes(r.code)) fatal = r;
      failed.push({ i, sentence: s, error: r.error + (r.detail ? `（${String(r.detail).slice(0, 120)}）` : '') });
      return;
    }
    audios[i] = r.audio;
    if (cf) fs.writeFileSync(cf, r.audio);
    billed += r.billed || 0;
    lastRemaining = r.remaining;
  }, deps.signal);
  if (deps.signal?.aborted) return { error: zh ? '已停止' : 'Stopped', billed };
  if (fatal && !audios.some(Boolean)) return { error: fatal.error, billed };
  if (failed.length) {
    // 有句子失败就不拼了（拼出来会缺句），把失败原因告诉用户；已成功的部分扣过的额度如实说明
    failed.sort((a, b) => a.i - b.i);
    return { failed, total: sentences.length, billed, remaining: lastRemaining };
  }

  const joined = joinWavs(audios);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  let outAbs = abs;
  let note = '';
  if (wantMp3) {
    const wavTmp = abs.replace(/\.mp3$/i, '.tmp.wav');
    fs.writeFileSync(wavTmp, joined.wav);
    const ok = deps.ffmpeg ? await deps.ffmpeg(wavTmp, abs) : false;
    if (ok) fs.unlinkSync(wavTmp);
    else {
      outAbs = abs.replace(/\.mp3$/i, '.wav');
      fs.renameSync(wavTmp, outAbs);
      note = zh
        ? `电脑上没有找到 ffmpeg，先保存成了 WAV。如果用户需要 MP3，可以问用户要不要安装 ffmpeg（${process.platform === 'win32' ? 'Windows：winget install Gyan.FFmpeg' : 'Mac：brew install ffmpeg，没有 Homebrew 的话需要用户先在终端里自己安装 Homebrew'}），装好后不用重启，再配一次就会存成 MP3（已配过的句子有缓存，不会重复扣额度）`
        : `ffmpeg not found; saved as WAV. If the user wants MP3, offer to install ffmpeg (${process.platform === 'win32' ? 'winget install Gyan.FFmpeg' : 'brew install ffmpeg'}); no restart needed, and re-running reuses cached sentences.`;
    }
  } else fs.writeFileSync(abs, joined.wav);
  let srtAbs = null;
  if (args.subtitles) {
    srtAbs = outAbs.replace(/\.(wav|mp3)$/i, '.srt');
    fs.writeFileSync(srtAbs, buildSrt(sentences, joined.durations, joined.gapMs));
  }
  return { abs: outAbs, srtAbs, seconds: joined.total / 1000, sentences: sentences.length, chars, billed, remaining: lastRemaining, voice, note };
}

module.exports = { run, splitSentences, billedChars, parseWav, joinWavs, wavHeader, buildSrt, subLines, srtTime, VOICES, LANGS };
