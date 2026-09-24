import {
  parseVttTimestamp,
  parseWebVTT,
  parseJSONChapters,
  parseChapterFile,
  buildImportPreview,
  applyImportedChapters,
} from '../src/utils/importChapters';
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
function expectThrow(fn: () => unknown, msg: string) {
  try {
    fn();
    failures++;
    console.error(`FAIL ${msg} — expected throw`);
  } catch {
    console.log(`ok ${msg}`);
  }
}

const D = 100;
const mk = (id: string, start: number, end: number, title = id): Chapter => ({ id, title, start, end });

// ---- timestamp parsing ----
eq(parseVttTimestamp('00:00:01.500'), 1.5, 'vtt timestamp basic');
eq(parseVttTimestamp('01:02:03'), 3723, 'vtt timestamp hms');
eq(parseVttTimestamp('00:01:02,25'), 62.25, 'vtt comma fraction 2 digits');
eq(parseVttTimestamp('99:59:59.999'), 359999.999, 'vtt large hours');
check(parseVttTimestamp('00:60:00') === null, 'vtt minutes >= 60 rejected');
check(parseVttTimestamp('00:00:60') === null, 'vtt seconds >= 60 rejected');
check(parseVttTimestamp('1:2') === null, 'vtt missing fields rejected');
check(parseVttTimestamp('garbage') === null, 'vtt garbage rejected');

// ---- WebVTT parsing ----
{
  const vtt = [
    'WEBVTT - My Show',
    '',
    'NOTE a comment',
    'spanning',
    'two lines',
    '',
    '1',
    '00:00:00.000 --> 00:00:10.000',
    'Intro',
    '',
    '00:00:10,500 --> 00:01:00.000 align:start',
    '<b>Big</b> Topic &amp; more',
    '',
    'STYLE',
    '::cue { color: red }',
    '',
    'bad-cue',
    'soon --> later',
    'Broken',
  ].join('\n');
  const r = parseWebVTT(vtt);
  eq(r.format, 'vtt', 'webvtt format tag');
  eq(r.entries.length, 3, 'webvtt 3 cues (NOTE/STYLE skipped)');
  eq([r.entries[0].start, r.entries[0].end], [0, 10], 'webvtt cue 1 times');
  eq(r.entries[0].title, 'Intro', 'webvtt cue 1 title');
  eq([r.entries[1].start, r.entries[1].end], [10.5, 60], 'webvtt comma + cue settings tolerated');
  eq(r.entries[1].title, 'Big Topic & more', 'webvtt tags/entities stripped');
  check(r.entries[2].status === undefined && !!r.entries[2].error, 'webvtt bad timing flagged');
}
{
  const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:15.000\nA\n\n00:00:20.000 --> 00:00:25.000\nB';
  const r = parseChapterFile('\uFEFF' + vtt);
  eq(r.format, 'vtt', 'BOM-prefixed webvtt detected');
  eq(r.entries.length, 2, 'BOM webvtt cues parsed');
}

// ---- JSON parsing ----
{
  const text = JSON.stringify({
    version: 1,
    qualityControl: { quietThresholdDb: -30, loudThresholdDb: -6 },
    chapters: [
      { id: 'x1', index: 1, title: 'A', start: 0, end: 10, duration: 10, qualityControl: {} },
      { id: 'x2', index: 2, title: 'B', start: '20.5', end: 30 },
      { id: 'x3', title: 'C', start: 'oops', end: 40 },
    ],
  });
  const r = parseJSONChapters(text);
  eq(r.entries.length, 3, 'json 3 rows');
  eq([r.entries[0].start, r.entries[0].end], [0, 10], 'json numeric times');
  eq(r.entries[1].start, 20.5, 'json string number accepted');
  check(!!r.entries[2].error, 'json bad start flagged');
}
{
  const r = parseChapterFile(JSON.stringify([{ title: 'A', start: 1, end: 2 }]));
  eq(r.format, 'json', 'bare array treated as json');
  eq(r.entries.length, 1, 'bare array one row');
}
expectThrow(() => parseChapterFile('{not json'), 'malformed file throws');
expectThrow(() => parseChapterFile('{"foo":1}'), 'json without chapters throws');
expectThrow(() => parseChapterFile('   '), 'empty file throws');

