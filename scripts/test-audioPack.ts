import type { AudioBufferLike, Chapter } from '../src/types';
import {
  buildAudioPackEntries,
  buildChapterAudioPack,
  buildZip,
  chapterToSampleRange,
  crc32,
  encodeWavPcm16,
  sanitizeFileTitle,
  type ZipEntry,
} from '../src/utils/audioPack';

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

function chapter(id: string, title: string, start: number, end: number): Chapter {
  return { id, title, start, end };
}

// ---- crc32 ----
{
  const enc = new TextEncoder();
  eq(crc32(enc.encode('123456789')), 0xcbf43926, 'crc32 known vector');
  eq(crc32(new Uint8Array(0)), 0, 'crc32 empty input');
  eq(crc32(enc.encode('hello')), 0x3610a686, 'crc32 hello vector');
}

// ---- chapterToSampleRange：钳制 + 左闭右开 ----
{
  const buf = makeBuffer([new Float32Array(48000)], 48000); // 1s
  eq(chapterToSampleRange(0.25, 0.5, buf), { startSample: 12000, endSample: 24000 }, 'seconds to samples');
  eq(chapterToSampleRange(-1, 2, buf), { startSample: 0, endSample: 48000 }, 'clamp both ends to audio range');
  eq(chapterToSampleRange(-1, 0.5, buf), { startSample: 0, endSample: 24000 }, 'negative start clamps to 0');
  eq(chapterToSampleRange(0.5, 99, buf), { startSample: 24000, endSample: 48000 }, 'end beyond duration clamps to length');
  eq(chapterToSampleRange(0.5, 0.5, buf), null, 'zero-length chapter yields no range');
  eq(chapterToSampleRange(0.7, 0.3, buf), null, 'inverted chapter yields no range');
  eq(chapterToSampleRange(2, 3, buf), null, 'fully out-of-range chapter yields no range');
  eq(chapterToSampleRange(NaN, 0.5, buf), null, 'NaN start rejected');
  eq(chapterToSampleRange(0.5, Infinity, buf), null, 'Infinite end rejected');

  // 相邻章节共享边界：左闭右开保证不重复、不漏采样
  const a = chapterToSampleRange(0, 0.5, buf)!;
  const b = chapterToSampleRange(0.5, 1, buf)!;
  ok(a.endSample === b.startSample, 'adjacent chapters map boundary to the same sample index');
  ok(a.startSample === 0 && a.endSample + (b.endSample - b.startSample) === 48000,
    'adjacent ranges partition the audio with no gap or overlap');

  // 非常规采样率下的取整一致性
  const buf10 = makeBuffer([new Float32Array(10)], 10);
  eq(chapterToSampleRange(0.2, 0.7, buf10), { startSample: 2, endSample: 7 }, 'exact sample boundaries at odd rate');
  const x = chapterToSampleRange(0, 0.75, buf10)!;
  const y = chapterToSampleRange(0.75, 1, buf10)!;
  ok(x.endSample === y.startSample && y.endSample === 10, 'rounding at half samples still tiles exactly');

  eq(chapterToSampleRange(0, 1, makeBuffer([new Float32Array(0)], 48000)), null, 'empty buffer rejected');
}

