import type { AudioBufferLike } from '../src/types';
import {
  MIN_SAMPLE_SEC,
  SEARCH_RATE,
  coarseCandidates,
  frameEnergies,
  mergeHits,
  mixdownDecimate,
  normalizedCorrelation,
  repeatSourceFromBuffer,
  searchRepeats,
} from '../src/audio/repeatSearch';

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

/** Deterministic pseudo-random noise in ±amp (LCG). */
function makeNoise(len: number, seed: number, amp: number): Float32Array {
  const out = new Float32Array(len);
  let s = seed >>> 0;
  for (let i = 0; i < len; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

// ---- mixdownDecimate：多声道混合 + 块平均降采样 ----
{
  const buf = makeBuffer(
    [new Float32Array(800).fill(0.5), new Float32Array(800).fill(-0.1)],
    8000,
  );
  const mono = mixdownDecimate(repeatSourceFromBuffer(buf), SEARCH_RATE);
  eq(mono.length, 100, 'decimate 8000 -> 1000 keeps 100 samples');
  approx(mono[0], 0.2, 1e-6, 'channels averaged to mono');
  approx(mono[99], 0.2, 1e-6, 'last sample averaged too');
}

// ---- frameEnergies：帧能量 = 帧内均方 ----
{
  const mono = new Float32Array(2000).fill(0.5);
  const e = frameEnergies(mono, SEARCH_RATE, 0.02);
  eq(e.length, 100, '2000 samples @20ms frames -> 100 frames');
  approx(e[0], 0.25, 1e-6, 'energy of constant 0.5 is 0.25');
}

// ---- normalizedCorrelation：音量 / 直流不变性 ----
{
  const a = makeNoise(1000, 7, 0.4);
  const scaled = new Float32Array(1000);
  const negated = new Float32Array(1000);
  const offset = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) {
    scaled[i] = a[i] * 0.05;
    negated[i] = -a[i];
    offset[i] = a[i] + 0.3; // DC offset
  }
  const mono = new Float32Array(4000);
  mono.set(a, 0);
  mono.set(scaled, 1000);
  mono.set(negated, 2000);
  mono.set(offset, 3000);
  approx(normalizedCorrelation(mono, 0, 0, 1000), 1, 1e-6, 'self correlation is 1');
  approx(normalizedCorrelation(mono, 0, 1000, 1000), 1, 1e-4, 'volume change keeps score 1');
  approx(normalizedCorrelation(mono, 0, 2000, 1000), -1, 1e-4, 'inverted signal scores -1');
  approx(normalizedCorrelation(mono, 0, 3000, 1000), 1, 1e-4, 'DC offset keeps score 1');
  const other = makeNoise(1000, 99, 0.4);
  const mono2 = new Float32Array(2000);
  mono2.set(a, 0);
  mono2.set(other, 1000);
  ok(
    Math.abs(normalizedCorrelation(mono2, 0, 1000, 1000)) < 0.1,
    'independent noise scores near 0',
  );
}

// ---- coarseCandidates：找到能量包络相似窗口，排除样本自身 ----
{
  // 1000 帧能量包络：样本在 [100, 150)，其缩放副本在 [600, 650)
  const energy = new Float32Array(1000).fill(0.01);
  for (let i = 100; i < 150; i++) energy[i] = 0.2 + 0.15 * Math.sin((i - 100) / 5);
  for (let i = 600; i < 650; i++) energy[i] = (0.2 + 0.15 * Math.sin((i - 600) / 5)) * 0.3;
  const cands = coarseCandidates(energy, 100, 50, 0.45, 500);
  ok(cands.length > 0, 'coarse screen finds candidates');
  const best = cands[0];
  ok(Math.abs(best.offset - 600) <= 1, `best candidate at the copy (got ${best.offset})`);
  ok(
    cands.every((c) => c.offset >= 150 || c.offset + 50 <= 100),
    'candidates overlapping the sample are excluded',
  );
  ok(
    cands.every((c, i) => i === 0 || cands[i - 1].score >= c.score),
    'candidates sorted by score desc',
  );
  // 平坦包络回退：网格候选，仍排除样本自身
  const flat = new Float32Array(400).fill(0.1);
  const grid = coarseCandidates(flat, 100, 40, 0.45, 500);
  ok(grid.length > 0, 'flat profile falls back to grid candidates');
  ok(
    grid.every((c) => c.offset >= 140 || c.offset + 40 <= 100),
    'grid fallback also excludes the sample',
  );
  eq(coarseCandidates(new Float32Array(50), 0, 50).length, 0, 'sample covering whole file: no candidates');
}

// ---- mergeHits：同一片段的邻近命中合并，保留最高分 ----
{
  const merged = mergeHits(
    [
      { start: 30.0, end: 35.0, score: 0.9 },
      { start: 30.1, end: 35.1, score: 0.95 }, // 与上一条同一片段
      { start: 45.0, end: 50.0, score: 0.8 },
    ],
    5,
  );
  eq(merged.length, 2, 'nearby hits merged into one');
  approx(merged[0].start, 30.1, 1e-9, 'best-scoring alignment kept');
  approx(merged[0].score, 0.95, 1e-9, 'best score kept');
  ok(merged[0].score >= merged[1].score, 'merged hits sorted by score desc');
  const capped = mergeHits(
    Array.from({ length: 10 }, (_, i) => ({ start: i * 10, end: i * 10 + 5, score: 0.9 })),
    5,
    3,
  );
  eq(capped.length, 3, 'hit count capped');
}

// ---- searchRepeats 主场景：两处不同音量的重复片段 ----
const RATE = 8000;
const DUR = 60; // seconds
function buildScenario(): AudioBufferLike {
  const base = makeNoise(RATE * DUR, 1, 0.02); // 安静底噪
  // 样本：5s 包络调制噪声（能量包络有结构）
  const sampleLen = RATE * 5;
  const sample = makeNoise(sampleLen, 2, 0.5);
  for (let i = 0; i < sampleLen; i++) {
    sample[i] *= 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (RATE * 1.3)));
  }
  base.set(sample, RATE * 10); // 样本位于 10..15s
  const copy1 = new Float32Array(sampleLen);
  const copy2 = new Float32Array(sampleLen);
  for (let i = 0; i < sampleLen; i++) {
    copy1[i] = sample[i] * 0.4; // 音量变小
    copy2[i] = sample[i] * 1.5; // 音量变大
  }
  base.set(copy1, RATE * 30); // 重复 1：30..35s
  base.set(copy2, RATE * 45); // 重复 2：45..50s
  return makeBuffer([base], RATE);
}

