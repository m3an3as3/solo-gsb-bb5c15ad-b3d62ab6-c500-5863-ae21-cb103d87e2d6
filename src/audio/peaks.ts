import type { AudioBufferLike, Peaks } from '../types';

export const PEAKS_RATE = 200; // peaks per second

/** Input needed for peak calculation: only the channel PCM, not the buffer. */
export interface PeakSource {
  duration: number;
  length: number;
  sampleRate: number;
  /** channel sample data; typically only the first two channels are needed */
  channels: readonly Float32Array[];
}

/** Message payload posted to the peaks worker. */
export interface PeaksWorkerRequest extends PeakSource {
  id: number;
}

/** Result payload posted back by the peaks worker. */
export interface PeaksWorkerResponse extends Peaks {
  id: number;
}

/** Build a PeakSource from an AudioBuffer; copies are taken by the caller. */
export function peakSourceFromBuffer(buffer: AudioBufferLike): PeakSource {
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
 * Compute min/max peak pairs at a fixed rate from decoded channel PCM.
 * ~200 peaks/sec keeps rendering cheap at any zoom level. Runs both on the
 * main thread (fallback) and inside the peaks Web Worker, so it must never
 * touch the AudioBuffer — channel data is passed explicitly.
 */
export function computePeaksFromPCM(source: PeakSource): Peaks {
  const { duration, length, sampleRate, channels } = source;
  const rate = PEAKS_RATE;
  const count = Math.max(1, Math.ceil(duration * rate));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const samplesPerPeak = sampleRate / rate;

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * samplesPerPeak);
    const end = Math.min(length, Math.ceil((i + 1) * samplesPerPeak));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      // stride to keep per-peak work bounded on very long files
      const step = Math.max(1, Math.floor((end - start) / 256));
      for (let s = start; s < end; s += step) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, rate, duration };
}

/**
 * Compute min/max peak pairs directly from a decoded buffer.
 * Kept as the main-thread fallback (e.g. environments without Web Workers).
 */
export function computePeaks(buffer: AudioBufferLike): Peaks {
  return computePeaksFromPCM(peakSourceFromBuffer(buffer));
}
