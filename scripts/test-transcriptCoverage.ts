import {
  clipTranscriptCues,
  computeTranscriptCoverage,
  mergeCueIntervals,
  parseTranscriptVtt,
  type RawTranscriptCue,
} from '../src/utils/transcriptCoverage';
import type { Chapter } from '../src/types';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    console.log(`ok ${msg}`);
  } else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}${a === e ? '' : ` — expected ${e}, got ${a}`}`);
}
function approx(actual: number, expected: number, msg: string, tol = 1e-6) {
  check(Math.abs(actual - expected) <= tol, `${msg} — expected ~${expected}, got ${actual}`);
}
function expectThrow(fn: () => unknown, msg: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg} — expected throw`);
  } catch {
    console.log(`ok ${msg}`);
  }
}

const mk = (id: string, start: number, end: number, title = id): Chapter => ({ id, title, start, end });
const raw = (row: number, start: number, end: number, text = `c${row}`): RawTranscriptCue => ({
  row,
  start,
  end,
  text,
});

// ---- parsing ----
{
  const { cues, skipped } = parseTranscriptVtt(
    [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      '你好',
      '',
      'NOTE ignore',
      'me',
      '',
      '00:00:05,500 --> 00:00:10.000 align:start',
      '<i>斜体</i> 文本',
      '',
      'bad',
      'soon --> later',
      'broken cue',
      '',
      '00:00:20.000 --> 00:00:20.000',
      'zero length',
    ].join('\n'),
  );
  eq(cues.length, 2, 'parser keeps two good cues');
  eq([cues[0].start, cues[0].end, cues[0].text], [1, 3, '你好'], 'cue fields parsed');
  eq([cues[1].start, cues[1].end, cues[1].text], [5.5, 10, '斜体 文本'], 'comma fraction, tags stripped');
  eq(skipped, 2, 'bad timing + zero-length cue skipped and counted');
  check(cues[0].row > 0, 'source row retained');
}
expectThrow(() => parseTranscriptVtt('   '), 'empty transcript throws');
expectThrow(() => parseTranscriptVtt('JSON\n{"chapters":[]}'), 'non-WebVTT throws');
{
  const r = parseTranscriptVtt('\uFEFFWEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA');
  eq(r.cues.length, 1, 'BOM-prefixed WebVTT accepted');
}

// ---- clipping out-of-range cues ----
{
  const clipped = clipTranscriptCues(
    [raw(1, -5, 10), raw(2, 95, 130), raw(3, 120, 140), raw(4, 20, 30)],
    100,
  );
  eq(
    clipped.map((c) => [c.start, c.end]),
    [
      [0, 10],
      [20, 30],
      [95, 100],
    ],
    'negative start / past-end end clipped, fully-outside cue dropped, result sorted',
  );
  eq(
    clipped.map((c) => c.id),
    ['cue-0', 'cue-1', 'cue-2'],
    'stable ids assigned in sorted order',
  );
}
{
  // a cue clipped to a zero sliver is dropped
  const clipped = clipTranscriptCues([raw(1, 100, 110), raw(2, -5, 0)], 100);
  eq(clipped.length, 0, 'sliver-only cues dropped');
}

// ---- overlap merging ----
{
  const merged = mergeCueIntervals([
    { start: 2, end: 4 },
    { start: 3, end: 5 }, // overlaps first
    { start: 5, end: 6 }, // touches -> merged
    { start: 10, end: 12 }, // disjoint
    { start: 10.5, end: 11 }, // contained
  ]);
  eq(
    merged,
    [
      { start: 2, end: 6 },
      { start: 10, end: 12 },
    ],
    'overlapping/touching cues merged, same second counted once',
  );
}

