import type { AudioBufferLike } from '../types';
import { encodeWavPcm16 } from '../utils/audioPack';

/**
 * 短促爆音（咔哒声 / 爆点）检测与修复（纯函数 + Worker 消息类型）。
 *
 * 检测流水线（每声道独立）：
 * 1. 局部稳健统计：12ms 窗口、4ms 步进（窗芯 4ms 平铺整段信号，不重不漏），
 *    每窗求中位数 median 与中位绝对偏差 MAD（×1.4826 折算 σ）。窗口明显长
 *    于最大爆音时长（5ms），单个爆音在窗内占比始终低于 50%，统计量不会被
 *    爆音本身带偏；
 * 2. 逐样本判定：|x − median| > max(6σ, 1e-3) 记为异常（1e-3 ≈ -60dBFS
 *    绝对下限，数字静音不会整段误报）；
 * 3. 相邻异常采样（间隔 ≤ max(3, 1ms)）合并为一处；合并后不超过 5ms、且
 *    两端各 3 个采样都回到「异常段之前 12ms 邻域」的基线（4σ 内）才算爆
 *    音——持续鼓点 / 音乐瞬态在异常段之后电平仍然偏高、回不到基线，在
 *    此被排除；
 * 4. 跨声道同一时刻（起点相差 ≤1ms）的命中合并为一条展示。
 *
 * 修复：仅在勾选区间的受影响声道内，用区间两端相邻的正常采样做线性插值；
 * 输出与原缓冲等长、同声道数、同采样率的新 PCM，原数据不被修改；WAV 编
 * 码复用 audioPack 的同一实现。
 */

/** 可判定为爆音的最长异常段：5ms。 */
export const MAX_CLICK_SEC = 0.005;
/** 局部统计窗口：12ms（明显长于最大爆音，窗内爆音占比 <50%）。 */
export const STATS_WINDOW_SEC = 0.012;
/** 统计窗口步进：4ms（窗芯 4ms 平铺）。 */
export const STATS_HOP_SEC = 0.004;
/** 异常判定倍数：|x − median| > K·σ。 */
export const ANOMALY_K = 6;
/** 两端回到基线的判定倍数（相对异常段之前的邻域基线）。 */
export const GUARD_K = 4;
/** 两端各需回到基线的采样数。 */
export const GUARD_SAMPLES = 3;
/** 相邻异常采样合并的最大间隔：1ms。 */
export const BRIDGE_SEC = 0.001;
/** 跨声道命中合并展示的最大起点差：1ms。 */
export const CROSS_CHANNEL_SEC = 0.001;
/** 偏差绝对下限（≈ -60dBFS）：数字静音不致整段误报。 */
export const MIN_ABS_DEV = 1e-3;
/** MAD → σ 的折算系数（正态分布下 MAD ≈ 0.6745σ）。 */
export const MAD_TO_SIGMA = 1.4826;
/** 单次扫描最多展示的爆音条数（超出时保留偏差最大者）。 */
export const MAX_EVENTS = 500;

/** 扫描输入：只要声道 PCM，不要 AudioBuffer 本身。 */
export interface ClickScanSource {
  length: number;
  sampleRate: number;
  channels: readonly Float32Array[];
}

/** 单声道内一段合并后的异常采样区间（帧，左闭右开）。 */
export interface ClickRun {
  channel: number;
  startFrame: number;
  endFrame: number;
  /** 段内最大偏差（相对判定阈值的倍数，≥1） */
  strength: number;
}

export interface ClickEvent {
  id: string;
  /** 展示用并集区间（秒） */
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  /** 受影响声道（升序） */
  channels: number[];
  /** 各声道各自的异常区间：修复按声道分别插值，不动邻接的正常采样 */
  runs: ClickRun[];
  strength: number;
}

export interface RepairedPcm {
  /** 每个声道一份与原缓冲等长的新 Float32Array（原数据不被修改） */
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  /** 实际修复的声道区间数 */
  applied: number;
}

