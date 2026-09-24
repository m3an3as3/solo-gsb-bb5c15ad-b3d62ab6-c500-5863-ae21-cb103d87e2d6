import type { Chapter } from '../types';
import { clamp } from './time';
import { snapToValue } from './snap';

export const MIN_CHAPTER_DURATION = 0.2;

export { snapToValue };

/** Chapters sorted by start time (does not mutate input). */
export function sorted(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.start - b.start);
}

/**
 * Neighbor boundaries for a chapter: the end of the previous chapter and
 * the start of the next one. Used to prevent overlap.
 */
export function neighborBounds(
  chapters: Chapter[],
  id: string,
  duration: number,
): { prevEnd: number; nextStart: number } {
  const list = sorted(chapters).filter((c) => c.id !== id);
  const self = chapters.find((c) => c.id === id);
  if (!self) return { prevEnd: 0, nextStart: duration };
  let prevEnd = 0;
  let nextStart = duration;
  for (const c of list) {
    if (c.end <= self.start + 1e-9 && c.end > prevEnd) prevEnd = c.end;
    if (c.start >= self.end - 1e-9 && c.start < nextStart) nextStart = c.start;
  }
  return { prevEnd, nextStart };
}

/** All snap targets: file edges plus every other chapter's edges. */
export function snapTargets(chapters: Chapter[], excludeId: string, duration: number): number[] {
  const targets = [0, duration];
  for (const c of chapters) {
    if (c.id === excludeId) continue;
    targets.push(c.start, c.end);
  }
  return targets;
}

/** Snap the closer edge of a chapter to nearby targets (used by move/resize). */

/**
 * Move a whole chapter, keeping its length. Clamped between neighbors
 * (no overlap) and snapped to nearby boundaries.
 */
export function moveChapter(
  chapters: Chapter[],
  id: string,
  desiredStart: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const self = chapters.find((c) => c.id === id);
  if (!self) return null;
  const len = self.end - self.start;
  const { prevEnd, nextStart } = neighborBounds(chapters, id, duration);
  let start = clamp(desiredStart, prevEnd, nextStart - len);
  const targets = snapTargets(chapters, id, duration);
  // snap either edge, prefer the closer one; ignore edges that didn't snap
  const snappedStart = snapToValue(start, targets, snapThreshold);
  const snappedEndRaw = snapToValue(start + len, targets, snapThreshold);
  const startSnapped = snappedStart !== start;
  const endSnapped = snappedEndRaw !== start + len;
  if (startSnapped || endSnapped) {
    const snappedEnd = snappedEndRaw - len;
    const dStart = startSnapped ? Math.abs(snappedStart - start) : Infinity;
    const dEnd = endSnapped ? Math.abs(snappedEnd - start) : Infinity;
    start = dStart <= dEnd ? snappedStart : snappedEnd;
  }
  start = clamp(start, prevEnd, nextStart - len);
  return { start, end: start + len };
}

/**
 * Resize one edge of a chapter. Clamped between neighbors and the minimum
 * duration, snapped to nearby boundaries.
 */
export function resizeChapter(
  chapters: Chapter[],
  id: string,
  edge: 'start' | 'end',
  desired: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const self = chapters.find((c) => c.id === id);
  if (!self) return null;
  const { prevEnd, nextStart } = neighborBounds(chapters, id, duration);
  const targets = snapTargets(chapters, id, duration);
  const snapped = snapToValue(desired, targets, snapThreshold);

  if (edge === 'start') {
    const start = clamp(snapped, prevEnd, self.end - MIN_CHAPTER_DURATION);
    return { start, end: self.end };
  }
  const end = clamp(snapped, self.start + MIN_CHAPTER_DURATION, nextStart);
  return { start: self.start, end };
}

/**
 * Create a chapter from a drag range. Shrinks/clamps into the enclosing
 * gap so the result never overlaps existing chapters. Returns null if the
 * available gap is too small.
 */
export function createChapterInGap(
  chapters: Chapter[],
  a: number,
  b: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const targets = snapTargets(chapters, '__none__', duration);
  let start = snapToValue(lo, targets, snapThreshold);
  let end = snapToValue(hi, targets, snapThreshold);
  // clamp into the enclosing gap
  for (const c of sorted(chapters)) {
    if (c.end <= start + 1e-9) continue;
    if (c.start >= end - 1e-9) continue;
    // overlaps c: shrink away from it
    if (c.start <= start && c.end >= end) return null; // fully covered
    if (c.end > start && c.end <= end) start = c.end;
    else if (c.start >= start && c.start < end) end = c.start;
  }
  start = clamp(start, 0, duration);
  end = clamp(end, 0, duration);
  if (end - start < MIN_CHAPTER_DURATION) return null;
  return { start, end };
}

/** Find a free gap of the preferred length at/after a time point. */
export function findFreeGap(
  chapters: Chapter[],
  at: number,
  preferredLen: number,
  duration: number,
): { start: number; end: number } | null {
  const list = sorted(chapters);
  let cursor = Math.max(0, at);
  for (const c of list) {
    if (c.end <= cursor) continue;
    if (c.start >= cursor + preferredLen - 1e-9) {
      return { start: cursor, end: cursor + preferredLen };
    }
    cursor = c.end;
  }
  if (cursor + preferredLen <= duration + 1e-9) {
    return { start: cursor, end: Math.min(cursor + preferredLen, duration) };
  }
  // try a shorter fit in the last gap
  if (duration - cursor >= MIN_CHAPTER_DURATION) {
    return { start: cursor, end: duration };
  }
  return null;
}
