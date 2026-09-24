import type { AudioBufferLike } from '../types';
import { encodeWavPcm16 } from '../utils/audioPack';

/**
 * 短促爆音检测与修复（纯函数）。
 *
 * 检测流水线（逐声道扫描原始 PCM，不修改原缓冲）：
 * 1. 把整段 PCM 按 ~20ms 不重叠分块，逐块求样本中位数 med 与中位绝对
 *    偏差 MAD（稳健尺度 σ = 1.4826·MAD，块内 ≤50% 异常值时统计量不被
 *    污染，因此孤立尖峰不会抬高自己所在块的阈值）；
 * 2. 样本偏离本块中位数超过 max(Z 阈值·σ, 最小绝对偏差) 即标为异常；
 * 3. 相邻异常采样合并为一处 run，只保留：长度 ≤ 5ms（MAX_POP_MS）、
 *    不贴音频首尾、且两侧守卫窗内的采样回到邻域基线（瞬时邻点与
 *    5ms 窗中位数都在 RETURN_Z·σ 内）的孤立尖峰——持续鼓点的异常段
 *    会一直延续到波形回落之后，长度超 5ms，不会被列为爆音；
 * 4. 跨声道时间重叠（或相距 ≤1ms）的 run 合并为一个 PopEvent 展示，
 *    但修复仍逐声道只插值该声道受影响的 run。
 *
 * 修复：仅在勾选事件的受影响声道内，用 run 两端「正常采样」做线性
 * 插值覆盖 run 本体，区间外逐采样复制；输出等长、同声道、同采样率。
 */

/** 局部统计块长（秒）：块内少于半数异常时中位数 / MAD 仍稳健。 */
export const STAT_BLOCK_SEC = 0.02;
/** 只识别不长于该时长的孤立尖峰（毫秒 / 秒）。 */
export const MAX_POP_MS = 5;
export const MAX_POP_SEC = MAX_POP_MS / 1000;
/** 判定异常的稳健 z 阈值：|x - med| > Z·1.4826·MAD。 */
export const Z_THRESHOLD = 8;
/** 两侧「回到基线」的稳健 z 阈值。 */
export const RETURN_Z = 3;
/** 绝对偏差下限（线性幅度）：静音/极低噪块不因 σ≈0 而误报。 */
export const MIN_SPIKE_DELTA = 0.02;
/** 端点回到基线校验所用邻域窗长（秒，单侧）。 */
export const GUARD_SEC = 0.005;
/** 跨声道命中合并的最大间隔（秒）：重叠或相距 ≤1ms 视为同一处。 */
export const CROSS_CHANNEL_GAP_SEC = 0.001;

/** 单声道上的一处连续异常采样区间 [startFrame, endFrame)。 */
export interface PopRun {
  channel: number;
  startFrame: number;
  endFrame: number;
}

/** 跨声道合并后的一处爆音（列表展示单位）。 */
export interface PopEvent {
  id: string;
  start: number; // 秒（所有声道 run 的最早起点）
  end: number; // 秒（所有声道 run 的最晚终点）
  startFrame: number;
  endFrame: number;
  /** 受影响声道（0 基，升序去重）。 */
  channels: number[];
  /** 各声道原始 run，修复时逐声道使用。 */
  runs: PopRun[];
}

/** 检测所需输入：只要声道 PCM，不接收 AudioBuffer 本身。 */
export interface PopScanSource {
  duration: number;
  length: number;
  sampleRate: number;
  channels: readonly Float32Array[];
}

export interface PopScanWorkerRequest extends PopScanSource {
  id: number;
}

export interface PopScanWorkerResponse {
  id: number;
  runs: PopRun[];
}

/** 修复后的完整 PCM（结构同 muting.MutedPcm，供试听缓冲与 WAV 同源）。 */
export interface RepairedPcm {
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  /** 实际插值修复的声道级 run（去重后，按声道 / 时间排序）。 */
  runs: PopRun[];
}

