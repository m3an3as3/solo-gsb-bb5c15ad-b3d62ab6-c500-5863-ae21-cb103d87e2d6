import type { AudioBufferLike } from '../src/types';
import {
  MAX_FADE_SEC,
  applyMuting,
  clampMuteRegion,
  encodeMutedWav,
  mergeFrameRanges,
  prepareMuteRanges,
  regionToFrameRange,
} from '../src/audio/muting';

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${msg}: expected ${e}, got ${a}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function approx(actual: number, expected: number, eps: number, msg: string) {
  if (Math.abs(actual - expected) <= eps) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}: expected ≈${expected}, got ${actual}`);
  }
}
function throws(fn: () => unknown, part: string, msg: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg}: expected throw containing "${part}"`);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!text.includes(part)) {
      failures++;
      console.error(`FAIL ${msg}: expected message containing "${part}", got "${text}"`);
    } else console.log(`ok ${msg}`);
  }
}

function makeBuffer(channels: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    duration: channels[0].length / sampleRate,
    length: channels[0].length,
    sampleRate,
    numberOfChannels: channels.length,
    getChannelData: (ch) => channels[ch],
  };
}

const RATE = 1000; // 1 sample/ms，便于断言 20ms 包络
const MAX_FADE_FRAMES = Math.round(MAX_FADE_SEC * RATE); // 20
eq(MAX_FADE_FRAMES, 20, 'max fade is 20ms');

// ---- regionToFrameRange：钳制 + 左闭右开 ----
{
  eq(regionToFrameRange(0, 0.5, RATE, 1000), { startFrame: 0, endFrame: 500 }, 'seconds to frames');
  eq(regionToFrameRange(-1, 2, RATE, 1000), { startFrame: 0, endFrame: 1000 }, 'clamp both ends');
  eq(regionToFrameRange(0.5, 0.5, RATE, 1000), null, 'zero length rejected');
  eq(regionToFrameRange(0.9, 0.1, RATE, 1000), null, 'inverted rejected');
  eq(regionToFrameRange(NaN, 0.5, RATE, 1000), null, 'NaN rejected');
  eq(regionToFrameRange(0.1, 0.9, 0, 0), null, 'bad buffer rejected');
}

// ---- mergeFrameRanges：重叠与相接合并 ----
{
  eq(
    mergeFrameRanges([
      { startFrame: 10, endFrame: 20 },
      { startFrame: 15, endFrame: 25 },
    ]),
    [{ startFrame: 10, endFrame: 25 }],
    'overlapping ranges merge',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 20, endFrame: 30 },
      { startFrame: 10, endFrame: 20 },
    ]),
    [{ startFrame: 10, endFrame: 30 }],
    'touching (end===start) ranges merge regardless of input order',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 0, endFrame: 10 },
      { startFrame: 21, endFrame: 30 },
      { startFrame: 10, endFrame: 21 },
    ]),
    [{ startFrame: 0, endFrame: 30 }],
    'three ranges chain-merge into one',
  );
  eq(
    mergeFrameRanges([
      { startFrame: 0, endFrame: 10 },
      { startFrame: 11, endFrame: 20 },
    ]),
    [
      { startFrame: 0, endFrame: 10 },
      { startFrame: 11, endFrame: 20 },
    ],
    'ranges separated by one frame stay separate',
  );
  eq(mergeFrameRanges([]), [], 'empty input');
}

