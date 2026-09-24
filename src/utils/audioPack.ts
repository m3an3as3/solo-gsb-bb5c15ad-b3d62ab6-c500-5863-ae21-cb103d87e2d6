import type { AudioBufferLike, Chapter } from '../types';

/**
 * 章节音频包导出（纯函数）：把当前章节按起止时间从已解码 AudioBuffer 截取，
 * 编码为 16-bit PCM WAV 后打包成单个 ZIP（store，不压缩）。
 *
 * 时间先钳制到 [0, 音频时长]，再换算为采样索引；片段为左闭右开区间
 * [startSample, endSample)，相邻章节共享边界时两侧换算出同一索引，
 * 既不重复也不漏采样。声道数与采样率沿用原音频。
 */

/** 半开采样区间 [startSample, endSample)。 */
export interface SampleRange {
  startSample: number;
  endSample: number;
}

/**
 * 章节起止时间 → 采样区间。先钳制到音频范围再换算索引；
 * 钳制后为零长度（越界 / 起止重合 / 倒置）时返回 null，表示该章不可导出。
 */
export function chapterToSampleRange(
  start: number,
  end: number,
  buffer: AudioBufferLike,
): SampleRange | null {
  const { length, sampleRate } = buffer;
  if (!(length > 0) || !(sampleRate > 0)) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const duration = length / sampleRate;
  const s = Math.min(Math.max(start, 0), duration);
  const e = Math.min(Math.max(end, 0), duration);
  const startSample = Math.min(Math.max(Math.round(s * sampleRate), 0), length);
  const endSample = Math.min(Math.max(Math.round(e * sampleRate), 0), length);
  if (endSample <= startSample) return null;
  return { startSample, endSample };
}

function writeAscii(out: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
}

/**
 * 把 buffer 的 [startSample, endSample) 区段编码为 16-bit PCM WAV。
 * 保留原声道数与采样率；浮点采样钳制到 [-1, 1]（NaN 按 0 处理），
 * 多声道按帧交错（L R L R …）。
 */
export function encodeWavPcm16(buffer: AudioBufferLike, range: SampleRange): Uint8Array {
  const channels = buffer.numberOfChannels;
  const sampleRate = Math.round(buffer.sampleRate);
  if (!(channels >= 1)) throw new Error('音频没有可用声道。');
  if (!(sampleRate > 0)) throw new Error('音频采样率无效。');
  const frames = range.endSample - range.startSample;
  if (!(frames > 0)) throw new Error('选区不包含任何采样。');
  const dataSize = frames * channels * 2;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);
  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt 块大小
  view.setUint16(20, 1, true); // PCM（无压缩）
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byteRate
  view.setUint16(32, channels * 2, true); // blockAlign
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii(out, 36, 'data');
  view.setUint32(40, dataSize, true);
  const data: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
  let o = 44;
  for (let i = range.startSample; i < range.endSample; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const v = data[ch][i];
      const clamped = Number.isNaN(v) ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
      view.setInt16(o, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true);
      o += 2;
    }
  }
  return out;
}

