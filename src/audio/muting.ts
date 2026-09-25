import type { AudioBufferLike } from '../types';
import { encodeWavPcm16 } from '../utils/audioPack';

/**
 * 敏感片段消音（纯函数 + 一个 DOM 缓冲构造助手）。
 *
 * 处理流水线：
 * 1. 秒级区间先钳制到 [0, 音频时长]，再换算成采样帧（左闭右开）；
 * 2. 按采样帧合并相互重叠或首尾相接的区间（相接也合一，避免边界双斜坡）；
 * 3. 每段消音起止各用至多 20ms 的线性衰减 / 恢复包络（区间短于
 *    2×20ms 时两侧等比缩短，绝不越过区间边界，也不互相重叠）；
 * 4. 输出与原缓冲等长、同声道数、同采样率的新 PCM——区间外逐采样恒等，
 *    总时长不变；编码为 16-bit PCM WAV 时复用 audioPack 的同一实现。
 */

/** 用户标记的消音区间（秒）。 */
export interface MuteRegion {
  id: string;
  start: number;
  end: number;
}

/** 采样帧区间（左闭右开 [startFrame, endFrame)）。 */
export interface FrameRange {
  startFrame: number;
  endFrame: number;
}

/** 合并后的采样帧区间 + 实际生效的衰减 / 恢复帧数。 */
export interface PreparedMuteRange extends FrameRange {
  /** 起点衰减斜坡帧数（≤ 20ms） */
  fadeInFrames: number;
  /** 终点恢复斜坡帧数（≤ 20ms） */
  fadeOutFrames: number;
}

export interface MutedPcm {
  /** 每个声道一份与原缓冲等长的新 Float32Array（原数据不被修改） */
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  /** 实际应用的合并区间（含包络帧数），用于 UI 摘要与测试断言 */
  ranges: PreparedMuteRange[];
}

/** 消音起止包络的最大长度：20 毫秒。 */
export const MAX_FADE_MS = 20;
export const MAX_FADE_SEC = MAX_FADE_MS / 1000;

/**
 * 秒级区间 → 钳制后的采样帧区间。非有限输入或钳制后为零长度返回 null，
 * 语义与 audioPack.chapterToSampleRange 一致（先钳制再换算、左闭右开）。
 */
export function regionToFrameRange(
  start: number,
  end: number,
  sampleRate: number,
  length: number,
): FrameRange | null {
  if (!(length > 0) || !(sampleRate > 0)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const duration = length / sampleRate;
  const s = Math.min(Math.max(start, 0), duration);
  const e = Math.min(Math.max(end, 0), duration);
  const startFrame = Math.min(Math.max(Math.round(s * sampleRate), 0), length);
  const endFrame = Math.min(Math.max(Math.round(e * sampleRate), 0), length);
  if (endFrame <= startFrame) return null;
  return { startFrame, endFrame };
}

/**
 * 合并重叠或首尾相接的采样帧区间（输入任意顺序）。相接（a.end === b.start）
 * 也合一：消音后相邻静音段之间没有可听边界，合并后只留一对包络。
 */
export function mergeFrameRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = [...ranges].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const out: FrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startFrame <= last.endFrame) {
      if (r.endFrame > last.endFrame) last.endFrame = r.endFrame;
    } else {
      out.push({ startFrame: r.startFrame, endFrame: r.endFrame });
    }
  }
  return out;
}

/**
 * 钳制、换算并合并用户标记，得到最终消音段及各段 ≤20ms 的包络帧数。
 * 区间短于 2×20ms（按采样帧取整）时，两侧斜坡等比缩短、刚好铺满该段，
 * 绝不越过边界；短到无法平分时，多出的 1 帧分给恢复侧，保证衰减从首帧开始。
 */
export function prepareMuteRanges(
  regions: Array<{ start: number; end: number }>,
  buffer: AudioBufferLike,
): PreparedMuteRange[] {
  const { sampleRate, length } = buffer;
  const frames: FrameRange[] = [];
  for (const r of regions) {
    const fr = regionToFrameRange(r.start, r.end, sampleRate, length);
    if (fr) frames.push(fr);
  }
  const maxFade = Math.max(1, Math.round(MAX_FADE_SEC * sampleRate));
  return mergeFrameRanges(frames).map((r) => {
    const span = r.endFrame - r.startFrame;
    const fadeInFrames = Math.min(maxFade, Math.floor(span / 2));
    const fadeOutFrames = Math.min(maxFade, span - fadeInFrames);
    return { ...r, fadeInFrames, fadeOutFrames };
  });
}

