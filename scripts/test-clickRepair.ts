import type { AudioBufferLike } from '../src/types';
import {
  detectClicks,
  encodeRepairedWav,
  medianSigma,
  repairClicks,
  type ClickEvent,
} from '../src/audio/clickRepair';

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

const RATE = 1000; // 1 sample/ms，便于断言 5ms 上限与 12ms 窗口
const N = 2000;

/** 确定性伪噪声床：幅值 ±amp，MAD 稳定，不会触发异常判定。 */
function noiseBed(n: number, amp = 0.005): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    out[i] = amp * (2 * (s - Math.floor(s)) - 1);
  }
  return out;
}

function scan(channels: Float32Array[]): ClickEvent[] {
  return detectClicks({ length: channels[0].length, sampleRate: RATE, channels });
}

// ---- medianSigma：中位数与 MAD→σ ----
{
  const a = medianSigma(new Float32Array([5, 1, 9, 3, 7]), 0, 5);
  eq(a.median, 5, 'median of odd count');
  approx(a.sigma, 1.4826 * 2, 1e-9, 'sigma from MAD (odd)');

  const b = medianSigma(new Float32Array([1, 2, 3, 4]), 0, 4);
  eq(b.median, 2.5, 'median of even count');
  approx(b.sigma, 1.4826 * 1, 1e-9, 'sigma from MAD (even)');

  const c = medianSigma(new Float32Array([9, 9, 9, 1, 1, 1, 1, 1]), 3, 8);
  eq(c.median, 1, 'sub-range median');
  eq(c.sigma, 0, 'constant sub-range has zero MAD');

  const d = medianSigma(new Float32Array(0), 0, 0);
  eq([d.median, d.sigma], [0, 0], 'empty range is zero');
}

// ---- 干净信号不产生爆音 ----
{
  // 低频正弦：局部中位数跟踪良好，无任何样本超限
  const sine = new Float32Array(N);
  for (let i = 0; i < N; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 2 * i) / RATE);
  eq(scan([sine]), [], 'clean low-frequency sine yields no events');

  // 纯噪声床：偏差远小于 6σ
  eq(scan([noiseBed(N)]), [], 'noise bed alone yields no events');

  // 数字静音：绝对下限 1e-3 防止整段误报
  eq(scan([new Float32Array(N)]), [], 'digital silence yields no events');
}

// ---- 孤立尖峰命中 ----
{
  const data = noiseBed(N);
  data[500] = 0.5;
  const events = scan([data]);
  eq(events.length, 1, 'single-sample spike detected');
  eq([events[0].startFrame, events[0].endFrame], [500, 501], 'spike frames');
  eq(events[0].channels, [0], 'spike channel');
  eq(events[0].runs.length, 1, 'one run');
  ok(events[0].strength > 1, 'strength above threshold');
  approx(events[0].start, 0.5, 1e-9, 'start seconds from frames');

  // 4ms 尖峰（≤5ms）仍算爆音
  const four = noiseBed(N);
  for (let i = 500; i < 504; i++) four[i] = 0.5;
  const ev4 = scan([four]);
  eq(ev4.length, 1, '4ms spike detected');
  eq([ev4[0].startFrame, ev4[0].endFrame], [500, 504], '4ms spike span');

  // 静音中的爆音：走绝对下限判定
  const silent = new Float32Array(N);
  silent[500] = 0.5;
  eq(scan([silent]).length, 1, 'spike in digital silence detected');
}

// ---- 排除：过长 / 持续鼓点 / 文件边缘 ----
{
  // 6ms 异常段（>5ms）：不是短促爆音
  const long = noiseBed(N);
  for (let i = 500; i < 506; i++) long[i] = 0.5;
  eq(scan([long]), [], '6ms burst rejected as too long');

  // 持续鼓点：4ms 尖峰后电平维持高位、回不到邻域基线
  const drum = noiseBed(N);
  for (let i = 500; i < 504; i++) drum[i] = 0.5;
  for (let i = 504; i < 600; i++) drum[i] = 0.5;
  eq(scan([drum]), [], 'sustained drum-like level rejected by baseline guard');

  // 文件边缘：两端没有足够的正常采样
  const head = noiseBed(N);
  head[1] = 0.5;
  eq(scan([head]), [], 'spike near file start rejected');
  const tail = noiseBed(N);
  tail[N - 2] = 0.5;
  eq(scan([tail]), [], 'spike near file end rejected');
}