/** Build a scan source from an AudioBuffer; copies are taken by the caller. */
export function popSourceFromBuffer(buffer: AudioBufferLike): PopScanSource {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return {
    duration: buffer.duration,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    channels,
  };
}

/** 非比较选择：无序数组中第 k 小（k 从 0 起），原地分区。 */
function quickSelect(arr: Float32Array, k: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  // 防御性深度上限：分区退化时退回对当前窗口排序，保证终止
  while (lo < hi) {
    const pivot = arr[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
      if (i <= j) {
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return arr[k];
}

/** 中位数（数据会被原地打乱，调用方需传入副本）。 */
function medianOf(scratch: Float32Array): number {
  const n = scratch.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  const a = quickSelect(scratch, mid);
  if ((n & 1) === 1) return a;
  // 偶数长度：取下中位与上一个的均值。再选一次 [0, mid-1] 的最大值即
  // quickSelect(..., mid-1)（分区后 scratch[mid-1] 即第二小的后半界）
  const b = quickSelect(scratch, mid - 1);
  return (a + b) / 2;
}

interface BlockStat {
  med: number;
  /** 判定阈值：max(Z·1.4826·MAD, MIN_SPIKE_DELTA) */
  delta: number;
  /** 回到基线阈值：max(RETURN_Z·1.4826·MAD, MIN_SPIKE_DELTA/2) */
  returnDelta: number;
}

/**
 * 逐块稳健统计。最后一个不足一块的尾块照常统计（块数 ≥1）。
 * 每块复制一份样本做选择排序，原数据不被修改。
 */
export function computeBlockStats(
  data: Float32Array,
  blockSize: number,
): BlockStat[] {
  const n = data.length;
  const count = Math.max(1, Math.ceil(n / blockSize));
  const stats: BlockStat[] = [];
  for (let b = 0; b < count; b++) {
    const s0 = b * blockSize;
    const s1 = Math.min(n, s0 + blockSize);
    // 复制一份再做原地选择排序；NaN 不参与稳健统计（按 0 基线处理），
    // 否则 NaN 会污染中位数比较，原数据始终不被修改。
    const slice = new Float32Array(s1 - s0);
    for (let i = s0; i < s1; i++) {
      const v = data[i];
      slice[i - s0] = Number.isFinite(v) ? v : 0;
    }
    const med = medianOf(slice); // slice 已被打乱，不影响原始数据
    // MAD = median(|x - med|)：在同一份（已乱序）副本上重算偏差
    for (let i = 0; i < slice.length; i++) slice[i] = Math.abs(slice[i] - med);
    const mad = medianOf(slice);
    const sigma = 1.4826 * mad;
    stats.push({
      med,
      delta: Math.max(Z_THRESHOLD * sigma, MIN_SPIKE_DELTA),
      returnDelta: Math.max(RETURN_Z * sigma, MIN_SPIKE_DELTA / 2),
    });
  }
  return stats;
}

/**
 * 检测单声道上的短促爆音 run。
 *
 * 规则：异常样本连续成 run；run 长度 ≤ 5ms；两侧必须留有完整守卫窗
 * （不贴首尾）；紧邻 run 的各 GUARD 个采样全部、且守卫窗中位数都回到
 * RETURN_Z·σ 基线之内。NaN 不参与（视为正常，留给 WAV 编码层归零）。
 */
export function detectChannelPops(
  data: Float32Array,
  sampleRate: number,
  options: {
    blockSec?: number;
    maxPopSec?: number;
    guardSec?: number;
  } = {},
): PopRun[] {
  const blockSec = options.blockSec ?? STAT_BLOCK_SEC;
  const maxPopSec = options.maxPopSec ?? MAX_POP_SEC;
  const guardSec = options.guardSec ?? GUARD_SEC;
  const n = data.length;
  if (!(n > 0) || !(sampleRate > 0)) return [];

  const blockSize = Math.max(8, Math.round(blockSec * sampleRate));
  const maxRunLen = Math.max(1, Math.floor(maxPopSec * sampleRate));
  const guard = Math.max(1, Math.round(guardSec * sampleRate));
  const stats = computeBlockStats(data, blockSize);

  const isOutlier = (i: number): boolean => {
    const v = data[i];
    if (!Number.isFinite(v)) return false;
    const st = stats[Math.min(stats.length - 1, Math.floor(i / blockSize))];
    return Math.abs(v - st.med) > st.delta;
  };

  const runs: PopRun[] = [];
  let i = 0;
  while (i < n) {
    if (!isOutlier(i)) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isOutlier(i)) i++;
    const end = i; // 半开区间
    if (end - start > maxRunLen) continue; // 持续高偏离（鼓点/持续噪声）
    // 首尾必须各有完整守卫窗，否则没有两端正常采样可插值 / 验证
    if (start - guard < 0 || end + guard > n) continue;

    const leftStat = stats[Math.min(stats.length - 1, Math.floor((start - 1) / blockSize))];
    const rightStat = stats[Math.min(stats.length - 1, Math.floor(end / blockSize))];

    // 瞬时邻点：run 两侧紧挨着的 guard 个采样必须全部回到基线
    let backToBaseline = true;
    for (let k = 0; k < guard; k++) {
      const lv = data[start - 1 - k];
      const rv = data[end + k];
      if (
        !Number.isFinite(lv) ||
        !Number.isFinite(rv) ||
        Math.abs(lv - leftStat.med) > leftStat.returnDelta ||
        Math.abs(rv - rightStat.med) > rightStat.returnDelta
      ) {
        backToBaseline = false;
        break;
      }
    }
    if (!backToBaseline) continue;

    // 守卫窗中位数也需落在基线内（避免「恰好几个正常采样夹在持续异常中」）
    const lWindow = new Float32Array(guard);
    const rWindow = new Float32Array(guard);
    for (let k = 0; k < guard; k++) {
      const lv = data[start - guard + k];
      const rv = data[end + k];
      lWindow[k] = Number.isFinite(lv) ? lv : 0;
      rWindow[k] = Number.isFinite(rv) ? rv : 0;
    }
    const lMed = medianOf(lWindow);
    const rMed = medianOf(rWindow);
    if (
      Math.abs(lMed - leftStat.med) > leftStat.returnDelta ||
      Math.abs(rMed - rightStat.med) > rightStat.returnDelta
    ) {
      continue;
    }

    runs.push({ channel: -1, startFrame: start, endFrame: end });
  }
  return runs;
}

/**
 * 扫描全部声道，返回带声道号的 run（任意声道顺序，调用方排序合并）。
 */
export function scanChannelRuns(source: PopScanSource): PopRun[] {
  const all: PopRun[] = [];
  for (let ch = 0; ch < source.channels.length; ch++) {
    const runs = detectChannelPops(source.channels[ch], source.sampleRate);
    for (const r of runs) all.push({ ...r, channel: ch });
  }
  return all;
}

/**
 * 把跨声道的 run 合并为展示事件：按帧排序后，时间重叠或相距
 * ≤ CROSS_CHANNEL_GAP_SEC 的 run 并入同一处；同一声道的两个 run 也
 * 相邻时只保留覆盖更广的合并区间（逐声道修复时再去重）。
 */
export function mergeCrossChannelRuns(
  runs: PopRun[],
  sampleRate: number,
): PopEvent[] {
  const gapFrames = Math.max(0, Math.round(CROSS_CHANNEL_GAP_SEC * sampleRate));
  const sorted = [...runs].sort(
    (a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame || a.channel - b.channel,
  );
  const events: PopEvent[] = [];
  for (const r of sorted) {
    const last = events[events.length - 1];
    if (last && r.startFrame <= last.endFrame + gapFrames) {
      if (r.endFrame > last.endFrame) last.endFrame = r.endFrame;
      last.runs.push(r);
      if (!last.channels.includes(r.channel)) last.channels.push(r.channel);
    } else {
      events.push({
        id: '',
        start: 0,
        end: 0,
        startFrame: r.startFrame,
        endFrame: r.endFrame,
        channels: [r.channel],
        runs: [r],
      });
    }
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    ev.channels.sort((a, b) => a - b);
    ev.start = ev.startFrame / sampleRate;
    ev.end = ev.endFrame / sampleRate;
    ev.id = `pop-${ev.startFrame}-${ev.endFrame}-${ev.channels.join('_')}`;
  }
  return events;
}

/** 扫描 + 跨声道合并，一步得到展示列表。 */
export function detectPops(source: PopScanSource): PopEvent[] {
  return mergeCrossChannelRuns(scanChannelRuns(source), source.sampleRate);
}

/**
 * 对勾选事件做逐声道线性插值修复。
 *
 * 只处理每个事件受影响声道上的 run：取 run 前一帧 / 后一帧这两个
 * 「正常采样」为锚点，线性插值覆盖 run 本体（锚点本身不动）；其余
 * 采样逐帧复制。同一声道上重叠 / 相接的 run 先合并，避免重复插值。
 * NaN 锚点按 0 处理，输出中无 NaN 残留在修复区间内。
 */
export function repairPops(buffer: AudioBufferLike, events: PopEvent[]): RepairedPcm {
  if (!buffer || !(buffer.length > 0)) {
    throw new Error('尚未导入音频，无法修复爆音。');
  }
  const numberOfChannels = buffer.numberOfChannels;
  if (!(numberOfChannels >= 1)) throw new Error('音频没有可用声道。');
  const length = buffer.length;
  const sampleRate = buffer.sampleRate;

  // 收集落在本缓冲范围内、声道合法的 run，按声道分组
  const byChannel = new Map<number, PopRun[]>();
  for (const ev of events) {
    for (const r of ev.runs) {
      if (r.channel < 0 || r.channel >= numberOfChannels) continue;
      if (r.startFrame < 1 || r.endFrame > length - 1 || r.endFrame <= r.startFrame) continue;
      const list = byChannel.get(r.channel) ?? [];
      list.push(r);
      byChannel.set(r.channel, list);
    }
  }
  if (byChannel.size === 0) {
    throw new Error('没有可修复的有效爆音区间。');
  }

  const src: Float32Array[] = [];
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    src.push(buffer.getChannelData(ch));
    channels.push(new Float32Array(length));
  }

  const applied: PopRun[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    const input = src[ch];
    const output = channels[ch];
    output.set(input); // 区间外逐帧恒等（NaN 也原样保留给编码层）
    const list = byChannel.get(ch);
    if (!list) continue;

    const merged = [...list]
      .sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame)
      .reduce<PopRun[]>((acc, r) => {
        const last = acc[acc.length - 1];
        if (last && r.startFrame <= last.endFrame) {
          if (r.endFrame > last.endFrame) last.endFrame = r.endFrame;
        } else {
          acc.push({ channel: ch, startFrame: r.startFrame, endFrame: r.endFrame });
        }
        return acc;
      }, []);

    for (const r of merged) {
      const { startFrame: s, endFrame: e } = r;
      const v0 = input[s - 1];
      const v1 = input[e];
      const a = Number.isNaN(v0) ? 0 : v0;
      const b = Number.isNaN(v1) ? 0 : v1;
      const span = e - (s - 1); // 锚点间距（帧数）
      for (let i = s; i < e; i++) {
        output[i] = a + ((b - a) * (i - (s - 1))) / span;
      }
      applied.push({ channel: ch, startFrame: s, endFrame: e });
    }
  }

  applied.sort((a, b) => a.channel - b.channel || a.startFrame - b.startFrame);
  return { channels, sampleRate, numberOfChannels, length, runs: applied };
}

/** 把修复后的 PCM 包成完整时长的 16-bit PCM WAV（声道 / 采样率不变）。 */
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