{
  const hits = searchRepeats(repeatSourceFromBuffer(buildScenario()), { start: 10, end: 15 });
  eq(hits.length, 2, 'finds both re-recorded segments');
  ok(hits[0].score >= hits[1].score, 'hits sorted by similarity desc');
  const starts = hits.map((h) => h.start).sort((a, b) => a - b);
  approx(starts[0], 30, 0.1, 'first repeat located at 30s');
  approx(starts[1], 45, 0.1, 'second repeat located at 45s');
  ok(hits.every((h) => h.score > 0.95), `volume changes do not lower scores (${hits.map((h) => h.score.toFixed(3))})`);
  ok(
    hits.every((h) => h.end <= 10 || h.start >= 15),
    'sample itself and overlaps excluded',
  );
  for (const h of hits) approx(h.end - h.start, 5, 0.05, 'hit span matches sample length');
}

// ---- 立体声：多声道混合后仍能找到 ----
{
  const mono = buildScenario().getChannelData(0);
  const other = makeNoise(RATE * DUR, 3, 0.01);
  const stereo = makeBuffer([mono, other], RATE);
  const hits = searchRepeats(repeatSourceFromBuffer(stereo), { start: 10, end: 15 });
  eq(hits.length, 2, 'stereo mixdown still finds both repeats');
}

// ---- 与样本重叠的副本被排除 ----
{
  const base = makeNoise(RATE * DUR, 1, 0.02);
  const sampleLen = RATE * 5;
  const sample = makeNoise(sampleLen, 2, 0.5);
  for (let i = 0; i < sampleLen; i++) {
    sample[i] *= 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (RATE * 1.3)));
  }
  base.set(sample, RATE * 10); // 样本 10..15s
  base.set(sample, RATE * 13); // 重叠副本 13..18s（与样本相交）
  const hits = searchRepeats(repeatSourceFromBuffer(makeBuffer([base], RATE)), {
    start: 10,
    end: 15,
  });
  eq(hits.length, 0, 'copy overlapping the sample is excluded');
}

// ---- 无重复：随机音频不报命中 ----
{
  const buf = makeBuffer([makeNoise(RATE * DUR, 5, 0.2)], RATE);
  const hits = searchRepeats(repeatSourceFromBuffer(buf), { start: 10, end: 15 });
  eq(hits.length, 0, 'no repeats in unrelated noise');
}

// ---- 样本靠近文件末尾 ----
{
  const base = makeNoise(RATE * DUR, 1, 0.02);
  const sampleLen = RATE * 5;
  const sample = makeNoise(sampleLen, 2, 0.5);
  for (let i = 0; i < sampleLen; i++) {
    sample[i] *= 0.3 + 0.7 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (RATE * 1.3)));
  }
  base.set(sample, RATE * 55); // 样本 55..60s（文件末尾）
  base.set(sample, RATE * 20); // 副本 20..25s
  const hits = searchRepeats(repeatSourceFromBuffer(makeBuffer([base], RATE)), {
    start: 55,
    end: 60,
  });
  eq(hits.length, 1, 'sample at file end still searches');
  approx(hits[0].start, 20, 0.1, 'repeat located at 20s');
}

// ---- 非法输入 ----
{
  const buf = repeatSourceFromBuffer(makeBuffer([makeNoise(RATE * 10, 1, 0.2)], RATE));
  throws(() => searchRepeats(buf, { start: 5, end: 5 }), '无效', 'inverted/zero sample rejected');
  throws(() => searchRepeats(buf, { start: NaN, end: 5 }), '无效', 'NaN sample rejected');
  throws(
    () => searchRepeats(buf, { start: 1, end: 1 + MIN_SAMPLE_SEC / 2 }),
    '太短',
    'too-short sample rejected',
  );
  const silent = repeatSourceFromBuffer(makeBuffer([new Float32Array(RATE * 10)], RATE));
  throws(() => searchRepeats(silent, { start: 1, end: 6 }), '静音', 'silent sample rejected');
  throws(
    () => searchRepeats(buf, { start: 20, end: 25 }),
    '超出',
    'sample beyond audio rejected',
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall repeat-search tests passed');
}
