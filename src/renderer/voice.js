// 语音输入：录音 → 16kHz 单声道 16bit PCM WAV → 后端 /aidesk/asr → 文字追加到输入框
// 腾讯云一句话识别不支持 MediaRecorder 的 webm/opus，所以用 AudioContext 采集 PCM 自己编码 WAV。
// 编码相关的纯函数同时导出给 Node（scripts/test-wav.mjs 单测），界面逻辑只在浏览器里运行。
(function (root) {
  'use strict';

  const TARGET_RATE = 16000;

  /** 多声道合成单声道（取平均）：channels 是 Float32Array 数组 */
  function mixToMono(channels) {
    if (!channels || !channels.length) return new Float32Array(0);
    if (channels.length === 1) return channels[0];
    const len = channels[0].length;
    const out = new Float32Array(len);
    for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i];
    for (let i = 0; i < len; i++) out[i] /= channels.length;
    return out;
  }

  /** 重采样到 outRate：降采样按区间取平均（简单低通，避免混叠），升采样用线性插值 */
  function resample(samples, inRate, outRate = TARGET_RATE) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('invalid sample rate');
    if (inRate === outRate) return Float32Array.from(samples);
    const outLen = Math.floor((samples.length * outRate) / inRate);
    const out = new Float32Array(outLen);
    const ratio = inRate / outRate;
    if (ratio > 1) {
      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let j = start; j < end; j++) sum += samples[j];
        out[i] = sum / (end - start);
      }
    } else {
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const j = Math.floor(pos);
        const next = j + 1 < samples.length ? samples[j + 1] : samples[j];
        out[i] = samples[j] + (next - samples[j]) * (pos - j);
      }
    }
    return out;
  }

  /** Float32 PCM（-1~1）编码成单声道 16bit WAV，返回 Uint8Array（44 字节头 + 数据） */
  function encodeWav(samples, sampleRate = TARGET_RATE) {
    const dataLen = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);              // fmt 块长度
    v.setUint16(20, 1, true);               // PCM
    v.setUint16(22, 1, true);               // 单声道
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);  // 字节率 = 采样率 × 块对齐
    v.setUint16(32, 2, true);               // 块对齐 = 声道数 × 2 字节
    v.setUint16(34, 16, true);              // 位深
    str(36, 'data');
    v.setUint32(40, dataLen, true);
    for (let i = 0, off = 44; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i] || 0));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  /** 采集到的分段 PCM → 16k 单声道 WAV */
  function toWav16k(chunks, inRate) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    return encodeWav(resample(all, inRate, TARGET_RATE), TARGET_RATE);
  }

  /** Uint8Array → base64（分块拼接，避免大数组展开爆栈） */
  function bytesToBase64(bytes) {
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    return btoa(bin);
  }

  const lib = { TARGET_RATE, mixToMono, resample, encodeWav, toWav16k, bytesToBase64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = lib;
  if (root) root.ShuttleVoice = lib;
})(typeof window !== 'undefined' ? window : null);
