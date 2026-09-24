import type { AudioBufferLike } from '../types';

/** Decimated mono rate used for matching (samples per second). */
export const SEARCH_RATE = 1000;
/** Energy envelope frame length for the coarse screen (seconds). */
export const ENERGY_FRAME_SEC = 0.02;
/** Samples shorter than this cannot be matched reliably (seconds). */
export const MIN_SAMPLE_SEC = 0.5;
/** Coarse energy-profile correlation needed to become a candidate. */
export const COARSE_THRESHOLD = 0.45;
/** At most this many coarse candidates get the full waveform correlation. */
export const MAX_CANDIDATES = 500;
/** Final normalized-correlation score needed to report a hit. */
export const MIN_SCORE = 0.6;
/** Reported hits are capped at this many (best scores win). */
export const MAX_HITS = 50;
/** Candidate windows quieter than this fraction of the sample's mean energy are skipped. */
export const MIN_ENERGY_RATIO = 0.01;
/** Sample RMS below this is treated as silence and rejected. */
export const SILENT_RMS = 1e-4;

/** Input needed for the search: only channel PCM, never the AudioBuffer. */
export interface RepeatSearchSource {
  duration: number;
  length: number;
  sampleRate: number;
  channels: readonly Float32Array[];
}

/** Sample interval in seconds (the selected chapter's original audio). */
export interface RepeatSampleRange {
  start: number;
  end: number;
}

export interface RepeatHit {
  start: number; // seconds
  end: number; // seconds
  /** zero-mean normalized correlation in [-1, 1]; 1 = identical up to volume */
  score: number;
}

/** Message payload posted to the repeat-search worker. */
export interface RepeatSearchWorkerRequest extends RepeatSearchSource {
  id: number;
  sampleStart: number;
  sampleEnd: number;
}

/** Result payload posted back by the repeat-search worker. */
export interface RepeatSearchWorkerResponse {
  id: number;
  hits: RepeatHit[];
}

export interface RepeatSearchOptions {
  searchRate?: number;
  energyFrameSec?: number;
  coarseThreshold?: number;
  maxCandidates?: number;
  minScore?: number;
  maxHits?: number;
}

/** Build a search source from an AudioBuffer; copies are taken by the caller. */
export function repeatSourceFromBuffer(buffer: AudioBufferLike): RepeatSearchSource {
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c));
  }
  return {
    duration: buffer.duration,
    length: buffer.length,
    sampleRate: buffer.sampleRate,
    channels,
  };
}

/**
 * Mix all given channels to mono and decimate to `targetRate` by block
 * averaging. Matching at 1 kHz keeps the full-resolution scan cheap while
 * remaining discriminative for identical (re-recorded / duplicated) audio.
 */
export function mixdownDecimate(
  source: RepeatSearchSource,
  targetRate: number = SEARCH_RATE,
): Float32Array {
  const { length, sampleRate, channels } = source;
  const block = sampleRate / targetRate;
  const outLen = Math.max(1, Math.floor(length / block));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s0 = Math.floor(i * block);
    const s1 = Math.min(length, Math.max(s0 + 1, Math.floor((i + 1) * block)));
    let sum = 0;
    for (const data of channels) {
      for (let s = s0; s < s1; s++) sum += data[s];
    }
    out[i] = sum / ((s1 - s0) * channels.length);
  }
  return out;
}

/** Mean-square energy per frame of the decimated mono waveform. */
export function frameEnergies(
  mono: Float32Array,
  rate: number,
  frameSec: number = ENERGY_FRAME_SEC,
): Float32Array {
  const frame = Math.max(1, Math.round(rate * frameSec));
  const count = Math.max(1, Math.floor(mono.length / frame));
  const energy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const s0 = i * frame;
    let sum = 0;
    for (let s = s0; s < s0 + frame; s++) {
      const v = mono[s];
      sum += v * v;
    }
    energy[i] = sum / frame;
  }
  return energy;
}

/**
 * Zero-mean normalized cross-correlation between two equal-length spans of
 * the mono waveform. Invariant to overall volume (and DC offset), so a
 * re-recorded segment pasted at a different level still scores ≈ 1.
 */
