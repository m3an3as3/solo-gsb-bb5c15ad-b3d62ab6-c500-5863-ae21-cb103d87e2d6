import type { AudioBufferLike, Chapter } from '../types';
import { MIN_CHAPTER_DURATION, sorted } from '../utils/chapterOps';

/** RMS analysis window: 100ms. */
export const RMS_WINDOW_SEC = 0.1;

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Per-window RMS (100ms) across ALL channels of an already-decoded buffer.
 * Combined RMS: sum of squares over every channel sample / total count.
 * Strided like computePeaks to keep per-window work bounded on long files.
 */
export function computeRmsWindows(
  buffer: AudioBufferLike,
  windowSec: number = RMS_WINDOW_SEC,
): Float32Array {
  const { sampleRate, length } = buffer;
  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const count = Math.max(1, Math.ceil(length / win));
  const rms = new Float32Array(count);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  for (let i = 0; i < count; i++) {
    const start = i * win;
    const end = Math.min(length, start + win);
    // stride to keep per-window work bounded on very long files
    const step = Math.max(1, Math.floor((end - start) / 1024));
    let sumSq = 0;
    let n = 0;
    for (const data of channels) {
      for (let s = start; s < end; s += step) {
        const v = data[s];
        sumSq += v * v;
        n++;
      }
    }
    rms[i] = n > 0 ? Math.sqrt(sumSq / n) : 0;
  }
  return rms;
}

/**
 * Merge consecutive sub-threshold windows into silence segments,
 * keeping only those at least `minSilenceSec` long.
 */
export function findSilenceSegments(
  rms: Float32Array,
  windowSec: number,
  thresholdLinear: number,
  minSilenceSec: number,
  duration: number,
): TimeRange[] {
  const segments: TimeRange[] = [];
  let runStart = -1;
  for (let i = 0; i <= rms.length; i++) {
    const silent = i < rms.length && rms[i] <= thresholdLinear;
    if (silent) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const start = runStart * windowSec;
      const end = Math.min(i * windowSec, duration);
      if (end - start >= minSilenceSec - 1e-9) {
        segments.push({ start, end });
      }
      runStart = -1;
    }
  }
  return segments;
}

/** Uncovered gaps between existing chapters (and the file edges). */
export function computeGaps(chapters: Chapter[], duration: number): TimeRange[] {
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const c of sorted(chapters)) {
    const start = Math.min(Math.max(c.start, 0), duration);
    const end = Math.min(Math.max(c.end, 0), duration);
    if (start > cursor) gaps.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration) gaps.push({ start: cursor, end: duration });
  return gaps;
}

/**
 * Candidate split boundaries: midpoints of silence segments that fall
 * inside uncovered gaps. Boundaries that would produce a chapter shorter
 * than `minChapterDuration` (against a gap edge or another kept boundary)
 * are filtered out.
 */
export function suggestSplitBoundaries(
  segments: TimeRange[],
  chapters: Chapter[],
  duration: number,
  minChapterDuration: number = MIN_CHAPTER_DURATION,
): number[] {
  const eps = 1e-9;
  const result: number[] = [];
  for (const gap of computeGaps(chapters, duration)) {
    const mids = segments
      .map((s) => (s.start + s.end) / 2)
      .filter((m) => m > gap.start + eps && m < gap.end - eps)
      .sort((a, b) => a - b);
    const kept: number[] = [];
    let last = gap.start;
    for (const m of mids) {
      if (m - last >= minChapterDuration - eps) {
        kept.push(m);
        last = m;
      }
    }
    // drop trailing boundaries that would leave a too-short tail chapter
    while (kept.length > 0 && gap.end - kept[kept.length - 1] < minChapterDuration - eps) {
      kept.pop();
    }
    result.push(...kept);
  }
  return result.sort((a, b) => a - b);
}

/**
 * Chapter ranges produced by applying the suggestions: every gap that
 * contains candidate boundaries is tiled into new chapters at those
 * points. Gaps without candidates and all existing chapters are left
 * untouched, so applying preserves current chapters and never overlaps.
 */
export function splitGapsAtBoundaries(
  chapters: Chapter[],
  boundaries: number[],
  duration: number,
  minChapterDuration: number = MIN_CHAPTER_DURATION,
): TimeRange[] {
  const eps = 1e-9;
  const cuts = [...boundaries].sort((a, b) => a - b);
  const ranges: TimeRange[] = [];
  for (const gap of computeGaps(chapters, duration)) {
    const gapCuts = cuts.filter((b) => b > gap.start + eps && b < gap.end - eps);
    if (gapCuts.length === 0) continue;
    // defensive re-filter: keep only cuts leaving every piece >= min duration
    const kept: number[] = [];
    let cursor = gap.start;
    for (const b of gapCuts) {
      if (b - cursor >= minChapterDuration - eps) {
        kept.push(b);
        cursor = b;
      }
    }
    while (kept.length > 0 && gap.end - kept[kept.length - 1] < minChapterDuration - eps) {
      kept.pop();
    }
    let prev = gap.start;
    for (const b of kept) {
      ranges.push({ start: prev, end: b });
      prev = b;
    }
    ranges.push({ start: prev, end: gap.end });
  }
  return ranges;
}