// ---- preview: statuses ----
{
  const parsed = parseWebVTT([
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:05.000', // valid (empty title ok)
    '',
    '00:00:10.000 --> 00:00:20.000', // overlaps existing [12,18]
    'hits existing',
    '',
    '00:00:30.000 --> 00:01:50.000', // end > duration 100
    'too long',
    '',
    '00:00:40.000 --> 00:00:40.100', // shorter than 0.2s
    'tiny',
    '',
    '00:00:50.000 --> 00:00:45.000', // end < start
    'reversed',
    '',
    '00:00:03.000 --> 00:00:08.000', // overlaps earlier valid cue
    'hits imported',
  ].join('\n'));
  const preview = buildImportPreview(parsed, [mk('e', 12, 18)], D);
  const statuses = preview.entries.map((e) => e.status);
  eq(statuses, ['valid', 'overlap', 'out-of-bounds', 'invalid', 'invalid', 'overlap'], 'preview statuses');
  eq(preview.counts, { total: 6, valid: 1, invalid: 2, outOfBounds: 1, overlap: 2 }, 'preview counts');
  check(preview.entries[0].reasons.some((r) => r.includes('标题为空')), 'empty title is a soft note, still valid');
}
{
  // cue entirely after audio end -> out of bounds
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 120, end: 130 }]));
  const preview = buildImportPreview(parsed, [], D);
  eq(preview.entries[0].status, 'out-of-bounds', 'start beyond duration -> out-of-bounds');
}
{
  // touching boundaries (end == next start) are NOT overlap
  const parsed = parseJSONChapters(
    JSON.stringify([
      { title: 'A', start: 10, end: 20 },
      { title: 'B', start: 20, end: 30 },
    ]),
  );
  const preview = buildImportPreview(parsed, [mk('e', 0, 10)], D);
  check(preview.entries.every((e) => e.status === 'valid'), 'edge-touching cues are valid');
}

// ---- apply: ids rebuilt, sorted, non-overlapping, titles numbered ----
{
  const parsed = parseJSONChapters(
    JSON.stringify([
      { id: 'should-not-survive', title: 'Later', start: 30, end: 40 },
      { id: 'also-not', title: '', start: 0, end: 5 },
      { id: 'bad', title: 'Bad', start: 90, end: 140 },
    ]),
  );
  const preview = buildImportPreview(parsed, [mk('keep', 10, 20, 'Existing')], D);
  eq(preview.counts.valid, 2, 'two valid rows for apply');
  const before = [mk('keep', 10, 20, 'Existing')];
  const merged = applyImportedChapters(preview, before, D);
  eq(merged.length, 3, 'apply keeps existing + adds valid');
  eq(
    merged.map((c) => [c.start, c.end]),
    [
      [0, 5],
      [10, 20],
      [30, 40],
    ],
    'applied result sorted',
  );
  check(merged[1].id === 'keep', 'existing id preserved');
  check(merged[0].id !== 'also-not' && merged[2].id !== 'should-not-survive', 'imported ids rebuilt');
  eq(merged[0].title, '章节 1', 'empty title numbered by sorted position');
  check(before.length === 1 && before[0].id === 'keep', 'apply does not mutate input');
}

// ---- apply failure: no partial write (throws, caller discards) ----
{
  // forge a preview whose "valid" rows actually overlap existing, simulating
  // stale/hand-crafted previews — the final guard must throw
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 0, end: 50 }]));
  let preview = buildImportPreview(parsed, [], D);
  preview = {
    ...preview,
    entries: preview.entries.map((e) => ({ ...e, status: 'valid' as const, reasons: [] })),
  };
  const before = [mk('keep', 10, 20)];
  expectThrow(() => applyImportedChapters(preview, before, D), 'overlapping apply throws');
  eq(before, [mk('keep', 10, 20)], 'nothing written on failure');
}
{
  // out-of-bounds forged valid row -> throws
  const parsed = parseJSONChapters(JSON.stringify([{ title: 'A', start: 90, end: 140 }]));
  let preview = buildImportPreview(parsed, [], D);
  preview = { ...preview, entries: preview.entries.map((e) => ({ ...e, status: 'valid' as const, reasons: [] })) };
  expectThrow(() => applyImportedChapters(preview, [], D), 'out-of-bounds apply throws');
}

// ---- re-import of this tool's export round-trips ----
{
  const exported = JSON.stringify({
    version: 1,
    chapters: [
      { id: 'a', index: 1, title: '一', start: 0, end: 12.345, duration: 12.345 },
      { id: 'b', index: 2, title: '二', start: 12.345, end: 60, duration: 47.655 },
    ],
  }, null, 2);
  const preview = buildImportPreview(parseChapterFile(exported), [], 60);
  check(preview.entries.every((e) => e.status === 'valid'), 'own JSON export all valid');
  const merged = applyImportedChapters(preview, [], 60);
  eq(
    merged.map((c) => `${c.title}:${c.start}-${c.end}`),
    ['一:0-12.345', '二:12.345-60'],
    'round-trip preserves timing/title',
  );
  check(new Set(merged.map((c) => c.id)).size === 2, 'imported ids unique');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