// ---- 相邻异常合并 / 跨声道合并 ----
{
  // 间隔 1 帧（≤桥接）的两个尖峰合并为一处
  const close = noiseBed(N);
  close[500] = 0.5;
  close[502] = 0.5;
  const evClose = scan([close]);
  eq(evClose.length, 1, 'spikes 1 frame apart merge into one event');
  eq([evClose[0].startFrame, evClose[0].endFrame], [500, 503], 'merged span covers both spikes');

  // 间隔 4 帧（>桥接）的两个尖峰各自成条
  const apart = noiseBed(N);
  apart[500] = 0.5;
  apart[505] = 0.5;
  const evApart = scan([apart]);
  eq(evApart.length, 2, 'spikes 4 frames apart stay separate');
  eq(evApart[0].startFrame, 500, 'first event start');
  eq(evApart[1].startFrame, 505, 'second event start');

  // 跨声道同一时刻（起点差 1 帧 ≤1ms）合并展示
  const l = noiseBed(N);
  const r = noiseBed(N);
  l[500] = 0.5;
  r[501] = 0.5;
  const evBoth = scan([l, r]);
  eq(evBoth.length, 1, 'same-time hits across channels merge for display');
  eq(evBoth[0].channels, [0, 1], 'merged event lists both channels');
  eq(evBoth[0].runs.length, 2, 'merged event keeps per-channel runs');
  eq([evBoth[0].startFrame, evBoth[0].endFrame], [500, 502], 'merged union span');

  // 跨声道但相距 100 帧：各自成条
  const l2 = noiseBed(N);
  const r2 = noiseBed(N);
  l2[500] = 0.5;
  r2[600] = 0.5;
  eq(scan([l2, r2]).length, 2, 'distant hits across channels stay separate');

  // 仅右声道有爆音
  const l3 = noiseBed(N);
  const r3 = noiseBed(N);
  r3[700] = 0.5;
  const evRight = scan([l3, r3]);
  eq(evRight.length, 1, 'right-only spike detected');
  eq(evRight[0].channels, [1], 'right-only spike affects only channel 1');
}

// ---- repairClicks：插值、等长、只动受影响声道 ----
{
  // 手工事件：端点 0 → 1 线性插值
  const data = new Float32Array(100);
  data[9] = 0;
  data[14] = 1;
  const manual: ClickEvent = {
    id: 'm1',
    start: 0.01,
    end: 0.014,
    startFrame: 10,
    endFrame: 14,
    channels: [0],
    runs: [{ channel: 0, startFrame: 10, endFrame: 14, strength: 1 }],
    strength: 1,
  };
  const buf = makeBuffer([data], RATE);
  const out = repairClicks(buf, [manual]);
  eq([out.numberOfChannels, out.sampleRate, out.length], [1, RATE, 100], 'shape preserved');
  eq(out.applied, 1, 'one run applied');
  approx(out.channels[0][10], 0.2, 1e-6, 'interpolated sample 1/4');
  approx(out.channels[0][11], 0.4, 1e-6, 'interpolated sample 2/4');
  approx(out.channels[0][12], 0.6, 1e-6, 'interpolated sample 3/4');
  approx(out.channels[0][13], 0.8, 1e-6, 'interpolated sample 4/4');
  eq(out.channels[0][9], 0, 'left endpoint untouched');
  eq(out.channels[0][14], 1, 'right endpoint untouched');
  eq(out.channels[0][50], 0, 'far sample untouched');
  ok(out.channels[0] !== data, 'returns a new array');
  eq(data[10], 0, 'original buffer not modified');

  // 只修复受影响声道：另一声道逐采样恒等
  const l = noiseBed(N);
  const r = noiseBed(N);
  r[700] = 0.5;
  const events = scan([l, r]);
  const stereo = repairClicks(makeBuffer([l, r], RATE), events);
  eq(stereo.applied, 1, 'one channel-run repaired');
  ok(Math.abs(stereo.channels[1][700]) < 0.1, 'spike replaced by interpolation');
  eq(stereo.channels[1][699], r[699], 'left neighbor of spike untouched');
  eq(stereo.channels[1][701], r[701], 'right neighbor of spike untouched');
  let identical = true;
  for (let i = 0; i < N; i++) if (stereo.channels[0][i] !== l[i]) identical = false;
  ok(identical, 'unaffected channel is sample-identical');
  eq(l[700], noiseBed(N)[700], 'source left channel untouched');

  // 多处事件 + 跨声道合并事件：applied 按声道区间计数
  const l4 = noiseBed(N);
  const r4 = noiseBed(N);
  l4[500] = 0.5;
  r4[501] = 0.5;
  l4[900] = 0.5;
  const evMulti = scan([l4, r4]);
  eq(evMulti.length, 2, 'two events (one merged cross-channel)');
  const multi = repairClicks(makeBuffer([l4, r4], RATE), evMulti);
  eq(multi.applied, 3, 'applied counts per-channel runs');
  ok(Math.abs(multi.channels[0][500]) < 0.1, 'merged event: left spike repaired');
  ok(Math.abs(multi.channels[1][501]) < 0.1, 'merged event: right spike repaired');
  ok(Math.abs(multi.channels[0][900]) < 0.1, 'second event repaired');

  // NaN 端点按 0 处理，不污染输出
  const nanData = noiseBed(100);
  nanData[9] = NaN;
  const nanEvent: ClickEvent = {
    ...manual,
    runs: [{ channel: 0, startFrame: 10, endFrame: 12, strength: 1 }],
  };
  const nanOut = repairClicks(makeBuffer([nanData], RATE), [nanEvent]);
  ok(Number.isFinite(nanOut.channels[0][10]), 'NaN endpoint treated as 0');
}