/**
 * 生成消音后的整段 PCM：区间外逐采样复制（等长、同声道、同采样率），
 * 区间内乘以线性包络——起点从原音量线性降到 0，区间主体为 0，
 * 终点从 0 线性恢复到原音量。NaN 输入按 0 处理。无有效区间时抛错。
 */
export function applyMuting(buffer: AudioBufferLike, regions: MuteRegion[]): MutedPcm {
  if (!buffer || !(buffer.length > 0)) {
    throw new Error('尚未导入音频，无法处理消音区间。');
  }
  const numberOfChannels = buffer.numberOfChannels;
  if (!(numberOfChannels >= 1)) throw new Error('音频没有可用声道。');
  const prepared = prepareMuteRanges(regions, buffer);
  if (prepared.length === 0) {
    throw new Error('没有落在音频范围内的有效消音区间。');
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
    // 区间外保持原样（逐帧复制，NaN 也照原样，区间内再归零）
    for (let i = 0; i < length; i++) output[i] = input[i];
    for (const r of prepared) {
      const { startFrame: s, endFrame: e, fadeInFrames: fi, fadeOutFrames: fo } = r;
      const span = e - s;
      for (let i = s; i < e; i++) {
        const d = i - s;
        let gain = 0;
        if (fi > 0 && d < fi) {
          gain = (fi - d) / fi; // 1 → 0 线性衰减
        } else if (fo > 0 && d >= span - fo) {
          gain = (d - (span - fo)) / fo; // 0 → 1 线性恢复
        }
        const v = input[i];
        output[i] = gain === 0 || Number.isNaN(v) ? 0 : v * gain;
      }
    }
  }
  return {
    channels,
    sampleRate: buffer.sampleRate,
    numberOfChannels,
    length,
    ranges: prepared,
  };
}

/**
 * 把处理后的 PCM 包成 WAV 字节：全长 16-bit PCM，声道数与采样率不变。
 */
export function encodeMutedWav(pcm: MutedPcm): Uint8Array {
  const buffer: AudioBufferLike = {
    duration: pcm.length / pcm.sampleRate,
    length: pcm.length,
    sampleRate: pcm.sampleRate,
    numberOfChannels: pcm.numberOfChannels,
    getChannelData: (ch) => pcm.channels[ch],
  };
  return encodeWavPcm16(buffer, { startSample: 0, endSample: pcm.length });
}

/** 处理后 PCM 的最小结构（MutedPcm 与爆音修复的 RepairedPcm 均满足）。 */
export interface PcmData {
  channels: Float32Array[];
  sampleRate: number;
  numberOfChannels: number;
  length: number;
}

/**
 * 把处理后的 PCM 载入为 Web Audio AudioBuffer，供处理结果试听。
 * 试听与 WAV 下载来自同一份处理结果 PCM，保证「听到的」即「下载的」。
 */
export function pcmToAudioBuffer(pcm: PcmData, ctx: BaseAudioContext): AudioBuffer {
  const audioBuffer = ctx.createBuffer(pcm.numberOfChannels, pcm.length, Math.round(pcm.sampleRate));
  for (let ch = 0; ch < pcm.numberOfChannels; ch++) {
    const out = audioBuffer.getChannelData(ch);
    const src = pcm.channels[ch];
    for (let i = 0; i < pcm.length; i++) out[i] = src[i];
  }
  return audioBuffer;
}

/**
 * UI 输入校验：把秒数钳制到 [0, duration]；非有限数字或钳制后起点 ≥ 终点
 * 返回 null（调用方提示原因，不写入标记）。
 */
export function clampMuteRegion(
  start: number,
  end: number,
  duration: number,
): { start: number; end: number } | null {
  if (!(duration > 0)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const s = Math.min(Math.max(start, 0), duration);
  const e = Math.min(Math.max(end, 0), duration);
  if (!(e > s)) return null;
  return { start: s, end: e };
}
