import {
  moveChapter,
  resizeChapter,
  createChapterInGap,
  findFreeGap,
  MIN_CHAPTER_DURATION,
} from '../src/utils/chapterOps';
import type { Chapter } from '../src/types';

const D = 100; // duration
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

// --- move: clamped by next chapter (no overlap) ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = moveChapter(cs, 'a', 25, D, 0)!; // would overlap b
  eq(r, { start: 20, end: 30 }, 'move clamped at next.start');
}
// --- move: clamped by prev chapter ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = moveChapter(cs, 'b', 5, D, 0)!;
  eq(r, { start: 20, end: 30 }, 'move clamped at prev.end');
}
// --- move: snaps to neighbor boundary within threshold ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = moveChapter(cs, 'b', 20.3, D, 0.5)!; // start 20.3 near a.end=20
  eq(r, { start: 20, end: 30 }, 'move snaps start to prev end');
}
// --- move: snaps end to file duration ---
{
  const cs = [mk('a', 10, 20)];
  const r = moveChapter(cs, 'a', 89.7, D, 0.5)!; // end 99.7 near 100
  eq(r, { start: 90, end: 100 }, 'move snaps end to duration');
}
// --- resize: cannot cross neighbor ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = resizeChapter(cs, 'a', 'end', 50, D, 0)!;
  eq(r, { start: 10, end: 30 }, 'resize end clamped at next.start');
}
// --- resize: min duration enforced ---
{
  const cs = [mk('a', 10, 20)];
  const r = resizeChapter(cs, 'a', 'start', 19.99, D, 0)!;
  eq(r, { start: 20 - MIN_CHAPTER_DURATION, end: 20 }, 'resize start min duration');
}
// --- resize: snaps to neighbor edge ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = resizeChapter(cs, 'b', 'start', 20.2, D, 0.5)!;
  eq(r, { start: 20, end: 40 }, 'resize start snaps to prev end');
}
// --- create in gap: shrinks to gap ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = createChapterInGap(cs, 15, 35, D, 0)!;
  eq(r, { start: 20, end: 30 }, 'create shrinks into gap');
}
// --- create fully covered -> null ---
{
  const cs = [mk('a', 10, 50)];
  eq(createChapterInGap(cs, 20, 30, D, 0), null, 'create fully covered null');
}
// --- create too small -> null ---
{
  eq(createChapterInGap([], 10, 10.1, D, 0), null, 'create tiny null');
}
// --- create snaps edges to neighbors ---
{
  const cs = [mk('a', 10, 20)];
  const r = createChapterInGap(cs, 20.2, 50, D, 0.5)!;
  eq(r, { start: 20, end: 50 }, 'create snaps start to neighbor end');
}
// --- findFreeGap skips occupied space ---
{
  const cs = [mk('a', 0, 5), mk('b', 5, 12)];
  eq(findFreeGap(cs, 2, 5, D), { start: 12, end: 17 }, 'free gap after chapters');
}
// --- findFreeGap fits before next chapter ---
{
  const cs = [mk('a', 10, 20)];
  eq(findFreeGap(cs, 0, 5, D), { start: 0, end: 5 }, 'free gap at start');
}
// --- no room at all ---
{
  const cs = [mk('a', 0, 100)];
  eq(findFreeGap(cs, 0, 5, D), null, 'no room null');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
