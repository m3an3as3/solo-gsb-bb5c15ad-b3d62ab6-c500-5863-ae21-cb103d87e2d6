/**
 * Transcript coverage check: load a local WebVTT TRANSCRIPT (not chapter
 * import — cues never become chapters) and measure, for every chapter, how
 * many seconds are covered by transcript text.
 *
 * Measurement pipeline (all pure functions, no DOM / React):
 *   1. parse WebVTT cues (reuses the chapter-import parser) — parse failures
 *      and zero-length cues are skipped and counted;
 *   2. clip every cue to [0, duration] — out-of-range portions are cut, cues
 *      fully outside the audio are dropped;
 *   3. merge overlapping cue intervals — the same second is counted at most
 *      once even when cues overlap;
 *   4. intersect the merged union with each chapter: a cue that straddles a
 *      chapter boundary contributes ONLY its intersecting part to each side,
 *      it is never attributed to a single chapter as a whole.
 *
 * Covered by scripts/test-transcriptCoverage.ts.
 */
import type { Chapter } from '../types';
import { parseWebVTT } from './importChapters';

const EPS = 1e-6;

/** A cue straight out of the parser (before clipping); seconds, source row. */
export interface RawTranscriptCue {
  /** 1-based line number of the cue timing line in the source file */
  row: number;
  start: number;
  end: number;
  text: string;
}

/** A clipped, display-ready cue with a stable id. */
export interface TranscriptCue {
  id: string;
  row: number;
  /** clipped to [0, duration] */
  start: number;
  end: number;
  text: string;
}

export interface Interval {
  start: number;
  end: number;
}

/** A cue's intersecting fragment within one chapter. */
export interface CueOverlap {
  cue: TranscriptCue;
  /** max(cue.start, chapter.start) */
  start: number;
  /** min(cue.end, chapter.end) */
  end: number;
}

export interface ChapterCoverage {
  /** seconds of the chapter covered by at least one cue */
  coveredSeconds: number;
  /** coveredSeconds / chapter duration; 0..1; 0 for empty chapters */
  ratio: number;
  /** cues intersecting the chapter, ordered by overlap start */
  cues: CueOverlap[];
}

export interface TranscriptCoverage {
  byChapter: Map<string, ChapterCoverage>;
  /** seconds of the whole audio covered by at least one cue (union) */
  totalCoveredSeconds: number;
}

/**
 * Parse a local WebVTT file as a transcript. Only the WEBVTT format is
 * accepted (chapter JSON goes through the separate chapter-import flow).
 * Rows whose timing cannot be parsed, as well as zero / negative-length
 * cues, are skipped and counted in `skipped` instead of failing the file.
 */
export function parseTranscriptVtt(text: string): {
  cues: RawTranscriptCue[];
  skipped: number;
} {
  if (text.trim() === '') throw new Error('文件为空。');
  if (!/^(?:\uFEFF)?WEBVTT/.test(text.trimStart())) {
    throw new Error('不是 WebVTT 文件（缺少 WEBVTT 文件头）；若要导入章节，请使用页头「导入章节」。');
  }
  const parsed = parseWebVTT(text);
  const cues: RawTranscriptCue[] = [];
  let skipped = 0;
  for (const e of parsed.entries) {
    // parser-level failures carry NaN times and an error note; also drop
    // zero / reversed cues here so coverage math stays positive-length only
    if (e.error || !(e.end - e.start > EPS)) {
      skipped += 1;
      continue;
    }
    cues.push({ row: e.row, start: e.start, end: e.end, text: e.title });
  }
  return { cues, skipped };
}

/**
 * Step 2: clip every cue into [0, duration]. Cues fully outside the range
 * (or reduced to a sliver) are dropped. The result is sorted by start and
 * assigned stable ids (`cue-0`, `cue-1`, …) for React keys.
 */
export function clipTranscriptCues(
  cues: ReadonlyArray<RawTranscriptCue>,
  duration: number,
): TranscriptCue[] {
  const clipped: TranscriptCue[] = [];
  for (const c of cues) {
    const start = Math.min(Math.max(c.start, 0), duration);
    const end = Math.min(Math.max(c.end, 0), duration);
    if (!(end - start > EPS)) continue;
    clipped.push({ id: '', row: c.row, start, end, text: c.text });
  }
  clipped.sort((a, b) => a.start - b.start || a.end - b.end || a.row - b.row);
  clipped.forEach((c, i) => {
    c.id = `cue-${i}`;
  });
  return clipped;
}

/**
 * Step 3: union-merge cue intervals. Overlapping (and touching) intervals
 * become one range, so any second covered by two cues is counted exactly
 * once. The returned intervals stay sorted and pairwise disjoint.
 */
export function mergeCueIntervals(cues: ReadonlyArray<Interval>): Interval[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const c of sorted) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + EPS) {
      if (c.end > last.end) last.end = c.end;
    } else {
      merged.push({ start: c.start, end: c.end });
    }
  }
  return merged;
}

function emptyChapterCoverage(): ChapterCoverage {
  return { coveredSeconds: 0, ratio: 0, cues: [] };
}

/**
 * Steps 4: per-chapter coverage. `cues` must already be clipped to the
 * audio range and sorted (see clipTranscriptCues). Seconds come from the
 * merged union intersecting the chapter, while the per-chapter cue list
 * keeps the original cues with their per-chapter intersection — a
 * cross-boundary cue therefore appears (and counts) in both chapters, but
 * only for the part actually inside each one.
 */
export function computeTranscriptCoverage(
  chapters: ReadonlyArray<Chapter>,
  cues: ReadonlyArray<TranscriptCue>,
): TranscriptCoverage {
  const merged = mergeCueIntervals(cues);
  const byChapter = new Map<string, ChapterCoverage>();

  for (const ch of chapters) {
    const cs = ch.start;
    const ce = ch.end;
    const len = ce - cs;
    if (!(len > EPS)) {
      byChapter.set(ch.id, emptyChapterCoverage());
      continue;
    }

    let covered = 0;
    for (const m of merged) {
      if (m.start >= ce) break; // merged intervals are start-sorted
      const overlap = Math.min(ce, m.end) - Math.max(cs, m.start);
      if (overlap > EPS) covered += overlap;
    }

    const overlaps: CueOverlap[] = [];
    for (const cue of cues) {
      if (cue.start >= ce) break; // cues are start-sorted
      const start = Math.max(cue.start, cs);
      const end = Math.min(cue.end, ce);
      if (end - start > EPS) overlaps.push({ cue, start, end });
    }

    covered = Math.min(covered, len); // floating-point dust only
    byChapter.set(ch.id, {
      coveredSeconds: covered,
      ratio: Math.min(1, covered / len),
      cues: overlaps,
    });
  }

  const totalCoveredSeconds = merged.reduce((sum, m) => sum + (m.end - m.start), 0);
  return { byChapter, totalCoveredSeconds };
}
