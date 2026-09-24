/**
 * Fade-in / fade-out envelope math for chapter preview.
 * Pure functions only — the Web Audio scheduling lives in AudioEngine.
 * Settings are UI state and never become part of chapter data or exports.
 */

export interface FadeSettings {
  /** master switch: off restores the original (unfaded) preview */
  enabled: boolean;
  /** fade-in duration in seconds (0..MAX_FADE_SEC) */
  fadeIn: number;
  /** fade-out duration in seconds (0..MAX_FADE_SEC) */
  fadeOut: number;
}

/** Subset of FadeSettings the engine needs to build a curve. */
export type FadeSpec = Pick<FadeSettings, 'fadeIn' | 'fadeOut'>;

export const MAX_FADE_SEC = 5;

export const DEFAULT_FADE: FadeSettings = { enabled: false, fadeIn: 1, fadeOut: 1 };

/** Clamp a user-entered fade duration to 0..MAX_FADE_SEC (NaN/Infinity -> 0). */
export function clampFade(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_FADE_SEC, Math.max(0, v));
}

export interface FadeTimes {
  fadeIn: number;
  fadeOut: number;
}

/**
 * Fit requested fade durations into a segment of `length` seconds.
 * When fadeIn + fadeOut exceeds the segment, both are scaled down
 * proportionally to their sum, so the envelope exactly tiles the segment:
 * no abrupt steps and the fades never reach past the boundaries.
 */
export function fitFadeTimes(fadeIn: number, fadeOut: number, length: number): FadeTimes {
  const L = Math.max(0, length);
  const fi = clampFade(fadeIn);
  const fo = clampFade(fadeOut);
  const sum = fi + fo;
  if (!(L > 0) || sum <= 0) return { fadeIn: 0, fadeOut: 0 };
  if (sum <= L) return { fadeIn: fi, fadeOut: fo };
  const k = L / sum;
  return { fadeIn: fi * k, fadeOut: fo * k };
}

export interface FadeCurvePoint {
  /** seconds relative to the segment start */
  t: number;
  gain: number;
}

/**
 * Gain envelope over a playback segment: ramp 0 -> 1 over the fade-in,
 * hold at 1, then ramp 1 -> 0 over the fade-out ending exactly at the
 * segment end. Adjacent points are connected with linear ramps, so the
 * curve is continuous (no jumps) and all times stay within [0, length].
 * Returns a single constant point when no fade is needed, letting the
 * caller skip the envelope node entirely.
 */
export function buildFadeCurve(fadeIn: number, fadeOut: number, length: number): FadeCurvePoint[] {
  const L = Math.max(0, length);
  const { fadeIn: fi, fadeOut: fo } = fitFadeTimes(fadeIn, fadeOut, L);
  if (fi <= 0 && fo <= 0) return [{ t: 0, gain: 1 }];

  const pts: FadeCurvePoint[] = [];
  if (fi > 0) {
    pts.push({ t: 0, gain: 0 }, { t: fi, gain: 1 });
  } else {
    pts.push({ t: 0, gain: 1 });
  }
  if (fo > 0) {
    const fadeOutStart = L - fo;
    const last = pts[pts.length - 1];
    // collapse a zero-length hold (fade-in end exactly meets fade-out start)
    if (!(last.gain === 1 && Math.abs(last.t - fadeOutStart) < 1e-9)) {
      pts.push({ t: fadeOutStart, gain: 1 });
    }
    pts.push({ t: L, gain: 0 });
  } else {
    pts.push({ t: L, gain: 1 });
  }
  return pts;
}