/** 文件名安全化：去掉文件系统保留字符与控制字符，折叠空白，去首尾点，限长。 */
export function sanitizeFileTitle(title: string): string {
  return title
    .replace(/[-\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim();
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * 有效章节（钳制后仍有采样的）按开始时间排序，逐个编码 WAV 并生成
 * 「序号-安全化标题.wav」文件名；序号宽度随总数对齐，重名时追加 -2 / -3…
 * 保证不重名。返回条目与被跳过的无效章节数。
 */
export function buildAudioPackEntries(
  chapters: Chapter[],
  buffer: AudioBufferLike,
): { entries: ZipEntry[]; skipped: number } {
  const sorted = [...chapters].sort((a, b) => a.start - b.start || a.end - b.end);
  const valid: { chapter: Chapter; range: SampleRange }[] = [];
  let skipped = 0;
  for (const c of sorted) {
    const range = chapterToSampleRange(c.start, c.end, buffer);
    if (range) valid.push({ chapter: c, range });
    else skipped++;
  }
  const width = Math.max(2, String(valid.length).length);
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  valid.forEach(({ chapter, range }, i) => {
    const seq = String(i + 1).padStart(width, '0');
    const title = sanitizeFileTitle(chapter.title) || `章节 ${i + 1}`;
    let name = `${seq}-${title}.wav`;
    for (let n = 2; used.has(name); n++) name = `${seq}-${title}-${n}.wav`;
    used.add(name);
    entries.push({ name, data: encodeWavPcm16(buffer, range) });
  });
  return { entries, skipped };
}

// ---- ZIP（store 方式，文件名 UTF-8）----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定时间戳，保证同样的输入产出同样的 ZIP 字节。 */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // 2024-01-01

/**
 * 把若干文件打成单个 ZIP（store 不压缩：WAV 本身已不可再压）。
 * 文件名以 UTF-8 写入并置 bit 11 标志。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error('文件数量超出 ZIP 上限。');
  const encoder = new TextEncoder();
  const names = entries.map((e) => encoder.encode(e.name));
  let localSize = 0;
  let cdSize = 0;
  for (let i = 0; i < entries.length; i++) {
    localSize += 30 + names[i].length + entries[i].data.length;
    cdSize += 46 + names[i].length;
  }
  const total = localSize + cdSize + 22;
  if (total > 0xffffffff) throw new Error('音频包超过 4GB，超出 ZIP 格式上限。');
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const central: { name: Uint8Array; crc: number; size: number; localOffset: number }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const name = names[i];
    const data = entries[i].data;
    const crc = crc32(data);
    central.push({ name, crc, size: data.length, localOffset: offset });
    view.setUint32(offset, 0x04034b50, true); // local file header
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 文件名
    view.setUint16(offset + 8, 0, true); // store
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, crc, true);
    view.setUint32(offset + 18, data.length, true); // compressed size
    view.setUint32(offset + 22, data.length, true); // uncompressed size
    view.setUint16(offset + 26, name.length, true);
    view.setUint16(offset + 28, 0, true); // extra length
    offset += 30;
    out.set(name, offset);
    offset += name.length;
    out.set(data, offset);
    offset += data.length;
  }

  const cdStart = offset;
  for (const rec of central) {
    view.setUint32(offset, 0x02014b50, true); // central directory header
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, rec.crc, true);
    view.setUint32(offset + 20, rec.size, true);
    view.setUint32(offset + 24, rec.size, true);
    view.setUint16(offset + 28, rec.name.length, true);
    // extra / comment / disk / attrs 全为 0
    view.setUint32(offset + 42, rec.localOffset, true);
    offset += 46;
    out.set(rec.name, offset);
    offset += rec.name.length;
  }

  view.setUint32(offset, 0x06054b50, true); // end of central directory
  view.setUint16(offset + 8, entries.length, true); // entries on this disk
  view.setUint16(offset + 10, entries.length, true); // total entries
  view.setUint32(offset + 12, offset - cdStart, true); // cd size
  view.setUint32(offset + 16, cdStart, true); // cd offset
  return out;
}

export interface ChapterAudioPack {
  /** ZIP 文件字节 */
  zip: Uint8Array;
  /** 包内文件名（按章节时间排序） */
  fileNames: string[];
  /** 因越界 / 零长度被跳过的章节数 */
  skipped: number;
}

/**
 * 导出主入口：任何一步失败都抛错（不产出半成品）；全部成功才返回 ZIP。
 * 调用方需传入「当前」章节与「当前」音频缓冲——两者必须来自同一次导入。
 */
export function buildChapterAudioPack(
  chapters: Chapter[],
  buffer: AudioBufferLike,
): ChapterAudioPack {
  if (!buffer || !(buffer.length > 0)) {
    throw new Error('尚未导入音频，无法导出章节音频包。');
  }
  if (chapters.length === 0) {
    throw new Error('当前没有章节，无法导出章节音频包。');
  }
  let entries: ZipEntry[];
  let skipped: number;
  try {
    ({ entries, skipped } = buildAudioPackEntries(chapters, buffer));
  } catch (err) {
    throw new Error(`章节音频编码失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (entries.length === 0) {
    throw new Error(
      `没有可导出的音频片段：${chapters.length} 个章节经时间钳制后都不在音频范围内或为零长度。`,
    );
  }
  let zip: Uint8Array;
  try {
    zip = buildZip(entries);
  } catch (err) {
    throw new Error(`音频包打包失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { zip, fileNames: entries.map((e) => e.name), skipped };
}