// ---- encodeWavPcm16 ----
function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}
{
  const mono = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5, 0, 0.123, -0.123]);
  const buf = makeBuffer([mono], 8000);
  const range = chapterToSampleRange(0, 10 / 8000, buf)!;
  eq(range, { startSample: 0, endSample: 10 }, 'range covers all 10 frames');
  const wav = encodeWavPcm16(buf, range);
  eq(wav.length, 44 + 20, 'wav total size = 44-byte header + PCM payload');
  eq(asciiAt(wav, 0, 4), 'RIFF', 'RIFF magic');
  const dv = new DataView(wav.buffer);
  eq(dv.getUint32(4, true), 36 + 20, 'RIFF chunk size');
  eq(asciiAt(wav, 8, 4), 'WAVE', 'WAVE magic');
  eq(asciiAt(wav, 12, 4), 'fmt ', 'fmt chunk');
  eq(dv.getUint32(16, true), 16, 'PCM fmt size');
  eq(dv.getUint16(20, true), 1, 'PCM format tag');
  eq(dv.getUint16(22, true), 1, 'mono channels preserved');
  eq(dv.getUint32(24, true), 8000, 'sample rate preserved');
  eq(dv.getUint32(28, true), 16000, 'byte rate = rate * channels * 2');
  eq(dv.getUint16(32, true), 2, 'block align = channels * 2');
  eq(dv.getUint16(34, true), 16, '16 bits per sample');
  eq(asciiAt(wav, 36, 4), 'data', 'data chunk');
  eq(dv.getUint32(40, true), 20, 'data size');
  const int16 = (i: number) => dv.getInt16(44 + i * 2, true);
  eq(int16(0), 0, 'zero stays zero');
  eq(int16(1), Math.round(0.5 * 32767), 'positive half scale');
  eq(int16(2), Math.round(-0.5 * 32768), 'negative half scale');
  eq(int16(3), 32767, 'positive full scale');
  eq(int16(4), -32768, 'negative full scale');
  eq(int16(5), 32767, 'above 1 clips to +32767');
  eq(int16(6), -32768, 'below -1 clips to -32768');
  ok(Math.abs(int16(8) - Math.round(0.123 * 32767)) === 0, 'positive small value quantized');
  ok(Math.abs(int16(9) - Math.round(-0.123 * 32768)) === 0, 'negative small value quantized');

  // NaN → 0（解码数据异常时确定行为）
  const nanBuf = makeBuffer([new Float32Array([NaN, 0, -0])], 48000);
  const nanWav = encodeWavPcm16(nanBuf, { startSample: 0, endSample: 3 });
  const ndv = new DataView(nanWav.buffer);
  eq([ndv.getInt16(44, true), ndv.getInt16(46, true), ndv.getInt16(48, true)], [0, 0, 0], 'NaN maps to 0');

  // 立体声交错 + 声道/采样率保留
  const l = new Float32Array([0.25, -0.25, 0.75]);
  const r = new Float32Array([0.5, -0.5, -0.75]);
  const stereo = makeBuffer([l, r], 44100);
  const swav = encodeWavPcm16(stereo, { startSample: 0, endSample: 3 });
  const sdv = new DataView(swav.buffer);
  eq(sdv.getUint16(22, true), 2, 'stereo channels preserved');
  eq(sdv.getUint32(24, true), 44100, 'stereo sample rate preserved');
  eq(sdv.getUint32(40, true), 3 * 2 * 2, 'stereo data size');
  eq(
    [0, 1, 2, 3, 4, 5].map((i) => sdv.getInt16(44 + i * 2, true)),
    [
      Math.round(0.25 * 32767),
      Math.round(0.5 * 32767),
      Math.round(-0.25 * 32768),
      Math.round(-0.5 * 32768),
      Math.round(0.75 * 32767),
      Math.round(-0.75 * 32768),
    ],
    'stereo samples interleaved L R L R …',
  );

  // 半开区间截取：ramp [0..9) 取 [2,5) 恰为第 2、3、4 个采样
  const ramp = new Float32Array(10).map((_, i) => i / 10);
  const rbuf = makeBuffer([ramp], 48000);
  const rwav = encodeWavPcm16(rbuf, { startSample: 2, endSample: 5 });
  const rdv = new DataView(rwav.buffer);
  eq(rdv.getUint32(40, true), 3 * 2, 'sliced payload contains exactly 3 frames');
  eq(
    [0, 1, 2].map((i) => rdv.getInt16(44 + i * 2, true)),
    [Math.round(0.2 * 32767), Math.round(0.3 * 32767), Math.round(0.4 * 32767)],
    'slice follows [start, end) half-open interval',
  );

  throws(() => encodeWavPcm16(buf, { startSample: 5, endSample: 5 }), '采样', 'empty range encoding throws');
}