// ---- 失败路径 ----
{
  throws(
    () => repairClicks(makeBuffer([new Float32Array(0)], RATE), [{ id: 'x' } as ClickEvent]),
    '尚未导入',
    'empty buffer throws',
  );
  throws(
    () => repairClicks(makeBuffer([noiseBed(100)], RATE), []),
    '请先勾选',
    'no events throws',
  );
  const outOfRange: ClickEvent = {
    id: 'z',
    start: 5,
    end: 5.001,
    startFrame: 5000,
    endFrame: 5001,
    channels: [0],
    runs: [{ channel: 0, startFrame: 5000, endFrame: 5001, strength: 1 }],
    strength: 1,
  };
  throws(
    () => repairClicks(makeBuffer([noiseBed(100)], RATE), [outOfRange]),
    '不在当前音频范围',
    'events outside audio throw',
  );
  throws(
    () => detectClicks({ length: 0, sampleRate: 0, channels: [] }),
    '音频数据无效',
    'invalid source throws',
  );
}

// ---- NaN 不崩溃、不误报 ----
{
  const data = noiseBed(N);
  data[400] = NaN;
  data[500] = 0.5;
  const events = scan([data]);
  eq(events.length, 1, 'NaN elsewhere does not hide a real spike');
  eq(events[0].startFrame, 500, 'real spike still located');
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
  const data = new Float32Array(rate);
  data[99] = 0;
  data[105] = 1;
  const ev: ClickEvent = {
    id: 'w',
    start: 0.0125,
    end: 0.013125,
    startFrame: 100,
    endFrame: 105,
    channels: [0],
    runs: [{ channel: 0, startFrame: 100, endFrame: 105, strength: 1 }],
    strength: 1,
  };
  const pcm = repairClicks(makeBuffer([data], rate), [ev]);
  const wav = encodeRepairedWav(pcm);
  const parsed = parseWav(wav);
  eq(wav.length, 44 + rate * 2, 'wav covers the WHOLE file (total duration kept)');
  eq([parsed.channels, parsed.sampleRate, parsed.bits], [1, rate, 16], 'mono / rate / 16-bit kept');
  eq(parsed.frames, rate, 'frame count equals original length');
  eq(parsed.samples[100], Math.round((1 / 6) * 32767), 'interpolated sample encoded');
  eq(parsed.samples[105], 32767, 'right endpoint encoded');

  // 立体声交错：修复声道插值、另一声道原样
  const l = new Float32Array(1000).fill(0.25);
  const r = new Float32Array(1000).fill(-0.25);
  r[500] = 1;
  const sev: ClickEvent = {
    id: 's',
    start: 0.5,
    end: 0.501,
    startFrame: 500,
    endFrame: 501,
    channels: [1],
    runs: [{ channel: 1, startFrame: 500, endFrame: 501, strength: 1 }],
    strength: 1,
  };
  const spcm = repairClicks(makeBuffer([l, r], RATE), [sev]);
  const sw = parseWav(encodeRepairedWav(spcm));
  eq([sw.channels, sw.sampleRate, sw.frames], [2, RATE, 1000], 'stereo shape kept');
  eq(sw.samples[500 * 2], Math.round(0.25 * 32767), 'unaffected channel original');
  eq(sw.samples[500 * 2 + 1], Math.round(-0.25 * 32768), 'repaired channel interpolated to endpoint');
}

// ---- 全流程：扫描 → 修复 → 爆音消失且邻域不变 ----
{
  const l = noiseBed(N);
  const r = noiseBed(N);
  l[500] = 0.5;
  r[1200] = -0.5;
  const buf = makeBuffer([l, r], RATE);
  const events = scan([l, r]);
  eq(events.length, 2, 'pipeline finds both spikes');
  const out = repairClicks(buf, events);
  ok(Math.abs(out.channels[0][500]) < 0.1, 'left spike removed');
  ok(Math.abs(out.channels[1][1200]) < 0.1, 'right spike removed');
  eq(out.channels[0][499], l[499], 'sample before left spike untouched');
  eq(out.channels[0][501], l[501], 'sample after left spike untouched');
  eq(out.channels[1][1199], r[1199], 'sample before right spike untouched');
  eq(out.channels[1][1201], r[1201], 'sample after right spike untouched');
  eq(out.length, N, 'pipeline output length unchanged');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all click-repair tests passed');
}