// ---- prepareMuteRanges：钳制 + 合并 + 包络帧数 ----
{
  const buf = makeBuffer([new Float32Array(RATE)], RATE); // 1s
  const pre = prepareMuteRanges(
    [
      { start: 0.1, end: 0.5 },
      { start: 0.4, end: 0.9 }, // 与上一个重叠
    ],
    buf,
  );
  eq(pre.length, 1, 'overlapping regions prepared as one');
  eq(pre[0].startFrame, 100, 'merged start');
  eq(pre[0].endFrame, 900, 'merged end');
  eq(pre[0].fadeInFrames, 20, 'fade-in capped at 20ms');
  eq(pre[0].fadeOutFrames, 20, 'fade-out capped at 20ms');

  // 相接也合并，避免边界双斜坡
  const touching = prepareMuteRanges(
    [
      { start: 0.1, end: 0.2 },
      { start: 0.2, end: 0.3 },
    ],
    buf,
  );
  eq(touching.length, 1, 'touching regions merge');
  eq(touching[0], { startFrame: 100, endFrame: 300, fadeInFrames: 20, fadeOutFrames: 20 }, 'one envelope pair');

  // 短于 2×20ms：两侧等比缩短，铺满该段，不越过边界
  const tiny = prepareMuteRanges([{ start: 0, end: 0.03 }], buf)[0]; // 30 帧
  eq(tiny.fadeInFrames, 15, 'short region: fade-in is half span');
  eq(tiny.fadeOutFrames, 15, 'short region: fade-out is half span');

  const odd = prepareMuteRanges([{ start: 0, end: 0.011 }], buf)[0]; // 11 帧
  eq(odd.fadeInFrames, 5, 'odd short region: floor half for fade-in');
  eq(odd.fadeOutFrames, 6, 'odd short region: remainder goes to fade-out');
  ok(odd.fadeInFrames + odd.fadeOutFrames === 11, 'fades exactly tile the short region');

  const one = prepareMuteRanges([{ start: 0, end: 0.001 }], buf)[0]; // 1 帧
  eq(one.fadeInFrames, 0, 'single-frame region: no fade-in');
  eq(one.fadeOutFrames, 1, 'single-frame region: fade-out is the frame');

  // 越界区间先裁剪
  const clipped = prepareMuteRanges([{ start: -0.5, end: 5 }], buf);
  eq(
    clipped[0],
    { startFrame: 0, endFrame: 1000, fadeInFrames: 20, fadeOutFrames: 20 },
    'region clipped to full audio',
  );

  // 钳制后零长度丢弃
  eq(prepareMuteRanges([{ start: 2, end: 3 }], buf), [], 'fully out-of-range region dropped');
}

// ---- applyMuting：总时长/声道/采样率、区间外恒等、包络 ----
{
  const mono = new Float32Array(RATE).fill(1);
  const buf = makeBuffer([mono], RATE);

  const out = applyMuting(buf, [{ id: 'a', start: 0.1, end: 0.2 }]); // [100,200)
  eq([out.numberOfChannels, out.sampleRate, out.length], [1, RATE, RATE], 'shape preserved');
  ok(out.channels[0] !== mono, 'returns a new array (source untouched)');
  eq(mono[150], 1, 'original buffer is not modified');

  const o = out.channels[0];
  eq(o[0], 1, 'sample before range untouched');
  eq(o[99], 1, 'sample just before fade-in untouched');
  approx(o[100], 1, 1e-9, 'fade-in starts at original gain');
  approx(o[119], 1 / 20, 1e-9, 'fade-in first ramp step');
  approx(o[119], 0.05, 1e-9, 'fade-in ramps down to ~0.05 near silent');
  eq(o[120], 0, 'fully silenced interior sample');
  eq(o[150], 0, 'middle of range is silence');
  eq(o[179], 0, 'sample before fade-out stays silent');
  eq(o[180], 0, 'fade-out starts at silence');
  approx(o[181], 1 / 20, 1e-6, 'fade-out first ramp step from silence');
  approx(o[199], 19 / 20, 1e-6, 'fade-out last ramp sample');
  eq(o[200], 1, 'sample after range fully restored');
  eq(o[999], 1, 'last sample untouched');

  // 极短区间（30 帧）：包络铺满，中点为静音，不越界
  const t = applyMuting(makeBuffer([new Float32Array(RATE).fill(1)], RATE), [
    { id: 'b', start: 0, end: 0.03 },
  ]).channels[0];
  eq(t[0], 1, 'tiny: before untouched');
  approx(t[0], 1, 1e-9, 'tiny fade-in first at gain 1');
  approx(t[14], 1 / 15, 1e-6, 'tiny fade-in near end');
  eq(t[15], 0, 'tiny center is silent');
  approx(t[29], 14 / 15, 1e-6, 'tiny fade-out last');
  eq(t[30], 1, 'tiny after restored');
}

// 合并后只施加一对包络（相接区间的接缝处不会二次斜坡，且全程静音）
{
  const out = applyMuting(makeBuffer([new Float32Array(RATE).fill(1)], RATE), [
    { id: 'a', start: 0.1, end: 0.15 },
    { id: 'b', start: 0.15, end: 0.2 },
  ]).channels[0];
  eq(out[149], 0, 'seam inside merged range is silent (no double ramp)');
  eq(out[150], 0, 'touching boundary frame is silent');
  eq(out[151], 0, 'frame after seam still silent');
}

