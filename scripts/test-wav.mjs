// 语音输入 WAV 编码单测：node scripts/test-wav.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeWav, resample, mixToMono, toWav16k, bytesToBase64, TARGET_RATE } = require('../src/renderer/voice.js');

const ascii = (u8, off, len) => String.fromCharCode(...u8.subarray(off, off + len));
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

test('WAV 头部字段', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav(samples, 16000);
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(ascii(wav, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), wav.length - 8);
  assert.equal(ascii(wav, 8, 4), 'WAVE');
  assert.equal(ascii(wav, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1, 'PCM');
  assert.equal(v.getUint16(22, true), 1, '单声道');
  assert.equal(v.getUint32(24, true), 16000, '采样率');
  assert.equal(v.getUint32(28, true), 32000, '字节率');
  assert.equal(v.getUint16(32, true), 2, '块对齐');
  assert.equal(v.getUint16(34, true), 16, '位深');
  assert.equal(ascii(wav, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), samples.length * 2);
});

test('PCM 采样值与削波', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  const s = (i) => v.getInt16(44 + i * 2, true);
  assert.equal(s(0), 0);
  assert.equal(s(1), 32767);
  assert.equal(s(2), -32768);
  assert.equal(s(3), 32767, '超过 1 削波');
  assert.equal(s(4), -32768, '低于 -1 削波');
  assert.equal(s(5), 16383);
});

test('空音频只有头', () => {
  const wav = encodeWav(new Float32Array(0));
  assert.equal(wav.length, 44);
  assert.equal(new DataView(wav.buffer).getUint32(24, true), TARGET_RATE);
});

test('48k / 44.1k 降采样到 16k 长度正确', () => {
  assert.equal(resample(new Float32Array(48000), 48000).length, 16000);
  assert.equal(resample(new Float32Array(44100), 44100).length, 16000);
  assert.equal(resample(new Float32Array(16000), 16000).length, 16000);
  assert.equal(resample(new Float32Array(8000), 8000).length, 16000, '升采样');
  const dc = resample(new Float32Array(4800).fill(0.25), 48000);
  assert.ok(dc.every((x) => Math.abs(x - 0.25) < 1e-6), '直流信号保持不变');
});

test('toWav16k：分段 48k 录音 → 1 秒 16k WAV', () => {
  const chunks = [new Float32Array(4096), new Float32Array(4096), new Float32Array(48000 - 8192)];
  const wav = toWav16k(chunks, 48000);
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 16000 * 2);
  assert.equal(wav.length, 44 + 32000);
  // 60 秒 16k 单声道 16bit ≈ 1.9MB，在后端 5MB 限制内
  assert.ok(44 + 60 * 16000 * 2 < 5 * 1024 * 1024);
});

test('mixToMono 取平均', () => {
  const m = mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(m), [0.5, 0.5]);
});

test('bytesToBase64 与 Buffer 一致', () => {
  const wav = encodeWav(new Float32Array(70000).map((_, i) => Math.sin(i / 10)));
  assert.equal(bytesToBase64(wav), Buffer.from(wav).toString('base64'));
});

console.log(`\n${passed} tests passed`);
