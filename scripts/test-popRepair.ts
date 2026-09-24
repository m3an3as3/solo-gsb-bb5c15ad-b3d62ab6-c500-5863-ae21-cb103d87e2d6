import type { AudioBufferLike } from '../src/types';
import {
  CROSS_CHANNEL_GAP_SEC,
  MAX_POP_SEC,
  computeBlockStats,
  detectChannelPops,
  detectPops,
  encodeRepairedWav,
  mergeCrossChannelRuns,
  popSourceFromBuffer,
  repairPops,
  scanChannelRuns,
  type PopEvent,
} from '../src/audio/popRepair';

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

/** 生成 1s 全零单声道缓冲，用 setter 在指定帧写入异常采样。 */
function zeroTrack(rate = 1000, seconds = 1): Float32Array {
  return new Float32Array(rate * seconds);
}
function pulse(data: Float32Array, frames: number[], v = 0.9): Float32Array {
  for (const i of frames) data[i] = v;
  return data;
}

const RATE = 1000; // 1 sample/ms：块 20、5ms=5 帧，断言直观

// ---- computeBlockStats：稳健中位数 / MAD ----
{
  const data = zeroTrack();
  pulse(data, [100]);
  const stats = computeBlockStats(data, 20);
  eq(stats.length, 50, 'one stat per 20ms block');
  // 块 [100,120)：20 个样本里 19 个 0 + 1 个 0.9 —— 中位数与 MAD 都不被污染
  eq(stats[5].med, 0, 'median unaffected by one spike');
  approx(stats[5].delta, 0.02, 1e-9, 'MAD 0 -> delta falls back to MIN_SPIKE_DELTA');
  approx(stats[5].returnDelta, 0.01, 1e-9, 'return delta is half the floor');
  eq(stats[0].med, 0, 'silent block median 0');

  // 小幅度背景噪声 ±0.01：MAD ≈0.01，阈值随之抬高但仍远低于爆音
  const noisy = zeroTrack();
  for (let i = 0; i < noisy.length; i++) noisy[i] = i % 2 === 0 ? 0.01 : -0.01;
  const ns = computeBlockStats(noisy, 20)[0];
  eq(ns.med, 0, 'symmetric noise median 0');
  approx(ns.delta, Math.max(8 * 1.4826 * 0.01, 0.02), 1e-6, 'delta follows scaled MAD');
}

// ---- 孤立尖峰检测（单 / 多样本，长度上限 5ms） ----
{
  const single = detectChannelPops(pulse(zeroTrack(), [100]), RATE);
  eq(single.length, 1, 'single-sample spike detected');
  eq([single[0].startFrame, single[0].endFrame], [100, 101], 'half-open run frames');

  const three = detectChannelPops(pulse(zeroTrack(), [200, 201, 202]), RATE);
  eq(
    three.map((r) => [r.startFrame, r.endFrame]),
    [[200, 203]],
    'adjacent abnormal samples merge into one run',
  );

  const maxLen = Math.floor(MAX_POP_SEC * RATE);
  eq(maxLen, 5, '5ms = 5 frames at 1kHz');
  const five = detectChannelPops(pulse(zeroTrack(), [100, 101, 102, 103, 104]), RATE);
  eq(five.length, 1, 'exactly 5ms spike is kept');
  const six = detectChannelPops(pulse(zeroTrack(), [100, 101, 102, 103, 104, 105]), RATE);
  eq(six.length, 0, '6ms continuous spike rejected as too long (sustained, not a pop)');
}

// ---- 跨块边界的相邻异常仍合并为一处 ----
{
  // 块边界在 100：99 属于块 [80,100)，100 属于块 [100,120)
  const runs = detectChannelPops(pulse(zeroTrack(), [99, 100]), RATE);
  eq(
    runs.map((r) => [r.startFrame, r.endFrame]),
    [[99, 101]],
    'abnormal samples across a block boundary merge',
  );
}

// ---- 两端必须回到邻域基线 ----
{
  // 尖峰后紧接着一段持续偏高（0.3）：守卫窗未回基线 -> 拒绝
  const elevated = zeroTrack();
  elevated[100] = 0.9;
  for (let i = 103; i < 108; i++) elevated[i] = 0.3;
  eq(detectChannelPops(elevated, RATE).length, 0, 'spike without return-to-baseline rejected');

  // 首尾的尖峰没有两侧锚点 -> 拒绝（无法插值 / 验证）
  eq(detectChannelPops(pulse(zeroTrack(), [2]), RATE).length, 0, 'spike at very start rejected');
  eq(detectChannelPops(pulse(zeroTrack(), [999]), RATE).length, 0, 'spike at very end rejected');

  // 尾块不足一个块长时仍正常统计：靠近结尾的尖峰可检测（两侧各留 5 帧）
  const tailData = zeroTrack(RATE, 1.003);
  pulse(tailData, [992]);
  eq(detectChannelPops(tailData, RATE).length, 1, 'spike near end in short tail block detected');
}