// 立体声：两声道独立应用且等长
{
  const l = new Float32Array(500).fill(0.5);
  const r = new Float32Array(500).fill(-0.5);
  const buf = makeBuffer([l, r], RATE);
  const out = applyMuting(buf, [{ id: 'a', start: 0.1, end: 0.3 }]);
  eq(out.numberOfChannels, 2, 'two channels preserved');
  eq(out.length, 500, 'length preserved');
  eq(out.channels[0][0], 0.5, 'left before range');
  eq(out.channels[1][0], -0.5, 'right before range');
  eq(out.channels[0][200], 0, 'left silenced');
  eq(out.channels[1][200], -0, 'right silenced (negative zero)');
  eq(out.channels[0][499], 0.5, 'left after range');
  eq(out.channels[1][499], -0.5, 'right after range');
}

// NaN 输入：区间外保留（WAV 编码时映射为 0），区间内归零
{
  const data = new Float32Array(100);
  for (let i = 0; i < 100; i++) data[i] = i >= 40 && i < 60 ? NaN : 1;
  const out = applyMuting(makeBuffer([data], RATE), [{ id: 'a', start: 0.001, end: 0.05 }]); // [1,50)
  ok(out.channels[0][25] === 0, 'NaN inside mute range -> 0');
  ok(Number.isNaN(out.channels[0][55]), 'NaN outside mute range preserved for encoder');
}

// 失败路径
{
  throws(() => applyMuting(makeBuffer([new Float32Array(0)], RATE), [{ id: 'a', start: 0, end: 0.1 }]), '尚未导入', 'empty buffer throws');
  throws(() => applyMuting(makeBuffer([new Float32Array(RATE)], RATE), []), '有效消音', 'no regions throws');
  throws(
    () => applyMuting(makeBuffer([new Float32Array(RATE)], RATE), [{ id: 'a', start: 5, end: 6 }]),
    '有效消音',
    'all regions out of range throws',
  );
}

// ---- encodeMutedWav：完整时长 / 声道 / 采样率 / 16-bit PCM ----
function parseWav(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);
  const frames = dataSize / (channels * 2);
  const samples: number[] = [];
  for (let i = 0; i < frames * channels; i++) samples.push(view.getInt16(44 + i * 2, true));
  return { channels, sampleRate, bits, frames, samples };
}
{
  const rate = 8000;
  const mono = new Float32Array(rate).fill(1);
  const pcm = applyMuting(makeBuffer([mono], rate), [{ id: 'a', start: 0.25, end: 0.75 }]);
  const wav = encodeMutedWav(pcm);
  const parsed = parseWav(wav);
  eq(wav.length, 44 + rate * 2, 'wav covers the WHOLE file (total duration kept)');
  eq([parsed.channels, parsed.sampleRate, parsed.bits], [1, rate, 16], 'mono / rate / 16-bit kept');
  eq(parsed.frames, rate, 'frame count equals original length');
  eq(parsed.samples[0], 32767, 'first sample original');
  eq(parsed.samples[rate / 2], 0, 'middle sample silent');
  eq(parsed.samples[rate - 1], 32767, 'last sample original');

  // 立体声交错
  const l = new Float32Array(1000).fill(0.25);
  const r = new Float32Array(1000).fill(-0.25);
  const spcm = applyMuting(makeBuffer([l, r], RATE), [{ id: 'a', start: 0.2, end: 0.8 }]);
  const sw = parseWav(encodeMutedWav(spcm));
  eq([sw.channels, sw.sampleRate, sw.frames], [2, RATE, 1000], 'stereo shape kept');
  eq([sw.samples[0], sw.samples[1]], [Math.round(0.25 * 32767), Math.round(-0.25 * 32768)], 'stereo interleaved outside range');
  eq([sw.samples[500 * 2], sw.samples[500 * 2 + 1]], [0, 0], 'stereo middle both silent');
}

// ---- clampMuteRegion：UI 输入校验 ----
{
  eq(clampMuteRegion(0.2, 0.8, 1), { start: 0.2, end: 0.8 }, 'valid region passes');
  eq(clampMuteRegion(-1, 2, 1), { start: 0, end: 1 }, 'clamps to audio range');
  eq(clampMuteRegion(0.5, 0.5, 1), null, 'zero length rejected');
  eq(clampMuteRegion(0.8, 0.2, 1), null, 'inverted rejected');
  eq(clampMuteRegion(NaN, 0.5, 1), null, 'NaN rejected');
  eq(clampMuteRegion(0.2, Infinity, 1), null, 'Infinity rejected');
  eq(clampMuteRegion(0.2, 0.8, 0), null, 'no audio rejected');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all muting tests passed');
}
