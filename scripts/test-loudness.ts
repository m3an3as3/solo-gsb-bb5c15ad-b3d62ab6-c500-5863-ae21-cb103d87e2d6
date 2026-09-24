import {
  LOUDNESS_WINDOW_SEC,
  computeDbfsWindows,
  dbfsFromRms,
  evaluateAllChapters,
  evaluateChapterLoudness,
  findLoudnessSegments,
  type LoudnessThresholds,
} from '../src/audio/loudness';
import { toJSON } from '../src/utils/export';
import type { AudioBufferLike, Chapter } from '../src/types';

const T: LoudnessThresholds = { quietDb: -30, loudDb: -6 };
const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function near(actual: number, expected: number, msg: string, tol = 1e-3) {
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function noNaN(obj: unknown, msg: string) {
  const s = JSON.stringify(obj);
  ok(!/NaN/.test(s) && !/null/.test(s.replace(/"[a-zA-Z]+":null/g, '')), msg);
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

// 1s @1000Hz, window 0.2s -> 5 windows; first half silent, second half 0.5
function halfLoudBuffer(): AudioBufferLike {
  const data = new Float32Array(1000);
  data.fill(0.5, 500);
  return fakeBuffer([data], 1000);
}

// silence 0..0.6s, then steady 0.5 (keeps every 200ms window "clean")
function cleanBuffer(): AudioBufferLike {
  const data = new Float32Array(1000);
  data.fill(0.5, 600);
  return fakeBuffer([data], 1000);
}

// steady full-level 1s tone
function uniformBuffer(): AudioBufferLike {
  return fakeBuffer([new Float32Array(1000).fill(0.5)], 1000);
}

// --- dBFS windows: count, silence -> -Infinity (never NaN), partial windows ---
{
  const db = computeDbfsWindows(halfLoudBuffer(), LOUDNESS_WINDOW_SEC);
  ok(db.length === 5, 'dbfs window count (200ms)');
  ok(db[0] === -Infinity, 'silent window is -Infinity, not NaN');
  ok(Number.isFinite(db[2]), 'mixed window finite');
  near(db[2], 20 * Math.log10(Math.sqrt(0.125)), 'mixed window dBFS'); // -9.03
  near(db[4], 20 * Math.log10(0.5), 'loud window dBFS'); // -6.02
  ok(db.every((v) => !Number.isNaN(v)), 'no NaN in any window');
}

// --- dBFS combines multi-channel PCM ---
{
  const a = new Float32Array(1000).fill(0.6);
  const b = new Float32Array(1000).fill(0.8);
  const db = computeDbfsWindows(fakeBuffer([a, b], 1000), LOUDNESS_WINDOW_SEC);
  near(db[0], 20 * Math.log10(Math.sqrt(0.5)), 'multi-channel combined dBFS'); // -3.01
}

// --- exact-zero RMS helper stays finite ---
{
  const db = dbfsFromRms(new Float32Array([0, 1e-9, 1]));
  ok(db[0] === -Infinity && Number.isFinite(db[1]) && db[2] === 0, 'dbfsFromRms edge values');
}

// --- chapter over full silence: weighted mean is null, no NaN, status quiet ---
{
  const silent = fakeBuffer([new Float32Array(1000)], 1000);
  const db = computeDbfsWindows(silent, LOUDNESS_WINDOW_SEC);
  const q = evaluateChapterLoudness(mk('a', 0, 1), db, 0.2, 1, T);
  ok(q.allSilent === true, 'fully silent chapter flagged');
  ok(q.meanDbfs === null && q.minDbfs === null && q.maxDbfs === null, 'silent metrics null');
  near(q.rangeDb, 0, 'silent range 0');
  near(q.silentCoverage, 1, 'silent coverage 100%');
  near(q.quietCoverage, 1, 'silent time counted as quiet');
  near(q.analyzedDuration, 1, 'whole chapter analyzed');
  ok(q.status === 'quiet', 'silent chapter status quiet');
  near(q.firstIssueAt ?? NaN, 0, 'silent first issue at chapter start');
  noNaN(q, 'silent chapter has no NaN fields');
}

// --- cross-boundary window: overlap-weighted attribution, never double counted ---
{
  const db = computeDbfsWindows(uniformBuffer(), LOUDNESS_WINDOW_SEC);
  const q1 = evaluateChapterLoudness(mk('a', 0, 0.3), db, 0.2, 1, T);
  const q2 = evaluateChapterLoudness(mk('b', 0.3, 0.6), db, 0.2, 0.6, T);
  // window i=1 [0.2,0.4] contributes 0.1 to EACH side; mean is identical
  near(q1.analyzedDuration, 0.3, 'left chapter analyzed 0.3s');
  near(q2.analyzedDuration, 0.3, 'right chapter analyzed 0.3s');
  near(q1.meanDbfs ?? NaN, 20 * Math.log10(0.5), 'left overlap-weighted mean');
  near(q2.meanDbfs ?? NaN, 20 * Math.log10(0.5), 'right overlap-weighted mean');
}

// --- split file, two chapters aligned to the 200ms grid: metrics per side ---
{
  const db = computeDbfsWindows(cleanBuffer(), LOUDNESS_WINDOW_SEC);
  const q1 = evaluateChapterLoudness(mk('a', 0, 0.6), db, 0.2, 1, T);
  const q2 = evaluateChapterLoudness(mk('b', 0.6, 1), db, 0.2, 1, T);
  ok(q1.allSilent && q1.meanDbfs === null, 'first chapter silent');
  near(q2.meanDbfs ?? NaN, 20 * Math.log10(0.5), 'second chapter mean = 0.5 level');
  near(q2.minDbfs ?? NaN, 20 * Math.log10(0.5), 'second chapter min');
  near(q2.maxDbfs ?? NaN, 20 * Math.log10(0.5), 'second chapter max');
  near(q2.rangeDb, 0, 'steady chapter has zero dynamic range');
  ok(q2.status === 'ok', 'second chapter status ok at -6.02 vs -6 threshold');
  near(q2.silentCoverage, 0, 'no silent coverage on loud side');
  near(q2.analyzedDuration, 0.4, '0.4s of signal analyzed');
  ok(q2.firstIssueAt === null, 'no issue -> firstIssueAt null');
}

// --- strided scan guarantees: boundary-straddling window is split, not misattributed ---
{
  // halfLoud: 500..1000 are 0.5. Window [0.4,0.6] is the straddle window.
  const db = computeDbfsWindows(halfLoudBuffer(), LOUDNESS_WINDOW_SEC);
  const silent = evaluateChapterLoudness(mk('a', 0, 0.4), db, 0.2, 1, T);
  ok(silent.allSilent, 'chapter ending before the straddle window is fully silent');
  const straddle = evaluateChapterLoudness(mk('a', 0, 0.5), db, 0.2, 1, T);
  // the straddle window contributes at most its 0.1 overlap; mean stays finite
  ok(straddle.meanDbfs !== null && Number.isFinite(straddle.meanDbfs), 'straddle chapter finite');
  near(straddle.analyzedDuration, 0.5, 'straddle chapter analyzed 0.5s');
  ok(straddle.quietCoverage <= 0.5 + 1e-9, 'straddle quiet coverage bounded by chapter length');
}

// --- energy-weighted mean, range, statuses from a raw dBFS array ---
{
  const db = new Float32Array([-20, -10, -40]);
  const q = evaluateChapterLoudness(mk('a', 0, 0.6), db, 0.2, 0.6, T);
  const expectedMean = 10 * Math.log10((Math.pow(10, -2) + Math.pow(10, -1) + Math.pow(10, -4)) / 3);
  near(q.meanDbfs ?? NaN, expectedMean, 'energy-weighted mean dBFS'); // -14.35
  near(q.rangeDb, 30, 'range = max - min');
  ok(q.status === 'ok', 'mixed chapter ok');
  near(q.quietCoverage, 0.2, 'one quiet window weighted');
  near(q.firstIssueAt ?? NaN, 0.4, 'first issue at quiet window start');

  const loud = new Float32Array([-4, -5]);
  const ql = evaluateChapterLoudness(mk('a', 0, 0.4), loud, 0.2, 0.4, T);
  ok(ql.status === 'loud', 'loud chapter status');
  near(ql.loudCoverage, 0.4, 'all time counted loud');
  near(ql.meanDbfs ?? NaN, 10 * Math.log10((Math.pow(10, -0.4) + Math.pow(10, -0.5)) / 2), 'loud mean');

  const quiet = new Float32Array([-40, -45]);
  const qq = evaluateChapterLoudness(mk('a', 0, 0.4), quiet, 0.2, 0.4, T);
  ok(qq.status === 'quiet', 'quiet chapter status');
}

// --- extremely short / degenerate chapters: unknown, no NaN ---
{
  const db = computeDbfsWindows(halfLoudBuffer(), LOUDNESS_WINDOW_SEC);
  for (const [a, b] of [
    [5, 5],
    [0, 0],
    [-1, -1],
  ] as const) {
    const q = evaluateChapterLoudness(mk('z', a, b), db, 0.2, 1, T);
    ok(q.status === 'unknown', `zero-length chapter [${a},${b}] unknown`);
    near(q.analyzedDuration, 0, 'zero analyzed duration');
    noNaN(q, 'zero-length chapter has no NaN');
  }
  // 0.05s chapter inside one window: overlap-weighted, still valid
  const tdb = computeDbfsWindows(uniformBuffer(), LOUDNESS_WINDOW_SEC);
  const tiny = evaluateChapterLoudness(mk('t', 0.5, 0.55), tdb, 0.2, 1, T);
  near(tiny.analyzedDuration, 0.05, 'tiny chapter analyzed 0.05s');
  near(tiny.meanDbfs ?? NaN, 20 * Math.log10(0.5), 'tiny chapter uses overlap level');
  noNaN(tiny, 'tiny chapter has no NaN');
}

// --- segments: consecutive windows merged, silence treated as quiet, clamped to duration ---
{
  const db = new Float32Array([-Infinity, -40, -5, -4, -40]);
  const segs = findLoudnessSegments(db, 0.2, 1, T);
  ok(segs.length === 3, 'three merged segments');
  ok(
    JSON.stringify(segs) ===
      JSON.stringify([
        { kind: 'quiet', start: 0, end: 0.4 },
        { kind: 'loud', start: 0.4, end: 0.8 },
        { kind: 'quiet', start: 0.8, end: 1 },
      ]),
    'segment ranges and kinds',
  );
}

// --- partial last window: segment end clamped to real duration ---
{
  const data = new Float32Array(1100).fill(0.5); // 1.1s -> 6 windows, last only 100 samples
  const db = computeDbfsWindows(fakeBuffer([data], 1000), LOUDNESS_WINDOW_SEC);
  ok(db.length === 6, 'partial last window exists');
  near(db[5], 20 * Math.log10(0.5), 'partial window computed from real samples');
  const q = evaluateChapterLoudness(mk('a', 1, 1.1), db, 0.2, 1.1, T);
  near(q.analyzedDuration, 0.1, 'chapter in partial window analyzed 0.1s');
  near(q.meanDbfs ?? NaN, 20 * Math.log10(0.5), 'partial window mean');
  const loudT: LoudnessThresholds = { quietDb: -60, loudDb: -10 };
  const segs = findLoudnessSegments(db, 0.2, 1.1, loudT);
  ok(segs.length === 1 && Math.abs(segs[0].end - 1.1) < 1e-9, 'last segment end clamped to 1.1s');
}

// --- threshold change only re-classifies; same cached dBFS array ---
{
  const db = new Float32Array([-40, -40, -5, -5, -40]);
  const segs1 = findLoudnessSegments(db, 0.2, 1, T);
  ok(segs1.length === 3, 'default thresholds flag segments');
  const relaxed: LoudnessThresholds = { quietDb: -50, loudDb: 0 };
  const segs2 = findLoudnessSegments(db, 0.2, 1, relaxed);
  ok(segs2.length === 0, 'relaxed thresholds clear segments');
  const q = evaluateChapterLoudness(mk('a', 0, 1), db, 0.2, 1, relaxed);
  ok(q.status === 'ok', 'chapter reclassified ok with relaxed thresholds');
  ok(db[0] === -40, 'cached dBFS array untouched by re-classification');
}

// --- evaluateAllChapters keyed by id ---
{
  const db = computeDbfsWindows(cleanBuffer(), LOUDNESS_WINDOW_SEC);
  const map = evaluateAllChapters([mk('a', 0, 0.6), mk('b', 0.6, 1)], db, 0.2, 1, T);
  ok(map.size === 2, 'all chapters evaluated');
  ok(map.get('a')!.allSilent && map.get('b')!.status === 'ok', 'per-id metrics');
}

// --- JSON export carries QC, -Infinity -> null, never NaN ---
{
  const db = new Float32Array(10).fill(-Infinity);
  const chapters = [mk('a', 0, 1), mk('b', 1, 1)];
  const map = evaluateAllChapters(chapters, db, 0.2, 2, T);
  const json = toJSON(chapters, { loudness: map, thresholds: T });
  ok(!json.includes('NaN'), 'exported JSON contains no NaN');
  ok(!json.includes('Infinity'), 'exported JSON contains no Infinity');
  const parsed = JSON.parse(json);
  ok(parsed.qualityControl.windowSeconds === 0.2, 'QC header present');
  ok(parsed.qualityControl.quietThresholdDb === -30, 'quiet threshold exported');
  ok(parsed.qualityControl.loudThresholdDb === -6, 'loud threshold exported');
  const qc0 = parsed.chapters[0].qualityControl;
  ok(qc0.status === 'quiet' && qc0.meanDbfs === null, 'silent chapter mean null in JSON');
  ok(qc0.allSilent === true && qc0.dynamicRangeDb === 0, 'silent flags exported');
  const qc1 = parsed.chapters[1].qualityControl;
  ok(qc1.status === 'unknown', 'degenerate chapter exported as unknown');
}

// --- JSON without QC stays backward compatible ---
{
  const parsed = JSON.parse(toJSON([mk('a', 0, 1)]));
  ok(parsed.version === 1 && parsed.chapters[0].index === 1 && parsed.qualityControl === undefined,
    'QC omitted when analysis unavailable');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