// ---- per-chapter intersection ----
{
  // two chapters back-to-back; one cue straddles the boundary, plus a cue
  // entirely in ch1 and an overlapping duplicate cue in ch2
  const chapters = [mk('a', 0, 10, '开场'), mk('b', 10, 20, '正文')];
  const clipped = clipTranscriptCues(
    [
      raw(1, 2, 6), // inside a
      raw(2, 8, 14), // straddles 10 -> split 2s to a, 4s to b
      raw(3, 12, 16), // inside b, overlaps raw2 on [12,14]
      raw(4, 19, 25), // straddles end-of-audio; clip first
    ],
    20,
  );
  const cov = computeTranscriptCoverage(chapters, clipped);
  const ca = cov.byChapter.get('a')!;
  const cb = cov.byChapter.get('b')!;

  approx(ca.coveredSeconds, 6, 'ch1 union covers 2-6 + 8-10 = 6s');
  approx(ca.ratio, 0.6, 'ch1 ratio 60%');
  approx(cb.coveredSeconds, 7, 'ch2 union covers 10-16 (merged) + 19-20 = 7s');
  approx(cb.ratio, 0.7, 'ch2 ratio 70%');
  approx(cov.totalCoveredSeconds, 13, 'whole-file union 2-6,8-16,19-20 = 13s');

  // cross-boundary cue listed in BOTH chapters, with clipped intersection times
  const straddleA = ca.cues.find((o) => o.cue.row === 2)!;
  const straddleB = cb.cues.find((o) => o.cue.row === 2)!;
  eq([straddleA.start, straddleA.end], [8, 10], 'straddling cue intersects ch1 by part only');
  eq([straddleB.start, straddleB.end], [10, 14], 'same cue intersects ch2 by part only');

  // overlap of raw2/raw3 in ch2 listed twice but seconds counted once
  eq(
    cb.cues.map((o) => o.cue.row),
    [2, 3, 4],
    'all intersecting cues listed for ch2 in overlap order',
  );
  eq(cb.cues.map((o) => [o.start, o.end]), [[10, 14], [12, 16], [19, 20]], 'ch2 cue fragments clipped to chapter');
}

// ---- uncovered / fully covered / cueless cases ----
{
  const chapters = [mk('a', 0, 10), mk('b', 10, 20), mk('c', 20, 24)];
  const clipped = clipTranscriptCues([raw(1, 0, 20)], 24);
  const cov = computeTranscriptCoverage(chapters, clipped);
  approx(cov.byChapter.get('a')!.coveredSeconds, 10, 'full chapter covered');
  approx(cov.byChapter.get('a')!.ratio, 1, 'ratio caps at 1');
  approx(cov.byChapter.get('b')!.coveredSeconds, 10, 'cross-boundary cue covers ch2 fully too');
  approx(cov.byChapter.get('c')!.coveredSeconds, 0, 'chapter with no cues -> 0');
  eq(cov.byChapter.get('c')!.cues, [], 'no intersecting cues listed');
  approx(cov.totalCoveredSeconds, 20, 'union ignores chapters beyond cues');
}

// ---- boundary-touching fragments are real ----
{
  // cue ends exactly on a chapter boundary: zero-width intersection with
  // the next chapter must not be listed (and never counted)
  const chapters = [mk('a', 0, 10), mk('b', 10, 20)];
  const clipped = clipTranscriptCues([raw(1, 5, 10)], 20);
  const cov = computeTranscriptCoverage(chapters, clipped);
  eq(cov.byChapter.get('a')!.cues.map((o) => o.cue.row), [1], 'cue touching boundary listed in ch1');
  eq(cov.byChapter.get('b')!.cues, [], 'zero-width touch not listed in ch2');
  approx(cov.byChapter.get('b')!.coveredSeconds, 0, 'touch contributes no seconds');
}

// ---- instant recompute: chapters change, same cues ----
{
  const clipped = clipTranscriptCues([raw(1, 0, 10)], 20);
  const before = computeTranscriptCoverage([mk('a', 0, 5)], clipped);
  const after = computeTranscriptCoverage([mk('a', 0, 8), mk('b', 8, 12)], clipped);
  approx(before.byChapter.get('a')!.coveredSeconds, 5, 'before boundary edit');
  approx(after.byChapter.get('a')!.coveredSeconds, 8, 'edited chapter re-covered');
  approx(after.byChapter.get('b')!.coveredSeconds, 2, 'new chapter gets intersecting part');
}

// ---- gaps between chapters are not attributed to anyone ----
{
  const chapters = [mk('a', 0, 5), mk('b', 15, 20)]; // gap 5-15
  const clipped = clipTranscriptCues([raw(1, 0, 20)], 20);
  const cov = computeTranscriptCoverage(chapters, clipped);
  approx(cov.byChapter.get('a')!.coveredSeconds, 5, 'gap-free ch1');
  approx(cov.byChapter.get('b')!.coveredSeconds, 5, 'gap-free ch2');
  approx(cov.totalCoveredSeconds, 20, 'union still spans the gap');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