export interface ClickDetectOptions {
  maxClickSec?: number;
  statsWindowSec?: number;
  statsHopSec?: number;
  anomalyK?: number;
  guardK?: number;
  guardSamples?: number;
  bridgeSec?: number;
  crossChannelSec?: number;
  minAbsDev?: number;
  maxEvents?: number;
}

/** 发往爆音扫描 Worker 的消息。 */
export interface ClickScanWorkerRequest extends ClickScanSource {
  id: number;
}

/** 爆音扫描 Worker 回传的结果。 */
export interface ClickScanWorkerResponse {
  id: number;
  events: ClickEvent[];
}

/** 从 AudioBuffer 构建扫描输入；声道副本由调用方负责。 */
export function clickScanSourceFromBuffer(buffer: AudioBufferLike): ClickScanSource {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return { length: buffer.length, sampleRate: buffer.sampleRate, channels };
}

/**
 * 局部中位数与 MAD（×1.4826 折算 σ）：取 data[from, to) 的副本排序求中位
 * 数，再就地对偏差副本排序求 MAD。TypedArray.sort 为数值排序、NaN 排在末
 * 尾——个别 NaN 不影响中位数；若窗口过半为 NaN，median 为 NaN，调用方的
 * 偏差比较自然全部失效（不会误报）。
 */
export function medianSigma(
  data: Float32Array,
  from: number,
  to: number,
): { median: number; sigma: number } {
  const start = Math.max(0, from);
  const n = Math.max(0, Math.min(to, data.length) - start);
  if (n <= 0) return { median: 0, sigma: 0 };
  const sorted = data.slice(start, start + n).sort();
  const mid = n >> 1;
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  for (let i = 0; i < n; i++) sorted[i] = Math.abs(sorted[i] - median);
  sorted.sort();
  const mad = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { median, sigma: MAD_TO_SIGMA * mad };
}

interface ResolvedOptions {
  maxClickFrames: number;
  windowFrames: number;
  hopFrames: number;
  anomalyK: number;
  guardK: number;
  guardSamples: number;
  bridgeFrames: number;
  crossGapFrames: number;
  minAbsDev: number;
  maxEvents: number;
}

function resolveOptions(sampleRate: number, options: ClickDetectOptions): ResolvedOptions {
  const guardSamples = options.guardSamples ?? GUARD_SAMPLES;
  return {
    // 「不超过 5ms」向下取整：5ms 整的段仍算爆音
    maxClickFrames: Math.max(1, Math.floor((options.maxClickSec ?? MAX_CLICK_SEC) * sampleRate)),
    windowFrames: Math.max(8, Math.round((options.statsWindowSec ?? STATS_WINDOW_SEC) * sampleRate)),
    hopFrames: Math.max(1, Math.round((options.statsHopSec ?? STATS_HOP_SEC) * sampleRate)),
    anomalyK: options.anomalyK ?? ANOMALY_K,
    guardK: options.guardK ?? GUARD_K,
    guardSamples,
    // 桥接间隔不小于护卫采样数：间隔再小就会被护卫判定互相干扰，不如先合一
    bridgeFrames: Math.max(guardSamples, Math.round((options.bridgeSec ?? BRIDGE_SEC) * sampleRate)),
    crossGapFrames: Math.max(0, Math.round((options.crossChannelSec ?? CROSS_CHANNEL_SEC) * sampleRate)),
    minAbsDev: options.minAbsDev ?? MIN_ABS_DEV,
    maxEvents: options.maxEvents ?? MAX_EVENTS,
  };
}

interface RawRun {
  start: number;
  end: number;
  strength: number;
}

/**
 * 单声道异常采样扫描：窗口统计 → 逐样本判定 → 邻近合并。
 * 每个窗口只评价其「窗芯」（相邻窗芯恰好平铺整段信号），统计量却取自完整
 * 窗口，避免窗边缘样本用到偏斜的邻域。
 */