// ---- 持续鼓点 / 阶跃 / 低幅噪声不报为爆音 ----
{
  // 平台式重击（0.5 持续 40ms）：无孤立尖峰
  const thump = zeroTrack();
  for (let i = 300; i < 340; i++) thump[i] = 0.5;
  eq(detectChannelPops(thump, RATE).length, 0, 'sustained plateau (drum-like) not reported');

  // 直流阶跃：阶跃两侧各自成块，块内一致，不报异常
  const step = zeroTrack();
  for (let i = 500; i < 1000; i++) step[i] = 0.5;
  eq(detectChannelPops(step, RATE).length, 0, 'step change not reported as pop');

  // 低幅抖动（|x| ≤ 0.005 < MIN_SPIKE_DELTA）不报
  const dither = zeroTrack();
  for (let i = 0; i < 1000; i++) dither[i] = i % 2 === 0 ? 0.005 : -0.005;
  eq(detectChannelPops(dither, RATE).length, 0, 'low-level dither never reported');

  // 真实速率下的 100Hz 鼓击包络（平滑起振 50ms，幅度 0.5）：
  // 块内 MAD 大，z 分数低，整段不报
  const hiRate = 11025;
  const drums = new Float32Array(hiRate); // 1s
  for (let i = 0; i < hiRate; i++) {
    const t = i / hiRate;
    if (t >= 0.3 && t < 0.35) {
      const env = Math.sin(Math.PI * ((t - 0.3) / 0.05)); // 0→1→0 平滑包络
      drums[i] = 0.5 * env * Math.sin(2 * Math.PI * 100 * t);
    }
  }
  eq(detectChannelPops(drums, hiRate).length, 0, 'smooth 100Hz drum hit not reported at 11kHz');

  // 同样高码率下孤立单点尖峰仍可检出
  const clickHi = pulse(new Float32Array(hiRate), [5000]);
  eq(detectChannelPops(clickHi, hiRate).length, 1, 'single click detected at 11kHz');
}

// ---- 多处尖峰相互独立 ----
{
  const data = pulse(zeroTrack(), [100, 400, 700]);
  eq(
    detectChannelPops(data, RATE).map((r) => r.startFrame),
    [100, 400, 700],
    'separate spikes reported separately in time order',
  );
}

// ---- NaN 不当作异常，也不污染统计 ----
{
  const data = zeroTrack();
  data[100] = NaN;
  data[200] = 0.9;
  const runs = detectChannelPops(data, RATE);
  eq(runs.length, 1, 'NaN ignored, real spike still detected');
  eq(runs[0].startFrame, 200, 'detected run is the real spike');
}

// ---- scanChannelRuns：附带声道号 ----
{
  const l = pulse(zeroTrack(), [100]);
  const r = pulse(zeroTrack(), [100]);
  const runs = scanChannelRuns(popSourceFromBuffer(makeBuffer([l, r], RATE)));
  eq(runs.length, 2, 'one run per channel');
  eq(
    runs.map((r) => r.channel).sort((a, b) => a - b),
    [0, 1],
    'runs carry channel index',
  );
}

