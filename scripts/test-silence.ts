import {
  RMS_WINDOW_SEC,
  computeGaps,
  computeRmsWindows,
  findSilenceSegments,
  splitGapsAtBoundaries,
  suggestSplitBoundaries,
} from '../src/audio/silence';
import { MIN_CHAPTER_DURATION } from '../src/utils/chapterOps';
import type { AudioBufferLike, Chapter } from '../src/types';

const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
let failures = 0;
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
function near(actual: number, expected: number, msg: string, tol = 1e-4) {
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function nearRanges(
  actual: { start: number; end: number }[],
  expected: { start: number; end: number }[],
  msg: string,
) {
  const ok =
    actual.length === expected.length &&
    actual.every(
      (r, i) =>
        Math.abs(r.start - expected[i].start) < 1e-9 &&
        Math.abs(r.end - expected[i].end) < 1e-9,
    );
  if (!ok) {
    failures++;
    console.error(`FAIL ${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok ${msg}`);
  }
}

function fakeBuffer(channelData: Float32Array[], sampleRate: number): AudioBufferLike {
  return {
    duration: channelData[0].length / sampleRate,
    length: channelData[0].length,
    sampleRate,
    numberOfChannels: channelData.length,
    getChannelData: (c) => channelData[c],
  };
}

// --- RMS: 100ms windows, mono ---
{
  // 1s @ 1000Hz -> 10 windows of 100 samples; first half silence, then 0.5
  const data = new Float32Array(1000);
  data.fill(0.5, 500);
  const rms = computeRmsWindows(fakeBuffer([data], 1000), RMS_WINDOW_SEC);
  eq(rms.length, 10, 'rms window count (100ms)');
  near(rms[0], 0, 'rms silent window');
  near(rms[9], 0.5, 'rms loud window');
}
// --- RMS: multi-channel combined ---
{
  const a = new Float32Array(1000).fill(0.6);
  const b = new Float32Array(1000).fill(0.8);
  const rms = computeRmsWindows(fakeBuffer([a, b], 1000), RMS_WINDOW_SEC);
  near(rms[0], Math.sqrt((0.36 + 0.64) / 2), 'rms combines channels');
}
// --- silence segments: merge consecutive, filter by min duration ---
{
  // windows: 0,0,0 | 1 | 0,0 | 1 | 0   (window = 0.1s, duration 0.8s)
  const rms = new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]);
  const segs = findSilenceSegments(rms, 0.1, 0.5, 0.2, 0.8);
  nearRanges(segs, [{ start: 0, end: 0.3 }, { start: 0.4, end: 0.6 }], 'segments merged, short run dropped');
}
// --- silence segment runs to end of file ---
{
  const rms = new Float32Array([1, 0, 0]);
  const segs = findSilenceSegments(rms, 0.1, 0.5, 0.2, 0.3);
  nearRanges(segs, [{ start: 0.1, end: 0.3 }], 'segment clamped to duration at EOF');
}
// --- gaps between chapters ---
{
  const cs = [mk('a', 2, 4), mk('b', 6, 8)];
  eq(computeGaps(cs, 10), [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 10 }], 'gaps');
}
// --- suggestion: midpoint of silence in empty file ---
{
  eq(suggestSplitBoundaries([{ start: 4, end: 6 }], [], 10), [5], 'midpoint candidate');
}
// --- suggestion: midpoint covered by a chapter is discarded ---
{
  const cs = [mk('a', 4.5, 5.5)];
  eq(suggestSplitBoundaries([{ start: 4, end: 6 }], cs, 10), [], 'covered midpoint discarded');
}
// --- suggestion: too close to gap edge -> filtered (< 0.2s chapter) ---
{
  const cs = [mk('a', 0, 4.9)];
  eq(suggestSplitBoundaries([{ start: 4, end: 6 }], cs, 10), [], 'edge-too-close filtered');
}
// --- suggestion: two midpoints closer than min duration -> keep first ---
{
  const segs = [{ start: 5.0, end: 5.2 }, { start: 5.15, end: 5.35 }]; // mids 5.1, 5.25
  eq(suggestSplitBoundaries(segs, [], 10), [5.1], 'close pair keeps one');
}
// --- suggestion: tail chapter would be too short -> dropped ---
{
  const cs = [mk('a', 9.95, 10)];
  eq(suggestSplitBoundaries([{ start: 9.8, end: 10 }], cs, 10), [], 'short tail filtered');
}
// --- suggestion: multiple gaps ---
{
  const cs = [mk('a', 4, 6)];
  const segs = [{ start: 1.8, end: 2.2 }, { start: 7.8, end: 8.2 }]; // mids 2, 8
  eq(suggestSplitBoundaries(segs, cs, 10), [2, 8], 'candidates in separate gaps');
}
// --- apply: gap tiled at boundaries, existing chapters untouched ---
{
  const cs = [mk('a', 0, 2)];
  const ranges = splitGapsAtBoundaries(cs, [5], 10);
  eq(ranges, [{ start: 2, end: 5 }, { start: 5, end: 10 }], 'apply tiles gap');
}
// --- apply: no candidates -> nothing created ---
{
  eq(splitGapsAtBoundaries([], [], 10), [], 'apply empty');
  eq(splitGapsAtBoundaries([mk('a', 0, 10)], [5], 10), [], 'apply fully covered');
}
// --- apply: multiple gaps, result never overlaps and respects min duration ---
{
  const cs = [mk('a', 4, 6)];
  const ranges = splitGapsAtBoundaries(cs, [2, 8], 10);
  eq(
    ranges,
    [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 6, end: 8 }, { start: 8, end: 10 }],
    'apply multiple gaps',
  );
  const all = [...cs, ...ranges.map((r, i) => mk(`n${i}`, r.start, r.end))].sort(
    (x, y) => x.start - y.start,
  );
  for (let i = 1; i < all.length; i++) {
    if (all[i].start < all[i - 1].end - 1e-9) {
      failures++;
      console.error(`FAIL overlap between ${all[i - 1].id} and ${all[i].id}`);
    }
  }
  for (const r of ranges) {
    if (r.end - r.start < MIN_CHAPTER_DURATION - 1e-9) {
      failures++;
      console.error(`FAIL applied chapter shorter than min: ${JSON.stringify(r)}`);
    }
  }
  console.log('ok apply result non-overlapping and >= min duration');
}
// --- round trip: suggestions -> apply yields only valid pieces ---
{
  const cs = [mk('a', 3, 4)];
  const segs = [{ start: 0.9, end: 1.1 }, { start: 6.9, end: 7.1 }, { start: 8.9, end: 9.1 }];
  const bounds = suggestSplitBoundaries(segs, cs, 10);
  eq(bounds, [1, 7, 9], 'round trip candidates');
  const ranges = splitGapsAtBoundaries(cs, bounds, 10);
  eq(
    ranges,
    [{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 4, end: 7 }, { start: 7, end: 9 }, { start: 9, end: 10 }],
    'round trip apply',
  );
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