function flagChannelRuns(data: Float32Array, o: ResolvedOptions): RawRun[] {
  const n = data.length;
  const W = o.windowFrames;
  const hop = o.hopFrames;
  const corePad = Math.floor((W - hop) / 2);
  const winCount = Math.max(1, Math.ceil((n - corePad) / hop));
  const raw: RawRun[] = [];
  let runStart = -1;
  let runStrength = 0;
  for (let w = 0; w < winCount; w++) {
    let wStart = w * hop;
    if (wStart + W > n) wStart = Math.max(0, n - W);
    const wEnd = Math.min(n, wStart + W);
    const { median, sigma } = medianSigma(data, wStart, wEnd);
    const tol = Math.max(o.anomalyK * sigma, o.minAbsDev);
    const coreStart = w === 0 ? 0 : Math.min(n, w * hop + corePad);
    const coreEnd = w === winCount - 1 ? n : Math.min(n, (w + 1) * hop + corePad);
    for (let j = coreStart; j < coreEnd; j++) {
      const dev = Math.abs(data[j] - median);
      if (dev > tol) {
        const ratio = dev / tol;
        if (runStart < 0) {
          runStart = j;
          runStrength = ratio;
        } else if (ratio > runStrength) {
          runStrength = ratio;
        }
      } else if (runStart >= 0) {
        raw.push({ start: runStart, end: j, strength: runStrength });
        runStart = -1;
      }
    }
  }
  if (runStart >= 0) raw.push({ start: runStart, end: n, strength: runStrength });
  // 相邻异常采样（间隔 ≤ bridge）合并为一处
  const merged: RawRun[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= o.bridgeFrames) {
      last.end = r.end;
      if (r.strength > last.strength) last.strength = r.strength;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/**
 * 全声道爆音检测：逐声道找异常段，只保留「≤5ms 且两端回到邻域基线」的孤
 * 立尖峰，再把跨声道同一时刻的命中合并展示。纯函数——同时跑在爆音扫描
 * Web Worker 与主线程兜底中。
 */
export function detectClicks(
  source: ClickScanSource,
  options: ClickDetectOptions = {},
): ClickEvent[] {
  if (!(source.sampleRate > 0) || !(source.length > 0) || source.channels.length === 0) {
    throw new Error('音频数据无效。');
  }
  const rate = source.sampleRate;
  const n = source.length;
  const o = resolveOptions(rate, options);
  const runs: ClickRun[] = [];
  for (let ch = 0; ch < source.channels.length; ch++) {
    const data = source.channels[ch];
    if (!data) continue;
    for (const r of flagChannelRuns(data, o)) {
      const len = r.end - r.start;
      // 持续过长：鼓点 / 持续失真，不是短促爆音
      if (len > o.maxClickFrames) continue;
      // 两端必须各有正常采样：既用于基线判定，也是修复插值的端点
      if (r.start < o.guardSamples || r.end + o.guardSamples > n) continue;
      // 邻域基线：异常段之前一个统计窗口
      const base = medianSigma(data, Math.max(0, r.start - o.windowFrames), r.start);
      const guardTol = Math.max(o.guardK * base.sigma, o.minAbsDev);
      let isolated = true;
      for (let j = r.start - o.guardSamples; j < r.start && isolated; j++) {
        if (Math.abs(data[j] - base.median) > guardTol) isolated = false;
      }
      for (let j = r.end; j < r.end + o.guardSamples && isolated; j++) {
        if (Math.abs(data[j] - base.median) > guardTol) isolated = false;
      }
      // 两端未回到邻域基线：持续鼓点 / 电平突变，排除
      if (!isolated) continue;
      runs.push({ channel: ch, startFrame: r.start, endFrame: r.end, strength: r.strength });
    }
  }
  // 跨声道同一时刻命中合并为一条展示（修复仍按各声道自身区间进行）
  runs.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame || a.channel - b.channel);
  const events: ClickEvent[] = [];
  for (const run of runs) {
    const last = events[events.length - 1];
    if (last && run.startFrame <= last.endFrame + o.crossGapFrames) {
      last.runs.push(run);
      if (!last.channels.includes(run.channel)) last.channels.push(run.channel);
      if (run.endFrame > last.endFrame) last.endFrame = run.endFrame;
      if (run.strength > last.strength) last.strength = run.strength;
    } else {
      events.push({
        id: '',
        start: 0,
        end: 0,
        startFrame: run.startFrame,
        endFrame: run.endFrame,
        channels: [run.channel],
        runs: [run],
        strength: run.strength,
      });
    }
  }
  let kept = events;
  if (kept.length > o.maxEvents) {
    kept = kept
      .slice()
      .sort((a, b) => b.strength - a.strength || a.startFrame - b.startFrame)
      .slice(0, o.maxEvents)
      .sort((a, b) => a.startFrame - b.startFrame);
  }
  kept.forEach((ev, i) => {
    ev.id = `click-${i + 1}`;
    ev.channels.sort((a, b) => a - b);
    ev.start = ev.startFrame / rate;
    ev.end = ev.endFrame / rate;
  });
  return kept;
}

/**
 * 生成修复后的整段 PCM：区间外逐采样复制（等长、同声道、同采样率），勾选
 * 区间内在其受影响声道上用两端相邻正常采样做线性插值。端点取自原始数据，
 * 多处修复互不影响；NaN 端点按 0 处理。没有可修复区间时抛错。
 */
export function repairClicks(buffer: AudioBufferLike, events: ClickEvent[]): RepairedPcm {
  if (!buffer || !(buffer.length > 0)) {
    throw new Error('尚未导入音频，无法修复爆音。');
  }
  const numberOfChannels = buffer.numberOfChannels;
  if (!(numberOfChannels >= 1)) throw new Error('音频没有可用声道。');
  if (events.length === 0) {
    throw new Error('请先勾选要修复的爆音。');
  }
  const length = buffer.length;
  const src: Float32Array[] = [];
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    src.push(buffer.getChannelData(ch));
    channels.push(new Float32Array(length));
  }
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const input = src[ch];
    const output = channels[ch];
    for (let i = 0; i < length; i++) output[i] = input[i];
  }
  let applied = 0;
  for (const ev of events) {
    for (const run of ev.runs) {
      const ch = run.channel;
      if (ch < 0 || ch >= numberOfChannels) continue;
      const s = run.startFrame;
      const e = run.endFrame;
      // 插值需要区间两端各一个正常采样
      if (s < 1 || e >= length || e <= s) continue;
      const input = src[ch];
      const output = channels[ch];
      let a = input[s - 1];
      let b = input[e];
      if (!Number.isFinite(a)) a = 0;
      if (!Number.isFinite(b)) b = 0;
      const span = e - s;
      for (let k = 0; k < span; k++) {
        output[s + k] = a + ((b - a) * (k + 1)) / (span + 1);
      }
      applied++;
    }
  }
  if (applied === 0) {
    throw new Error('勾选的爆音不在当前音频范围内。');
  }
  return {
    channels,
    sampleRate: buffer.sampleRate,
    numberOfChannels,
    length,
    applied,
  };
}

/**
 * 把修复后的 PCM 包成 WAV 字节：全长 16-bit PCM，声道数与采样率不变。
 */
export function encodeRepairedWav(pcm: RepairedPcm): Uint8Array {
  const buffer: AudioBufferLike = {
    duration: pcm.length / pcm.sampleRate,
    length: pcm.length,
    sampleRate: pcm.sampleRate,
    numberOfChannels: pcm.numberOfChannels,
    getChannelData: (ch) => pcm.channels[ch],
  };
  return encodeWavPcm16(buffer, { startSample: 0, endSample: pcm.length });
}