// ---- 跨声道合并展示 ----
{
  const l = pulse(zeroTrack(), [100]);
  const r = pulse(zeroTrack(), [100]);
  const events = detectPops(popSourceFromBuffer(makeBuffer([l, r], RATE)));
  eq(events.length, 1, 'same-time hits across channels merge into one event');
  eq(events[0].channels, [0, 1], 'merged event lists both channels');
  approx(events[0].start, 0.1, 1e-9, 'event start in seconds');
  approx(events[0].end, 0.101, 1e-9, 'event end in seconds');
  eq(events[0].runs.length, 2, 'per-channel runs retained for repair');
  // id 确定性
  const again = detectPops(popSourceFromBuffer(makeBuffer([pulse(zeroTrack(), [100]), pulse(zeroTrack(), [100])], RATE)));
  eq(again[0].id, events[0].id, 'event ids are deterministic for the same hits');

  // 时间相距远超 1ms 的命中不合并
  const l2 = pulse(zeroTrack(), [100]);
  const r2 = pulse(zeroTrack(), [500]);
  eq(detectPops(popSourceFromBuffer(makeBuffer([l2, r2], RATE))).length, 2, 'distant hits stay separate');

  // 间隔 ≤ 1ms（gap 帧内）跨声道合并
  const gapFrames = Math.round(CROSS_CHANNEL_GAP_SEC * RATE);
  eq(gapFrames, 1, 'cross-channel merge gap is 1 frame at 1kHz');
  const l3 = pulse(zeroTrack(), [100]);
  const r3 = pulse(zeroTrack(), [103]); // 相距 3 帧 > 1ms -> 分开
  eq(detectPops(popSourceFromBuffer(makeBuffer([l3, r3], RATE))).length, 2, 'hits 3ms apart stay separate');
  const l4 = pulse(zeroTrack(), [100]);
  const r4 = pulse(zeroTrack(), [101]); // 相邻 1 帧 -> 合并
  const mergedNear = detectPops(popSourceFromBuffer(makeBuffer([l4, r4], RATE)));
  eq(mergedNear.length, 1, 'hits within 1ms merge across channels');
  eq(mergedNear[0].channels, [0, 1], 'near merged channels');
  eq([mergedNear[0].startFrame, mergedNear[0].endFrame], [100, 102], 'near merged span covers both');
}

// ---- repairPops：只插值勾选区间的受影响声道，其余恒等 ----
{
  // 手工构造事件，验证线性插值取两端正常采样
  const data = zeroTrack();
  data[9] = 0.2; // 左锚点
  data[13] = 0.4; // 右锚点
  const buf = makeBuffer([data], RATE);
  const ev: PopEvent = {
    id: 'x',
    start: 0.01,
    end: 0.013,
    startFrame: 10,
    endFrame: 13,
    channels: [0],
    runs: [{ channel: 0, startFrame: 10, endFrame: 13 }],
  };
  const out = repairPops(buf, [ev]);
  eq([out.numberOfChannels, out.sampleRate, out.length], [1, RATE, RATE], 'shape preserved');
  ok(out.channels[0] !== data, 'returns a new array (source untouched)');
  approx(out.channels[0][9], 0.2, 1e-6, 'left anchor untouched');
  approx(out.channels[0][13], 0.4, 1e-6, 'right anchor untouched');
  approx(out.channels[0][10], 0.25, 1e-6, 'linear interpolation i=10');
  approx(out.channels[0][11], 0.3, 1e-6, 'linear interpolation i=11');
  approx(out.channels[0][12], 0.35, 1e-6, 'linear interpolation i=12');
  eq(out.channels[0][0], 0, 'sample far before untouched');
  eq(out.channels[0][999], 0, 'sample far after untouched');
  eq(out.runs.length, 1, 'applied runs reported');
}

// 真实检测 → 修复往返：尖峰被插值为 0，原始缓冲不修改
{
  const original = pulse(zeroTrack(), [100]);
  const buf = makeBuffer([original], RATE);
  const events = detectPops(popSourceFromBuffer(buf));
  const out = repairPops(buf, events);
  eq(out.channels[0][100], 0, 'isolated spike on silence interpolated away');
  approx(original[100], 0.9, 1e-6, 'original buffer PCM is never modified');
  let identical = 0;
  for (let i = 0; i < RATE; i++) if (out.channels[0][i] === original[i]) identical++;
  eq(identical, RATE - 1, 'every non-pop sample identical to source');
}

// 立体声：只修受影响声道，另一声道逐帧恒等
{
  const l = pulse(zeroTrack(), [100]);
  const r = new Float32Array(RATE).fill(0.1);
  const buf = makeBuffer([l, r], RATE);
  const events = detectPops(popSourceFromBuffer(buf));
  eq(events.length, 1, 'one event on left channel only');
  eq(events[0].channels, [0], 'only left channel affected');
  const out = repairPops(buf, events);
  eq(out.channels[0][100], 0, 'left spike repaired');
  approx(out.channels[1][100], 0.1, 1e-6, 'right channel untouched at the same frame');
  approx(out.channels[1][0], 0.1, 1e-6, 'right channel untouched elsewhere');
}