export function normalizedCorrelation(
  mono: Float32Array,
  aOffset: number,
  bOffset: number,
  len: number,
): number {
  if (len <= 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < len; i++) {
    sa += mono[aOffset + i];
    sb += mono[bOffset + i];
  }
  const ma = sa / len;
  const mb = sb / len;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < len; i++) {
    const a = mono[aOffset + i] - ma;
    const b = mono[bOffset + i] - mb;
    sab += a * b;
    saa += a * a;
    sbb += b * b;
  }
  const den = Math.sqrt(saa * sbb);
  return den > 0 ? sab / den : 0;
}

export interface CoarseCandidate {
  /** frame offset into the energy envelope */
  offset: number;
  score: number;
}

/**
 * Coarse screen: slide the sample's energy envelope over the whole
 * recording's envelope and keep windows whose zero-mean normalized
 * energy-profile correlation clears `threshold`. Windows overlapping the
 * sample itself are skipped here already, as are near-silent windows
 * (energy gate). A flat sample envelope (constant loudness) carries no
 * shape, so the screen falls back to a dense grid and lets the waveform
 * stage decide. Returned offsets are sorted by score, best first, and
 * capped at `maxCandidates`.
 */
export function coarseCandidates(
  energy: Float32Array,
  sampleOffsetFrames: number,
  sampleLenFrames: number,
  threshold: number = COARSE_THRESHOLD,
  maxCandidates: number = MAX_CANDIDATES,
  minEnergyRatio: number = MIN_ENERGY_RATIO,
): CoarseCandidate[] {
  const m = sampleLenFrames;
  const n = energy.length;
  if (m <= 0 || n <= m) return [];

  let sSum = 0;
  for (let i = 0; i < m; i++) sSum += energy[sampleOffsetFrames + i];
  const sMean = sSum / m;
  const sc = new Float32Array(m);
  let sVar = 0;
  for (let i = 0; i < m; i++) {
    sc[i] = energy[sampleOffsetFrames + i] - sMean;
    sVar += sc[i] * sc[i];
  }
  const sDen = Math.sqrt(sVar);
  const minWindowEnergy = sMean * minEnergyRatio;
  // window [k, k+m) must not touch the sample's own frame range
  const overlapsSample = (k: number) => k < sampleOffsetFrames + m && k + m > sampleOffsetFrames;

  // flat sample energy profile: no shape to match — dense grid fallback
  if (sDen <= 1e-12) {
    const stride = Math.max(1, Math.floor(m / 4));
    const grid: CoarseCandidate[] = [];
    for (let k = 0; k + m <= n; k += stride) {
      if (!overlapsSample(k)) grid.push({ offset: k, score: 0 });
    }
    if (grid.length <= maxCandidates) return grid;
    const picked: CoarseCandidate[] = [];
    const stepF = grid.length / maxCandidates;
    for (let i = 0; i < maxCandidates; i++) picked.push(grid[Math.floor(i * stepF)]);
    return picked;
  }

  // running window sums keep the per-position gate O(1)
  let wSum = 0;
  let wSq = 0;
  for (let i = 0; i < m; i++) {
    const e = energy[i];
    wSum += e;
    wSq += e * e;
  }
  const out: CoarseCandidate[] = [];
  for (let k = 0; k + m <= n; k++) {
    if (k > 0) {
      const eOut = energy[k - 1];
      const eIn = energy[k + m - 1];
      wSum += eIn - eOut;
      wSq += eIn * eIn - eOut * eOut;
    }
    if (!overlapsSample(k) && wSum / m >= minWindowEnergy) {
      const wVar = wSq - (wSum * wSum) / m;
      if (wVar > 1e-12) {
        let cross = 0;
        for (let i = 0; i < m; i++) cross += sc[i] * energy[k + i];
        const score = cross / (sDen * Math.sqrt(wVar));
        if (score >= threshold) out.push({ offset: k, score });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxCandidates);
}

/**
 * Merge hits belonging to the same repeated segment: hits whose start times
 * differ by less than half the sample length are the same segment seen at
 * slightly different alignments — keep the best score. The final list is
 * sorted by score (best first) and capped at `maxHits`.
 */
export function mergeHits(
  hits: RepeatHit[],
  sampleLenSec: number,
  maxHits: number = MAX_HITS,
): RepeatHit[] {
  const byScore = hits.slice().sort((a, b) => b.score - a.score || a.start - b.start);
  const kept: RepeatHit[] = [];
  for (const h of byScore) {
    if (kept.every((k) => Math.abs(k.start - h.start) >= sampleLenSec / 2)) {
      kept.push(h);
      if (kept.length >= maxHits) break;
    }
  }
  return kept.sort((a, b) => b.score - a.score || a.start - b.start);
}

/**
 * Full pipeline: decimate the multi-channel mix, coarse-screen by energy
 * envelope, then refine each candidate with a local zero-mean normalized
 * waveform correlation (volume changes do not affect the ranking). The
 * sample itself and anything overlapping it is excluded, and hits around
 * the same repeated segment are merged. Pure function — runs both in the
 * repeat-search Web Worker and as a main-thread fallback.
 */
export function searchRepeats(
  source: RepeatSearchSource,
  sample: RepeatSampleRange,
  options: RepeatSearchOptions = {},
): RepeatHit[] {
  const rate = options.searchRate ?? SEARCH_RATE;
  const frameSec = options.energyFrameSec ?? ENERGY_FRAME_SEC;
  const coarseThreshold = options.coarseThreshold ?? COARSE_THRESHOLD;
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  const minScore = options.minScore ?? MIN_SCORE;
  const maxHits = options.maxHits ?? MAX_HITS;

  if (
    !Number.isFinite(sample.start) ||
    !Number.isFinite(sample.end) ||
    sample.end <= sample.start
  ) {
    throw new Error('样本区间无效。');
  }
  if (source.sampleRate <= 0 || source.length <= 0 || source.channels.length === 0) {
    throw new Error('音频数据无效。');
  }
  const sampleLenSec = sample.end - sample.start;
  if (sampleLenSec < MIN_SAMPLE_SEC) {
    throw new Error(
      `样本章节太短（${sampleLenSec.toFixed(2)}s）：至少需要 ${MIN_SAMPLE_SEC}s 才能可靠匹配。`,
    );
  }

  const mono = mixdownDecimate(source, rate);
  const sOff = Math.max(0, Math.round(sample.start * rate));
  if (sOff >= mono.length) throw new Error('样本区间超出音频范围。');
  let sLen = Math.round(sampleLenSec * rate);
  if (sOff + sLen > mono.length) sLen = mono.length - sOff;

  // a silent sample matches everything and nothing — reject it up front
  let sSq = 0;
  for (let i = 0; i < sLen; i++) {
    const v = mono[sOff + i];
    sSq += v * v;
  }
  if (Math.sqrt(sSq / sLen) < SILENT_RMS) {
    throw new Error('样本章节几乎全是静音，无法用于匹配。');
  }

  const frame = Math.max(1, Math.round(rate * frameSec));
  const energy = frameEnergies(mono, rate, frameSec);
  const sOffF = Math.floor(sOff / frame);
  let sLenF = Math.max(1, Math.floor(sLen / frame));
  if (sOffF + sLenF > energy.length) sLenF = energy.length - sOffF;
  if (sLenF <= 0) return [];

  const candidates = coarseCandidates(energy, sOffF, sLenF, coarseThreshold, maxCandidates);

  // refine each candidate: scan ±1 energy frame around the coarse position
  // and keep the best waveform correlation (frame quantization recovery)
  const lagStep = Math.max(1, Math.floor(frame / 8));
  const hits: RepeatHit[] = [];
  for (const cand of candidates) {
    const base = cand.offset * frame;
    let best = -2;
    let bestPos = base;
    for (let lag = -frame; lag <= frame; lag += lagStep) {
      const pos = base + lag;
      if (pos < 0 || pos + sLen > mono.length) continue;
      const c = normalizedCorrelation(mono, sOff, pos, sLen);
      if (c > best) {
        best = c;
        bestPos = pos;
      }
    }
    if (best < minScore) continue;
    const start = bestPos / rate;
    const end = (bestPos + sLen) / rate;
    // exclude the sample itself and any interval overlapping it
    if (start < sample.end && end > sample.start) continue;
    hits.push({ start, end, score: best });
  }
  return mergeHits(hits, sampleLenSec, maxHits);
}
