import type { AudioBufferLike, Chapter } from '../types';
import { computeRmsWindows } from './silence';

/** Loudness QC analysis window: 200ms. */
export const LOUDNESS_WINDOW_SEC = 0.2;

const EPS = 1e-9;

export type LoudnessStatus = 'unknown' | 'ok' | 'quiet' | 'loud';
export type LoudnessKind = 'quiet' | 'loud';

export interface LoudnessThresholds {
  /** below this dBFS average a chapter counts as 过轻 */
  quietDb: number;
  /** above this dBFS average a chapter counts as 过响 */
  loudDb: number;
}

export interface ChapterLoudness {
  status: LoudnessStatus;
  /** energy-weighted (overlap-weighted) mean dBFS; null when there is no signal */
  meanDbfs: number | null;
  minDbfs: number | null;
  maxDbfs: number | null;
  /** maxDbfs - minDbfs over audible windows; 0 when unavailable */
  rangeDb: number;
  /** every analyzed window is digital silence */
  allSilent: boolean;
  /** 0..1 fraction of analyzed time covered by silent windows */
  silentCoverage: number;
  /** analyzed seconds quieter than the quiet threshold (silence included) */
  quietCoverage: number;
  /** analyzed seconds louder than the loud threshold */
  loudCoverage: number;
  /** seconds of chapter audio actually covered by windows */
  analyzedDuration: number;
  /** start of the first abnormal window within the chapter; null when none */
  firstIssueAt: number | null;
}

export interface LoudnessSegment {
  kind: LoudnessKind;
  start: number;
  end: number;
}

/**
 * Convert per-window linear RMS to dBFS. Exact silence maps to -Infinity
 * (never NaN) so downstream math stays well-defined.
 */
export function dbfsFromRms(rms: Float32Array): Float32Array {
  const db = new Float32Array(rms.length);
  for (let i = 0; i < rms.length; i++) {
    db[i] = rms[i] > 0 ? 20 * Math.log10(rms[i]) : -Infinity;
  }
  return db;
}

/**
 * Per-window combined multi-channel dBFS at a fixed 200ms grid, computed from
 * the ALREADY-DECODED PCM. Runs once at import time; changing QC thresholds
 * never re-runs this (no re-decode, no re-scan).
 */
export function computeDbfsWindows(
  buffer: AudioBufferLike,
  windowSec: number = LOUDNESS_WINDOW_SEC,
): Float32Array {
  return dbfsFromRms(computeRmsWindows(buffer, windowSec));
}

/** Window-level classification. Digital silence is treated as 过轻. */
function classifyWindow(db: number, t: LoudnessThresholds): LoudnessKind | null {
  if (!Number.isFinite(db)) return 'quiet';
  if (db < t.quietDb) return 'quiet';
  if (db > t.loudDb) return 'loud';
  return null;
}

function emptyMetric(status: LoudnessStatus): ChapterLoudness {
  return {
    status,
    meanDbfs: null,
    minDbfs: null,
    maxDbfs: null,
    rangeDb: 0,
    allSilent: status === 'quiet',
    silentCoverage: 0,
    quietCoverage: 0,
    loudCoverage: 0,
    analyzedDuration: 0,
    firstIssueAt: null,
  };
}

/**
 * Loudness metrics for one chapter. Windows that straddle a chapter boundary
 * contribute proportionally to their ACTUAL overlap with the chapter, so a
 * cross-chapter window can never be fully attributed to the wrong side.
 *
 * The mean is an energy (power) weighted average:
 *   meanDb = 10 * log10(Σ wᵢ·10^(dbᵢ/10) / Σ wᵢ)
 * which is mathematically equivalent to combining the per-window RMS energy
 * and stays finite for any non-silent mix.
 */