// 同一声道上重叠 run（跨事件勾选）先合并，不重复插值
{
  const data = pulse(zeroTrack(), [100, 101, 102]);
  const buf = makeBuffer([data], RATE);
  const events: PopEvent[] = [
    {
      id: 'a', start: 0.1, end: 0.102, startFrame: 100, endFrame: 102, channels: [0],
      runs: [{ channel: 0, startFrame: 100, endFrame: 102 }],
    },
    {
      id: 'b', start: 0.101, end: 0.103, startFrame: 101, endFrame: 103, channels: [0],
      runs: [{ channel: 0, startFrame: 101, endFrame: 103 }],
    },
  ];
  const out = repairPops(buf, events);
  eq(out.runs, [{ channel: 0, startFrame: 100, endFrame: 103 }], 'overlapping same-channel runs merge before interpolation');
  eq(out.channels[0][100], 0, 'merged repair covers frame 100');
  eq(out.channels[0][102], 0, 'merged repair covers frame 102');
}

// NaN 锚点按 0 处理；区间外 NaN 原样保留（交给 WAV 编码层归零）
{
  const data = zeroTrack();
  data[100] = 0.9;
  data[101] = 0.9;
  data[102] = NaN; // 右锚点为 NaN
  const buf = makeBuffer([data], RATE);
  // NaN 不参与检测，这里手工指定 run [100,102)，右锚点帧 102 为 NaN
  const out = repairPops(buf, [
    {
      id: 'nan',
      start: 0.1,
      end: 0.102,
      startFrame: 100,
      endFrame: 102,
      channels: [0],
      runs: [{ channel: 0, startFrame: 100, endFrame: 102 }],
    },
  ]);
  // 左锚点 0、右锚点 NaN→0，插值结果恒为 0
  eq(out.channels[0][100], 0, 'NaN anchor treated as 0 (i=100)');
  eq(out.channels[0][101], 0, 'NaN anchor treated as 0 (i=101)');
  ok(Number.isNaN(out.channels[0][102]), 'NaN outside run preserved for encoder');
}

// 失败路径
{
  throws(() => repairPops(makeBuffer([new Float32Array(0)], RATE), []), '尚未导入', 'empty buffer throws');
  throws(() => repairPops(makeBuffer([zeroTrack()], RATE), []), '有效爆音', 'no events throws');
}

// ---- encodeRepairedWav：完整时长 / 声道 / 采样率 / 16-bit PCM ----
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
  const buf = makeBuffer([pulse(new Float32Array(rate), [rate / 2])], rate);
  const pcm = repairPops(buf, detectPops(popSourceFromBuffer(buf)));
  const wav = encodeRepairedWav(pcm);
  const parsed = parseWav(wav);
  eq(wav.length, 44 + rate * 2, 'wav covers the WHOLE file (total duration kept)');
  eq([parsed.channels, parsed.sampleRate, parsed.bits], [1, rate, 16], 'mono / rate / 16-bit kept');
  eq(parsed.frames, rate, 'frame count equals original length');
  eq(parsed.samples[rate / 2], 0, 'repaired sample is silence');
  eq(parsed.samples[0], 0, 'other samples untouched');

  // 立体声交错 + 等长
  const spcm = repairPops(
    makeBuffer([pulse(zeroTrack(), [100]), new Float32Array(RATE).fill(-0.25)], RATE),
    detectPops(
      popSourceFromBuffer(makeBuffer([pulse(zeroTrack(), [100]), new Float32Array(RATE).fill(-0.25)], RATE)),
    ),
  );
  const sw = parseWav(encodeRepairedWav(spcm));
  eq([sw.channels, sw.sampleRate, sw.frames], [2, RATE, 1000], 'stereo shape kept');
  eq(sw.samples[100 * 2], 0, 'left repaired sample 0');
  eq(sw.samples[100 * 2 + 1], Math.round(-0.25 * 32768), 'right sample at same frame untouched');
}

// ---- mergeCrossChannelRuns 直接调用：事件按时间排序、声道去重 ----
{
  const merged = mergeCrossChannelRuns(
    [
      { channel: 1, startFrame: 500, endFrame: 502 },
      { channel: 0, startFrame: 100, endFrame: 101 },
      { channel: 0, startFrame: 501, endFrame: 503 },
    ],
    RATE,
  );
  eq(merged.length, 2, 'two merged events sorted by time');
  eq(merged[0].startFrame, 100, 'earlier event first');
  eq(merged[1].channels, [0, 1], 'channels sorted and deduped');
  eq([merged[1].startFrame, merged[1].endFrame], [500, 503], 'union span across channels');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all pop-repair tests passed');
}