// ---- sanitizeFileTitle ----
{
  eq(sanitizeFileTitle('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j', 'unsafe filesystem chars replaced');
  eq(sanitizeFileTitle('  hello   world  '), 'hello world', 'whitespace collapsed and trimmed');
  eq(sanitizeFileTitle('tab\there\nnewline'), 'tab here newline', 'control chars sanitized');
  eq(sanitizeFileTitle('...'), '', 'dots-only title becomes empty (caller falls back)');
  eq(sanitizeFileTitle('.hidden.'), 'hidden', 'leading/trailing dots stripped');
  eq(sanitizeFileTitle('正常标题 01'), '正常标题 01', 'unicode title kept');
  ok(sanitizeFileTitle('x'.repeat(100)).length <= 60, 'title length capped at 60');
  eq(sanitizeFileTitle(''), '', 'empty stays empty');
}

// ---- buildAudioPackEntries：排序 / 序号 / 重名 / 跳过 ----
{
  const mono = new Float32Array(48000);
  for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((i / 48000) * 440 * 2 * Math.PI) * 0.5;
  const buf = makeBuffer([mono], 48000);
  const chapters = [
    chapter('c', 'second', 0.5, 0.75),
    chapter('a', 'intro', 0, 0.5),
    chapter('d', '', 0.75, 1),
    chapter('b', 'bad/name', 0.25, 0.5),
    chapter('e', 'out of range', 2, 3),
    chapter('f', 'zero', 0.5, 0.5),
  ];
  const { entries, skipped } = buildAudioPackEntries(chapters, buf);
  eq(skipped, 2, 'out-of-range and zero-length chapters counted as skipped');
  eq(
    entries.map((e) => e.name),
    ['01-intro.wav', '02-bad name.wav', '03-second.wav', '04-章节 4.wav'],
    'entries sorted by time with zero-padded sequence and safe names',
  );
  entries.forEach((e) => {
    ok(e.data instanceof Uint8Array && e.data.length > 44, `${e.name} encoded as WAV bytes`);
  });

  // 重名标题不重名
  const dup = buildAudioPackEntries(
    [
      chapter('1', 'same', 0, 0.25),
      chapter('2', 'same', 0.25, 0.5),
      chapter('3', 'same', 0.5, 0.75),
    ],
    buf,
  ).entries.map((e) => e.name);
  eq(new Set(dup).size, dup.length, 'duplicate titles still produce unique filenames');
  ok(dup.every((n) => /^\d\d-same(-\d+)?\.wav$/.test(n)), 'sequence prefix keeps all names unique');

  // 总数超过 100 时序号宽度为 3 位（字典序仍然有序）
  const many = Array.from({ length: 120 }, (_, i) =>
    chapter(`ch${i}`, 'x', i / 120, (i + 1) / 120),
  );
  const manyNames = buildAudioPackEntries(many, buf).entries.map((e) => e.name);
  eq(manyNames[0], '001-x.wav', 'sequence width aligned to total count (first)');
  eq(manyNames[119], '120-x.wav', 'sequence width aligned to total count (last)');
  eq([...manyNames].sort()[0], '001-x.wav', 'three-digit names sort lexicographically in order');
}

// ---- buildZip：结构与往返解析 ----
function readZip(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  if (view.getUint32(eocd, true) !== 0x06054b50) throw new Error('bad EOCD signature');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) throw new Error('bad central signature');
    const crc = view.getUint32(off + 16, true);
    const size = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));
    if (view.getUint32(localOff, true) !== 0x04034b50) throw new Error('bad local signature');
    const localNameLen = view.getUint16(localOff + 26, true);
    const extraLen = view.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + localNameLen + extraLen;
    const data = zip.slice(dataOff, dataOff + size);
    if (crc32(data) !== crc) throw new Error(`crc mismatch in ${name}`);
    out.push({ name, data });
    off += 46 + nameLen;
  }
  return out;
}

{
  const empty = buildZip([]);
  eq(empty.length, 22, 'empty zip is just EOCD');
  const ev = new DataView(empty.buffer);
  eq(ev.getUint32(0, true), 0x06054b50, 'EOCD signature for empty zip');
  eq(ev.getUint16(8, true), 0, 'zero entries in EOCD');

  const enc = new TextEncoder();
  const a: ZipEntry = { name: 'a.txt', data: enc.encode('hello') };
  const b: ZipEntry = { name: 'dir/b.txt', data: enc.encode('world!!') };
  const zip = buildZip([a, b]);
  const v = new DataView(zip.buffer);
  eq(v.getUint32(0, true), 0x04034b50, 'first local header signature');
  eq(v.getUint16(6, true), 0x0800, 'utf-8 flag set');
  eq(v.getUint16(8, true), 0, 'store compression method');
  eq(v.getUint32(14, true), crc32(a.data), 'crc in local header');
  eq(v.getUint32(18, true), a.data.length, 'size fields equal for store');

  const parsed = readZip(zip);
  eq(parsed.map((e) => e.name), ['a.txt', 'dir/b.txt'], 'zip roundtrip names');
  ok(new TextDecoder().decode(parsed[0].data) === 'hello', 'zip roundtrip first payload');
  ok(new TextDecoder().decode(parsed[1].data) === 'world!!', 'zip roundtrip second payload');
  ok(crc32(parsed[1].data) === crc32(b.data), 'crc verified after roundtrip');

  // UTF-8 中文名
  const cn = readZip(buildZip([{ name: '01-章节.wav', data: new Uint8Array([1, 2, 3]) }]));
  eq(cn[0].name, '01-章节.wav', 'utf-8 filename roundtrips');
  eq(Array.from(cn[0].data), [1, 2, 3], 'binary payload preserved');

  // 确定性输出
  const z1 = buildZip([a, b]);
  const z2 = buildZip([a, b]);
  ok(
    z1.length === z2.length && z1.every((byte, i) => byte === z2[i]),
    'same inputs produce byte-identical zips',
  );
}