export function evaluateChapterLoudness(
  chapter: Chapter,
  dbfs: Float32Array,
  windowSec: number,
  duration: number,
  thresholds: LoudnessThresholds,
): ChapterLoudness {
  const cs = Math.min(Math.max(chapter.start, 0), duration);
  const ce = Math.min(Math.max(chapter.end, 0), duration);
  if (!(ce - cs > EPS)) return emptyMetric('unknown');

  const i0 = Math.max(0, Math.floor(cs / windowSec));
  const i1 = Math.min(dbfs.length - 1, Math.ceil(ce / windowSec));

  let weightSum = 0;
  let energySum = 0;
  let silentWeight = 0;
  let quietWeight = 0;
  let loudWeight = 0;
  let minDb = Infinity;
  let maxDb = -Infinity;
  let firstIssueAt: number | null = null;

  for (let i = i0; i <= i1; i++) {
    const ws = i * windowSec;
    const we = Math.min((i + 1) * windowSec, duration);
    const overlap = Math.min(we, ce) - Math.max(ws, cs);
    if (!(overlap > EPS)) continue; // sliver/zero overlap: never misattributed

    weightSum += overlap;
    const db = dbfs[i];
    if (Number.isFinite(db)) {
      energySum += overlap * Math.pow(10, db / 10);
      if (db < minDb) minDb = db;
      if (db > maxDb) maxDb = db;
    } else {
      silentWeight += overlap;
    }

    const kind = classifyWindow(db, thresholds);
    if (kind === 'quiet') quietWeight += overlap;
    else if (kind === 'loud') loudWeight += overlap;
    if (kind && firstIssueAt === null) firstIssueAt = Math.max(ws, cs);
  }

  if (!(weightSum > EPS)) return emptyMetric('unknown');

  const allSilent = energySum <= 0;
  let mean: number | null = null;
  if (!allSilent) {
    mean = 10 * Math.log10(energySum / weightSum);
    if (!Number.isFinite(mean)) mean = null; // defensive: never emit NaN
  }

  let status: LoudnessStatus;
  if (mean === null) status = 'quiet'; // fully silent chapter
  else if (mean < thresholds.quietDb) status = 'quiet';
  else if (mean > thresholds.loudDb) status = 'loud';
  else status = 'ok';

  return {
    status,
    meanDbfs: mean,
    minDbfs: Number.isFinite(minDb) ? minDb : null,
    maxDbfs: Number.isFinite(maxDb) ? maxDb : null,
    rangeDb: Number.isFinite(minDb) && Number.isFinite(maxDb) ? maxDb - minDb : 0,
    allSilent,
    silentCoverage: silentWeight / weightSum,
    quietCoverage: quietWeight,
    loudCoverage: loudWeight,
    analyzedDuration: weightSum,
    firstIssueAt: firstIssueAt ?? (allSilent ? cs : null),
  };
}

/** Evaluate every chapter; windows are scanned once per local index range. */
export function evaluateAllChapters(
  chapters: Chapter[],
  dbfs: Float32Array,
  windowSec: number,
  duration: number,
  thresholds: LoudnessThresholds,
): Map<string, ChapterLoudness> {
  const byId = new Map<string, ChapterLoudness>();
  for (const c of chapters) {
    byId.set(c.id, evaluateChapterLoudness(c, dbfs, windowSec, duration, thresholds));
  }
  return byId;
}

/**
 * Merge consecutive windows classified as the same abnormal kind into
 * continuous ranges (for waveform coloring). The last window is clamped to
 * the real buffer duration. Changing thresholds only re-runs this cheap
 * classification over the cached dBFS array.
 */
export function findLoudnessSegments(
  dbfs: Float32Array,
  windowSec: number,
  duration: number,
  thresholds: LoudnessThresholds,
): LoudnessSegment[] {
  const segments: LoudnessSegment[] = [];
  let runKind: LoudnessKind | null = null;
  let runStart = -1;
  let runLast = -1;

  const flush = (untilIndex: number) => {
    if (runKind === null) return;
    const start = runStart * windowSec;
    const end = Math.min(untilIndex * windowSec, duration);
    if (end - start > EPS) segments.push({ kind: runKind, start, end });
  };

  for (let i = 0; i < dbfs.length; i++) {
    if (i * windowSec >= duration) break;
    const kind = classifyWindow(dbfs[i], thresholds);
    if (kind && kind === runKind) {
      runLast = i;
      continue;
    }
    flush(runLast + 1);
    runKind = kind;
    runStart = kind ? i : -1;
    runLast = kind ? i : -1;
  }
  flush(runLast + 1);
  return segments;
}