// ---- WAV 数据解析辅助：直接验证导出内容 ----
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
function quantize(v: number): number {
  const clamped = Number.isNaN(v) ? 0 : v < -1 ? -1 : v > 1 ? 1 : v;
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
}

// ---- buildChapterAudioPack：完整往返 ----
{
  const rate = 48000;
  const mono = new Float32Array(rate);
  for (let i = 0; i < rate; i++) mono[i] = (i / rate) * 1.2 - 0.6; // 含越界值
  const buf = makeBuffer([mono], rate);

  // 相邻两章切完拼接，应与整段一次编码的 PCM 逐采样一致（不重不漏）
  const full = encodeWavPcm16(buf, { startSample: 0, endSample: rate });
  const fullSamples = parseWav(full).samples;

  const pack = buildChapterAudioPack(
    [
      chapter('b', 'second half', 0.5, 1),
      chapter('a', 'first half', 0, 0.5),
      chapter('z', 'ignored chapter', 5, 6),
    ],
    buf,
  );
  eq(pack.skipped, 1, 'pack reports skipped count');
  eq(pack.fileNames, ['01-first half.wav', '02-second half.wav'], 'pack names sorted by time');
  const files = readZip(pack.zip);
  eq(files.map((f) => f.name), pack.fileNames, 'zip entry order matches fileNames');
  const w1 = parseWav(files[0].data);
  const w2 = parseWav(files[1].data);
  eq([w1.channels, w1.sampleRate, w1.bits], [1, rate, 16], 'first wav keeps mono / 48k / 16-bit');
  eq(w1.frames + w2.frames, rate, 'adjacent chapters cover exactly the full sample count');
  const concat = [...w1.samples, ...w2.samples];
  eq(concat, fullSamples, 'adjacent PCM concatenates to the whole-file encoding with no dup/gap');
  eq(w1.samples[0], quantize(mono[0]), 'first exported sample equals source');
  eq(w2.samples[w2.samples.length - 1], quantize(mono[rate - 1]), 'last exported sample equals source');

  // 立体声多声道往返
  const l = new Float32Array(rate).map((_, i) => (i % 100) / 200);
  const r = new Float32Array(rate).map((_, i) => -((i % 70) / 140));
  const sbuf = makeBuffer([l, r], rate);
  const spack = buildChapterAudioPack(
    [chapter('s', 'stereo slice', 0.1, 0.4)],
    sbuf,
  );
  const sw = parseWav(readZip(spack.zip)[0].data);
  const start = Math.round(0.1 * rate);
  const end = Math.round(0.4 * rate);
  eq([sw.channels, sw.sampleRate, sw.frames], [2, rate, end - start], 'stereo header and frame count');
  const expected: number[] = [];
  for (let i = start; i < end; i++) expected.push(quantize(l[i]), quantize(r[i]));
  eq(sw.samples, expected, 'stereo interleaved samples match source slice exactly');

  // 失败路径：只提示原因，不返回任何可下载产物
  throws(() => buildChapterAudioPack([], buf), '没有章节', 'no chapters throws');
  throws(
    () => buildChapterAudioPack([chapter('z', 'z', 5, 6)], buf),
    '没有可导出',
    'all chapters invalid throws with reason',
  );
  throws(
    () => buildChapterAudioPack([chapter('a', 'a', 0, 0.5)], makeBuffer([new Float32Array(0)], rate)),
    '尚未导入音频',
    'missing buffer throws',
  );
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all audioPack tests passed');
}
