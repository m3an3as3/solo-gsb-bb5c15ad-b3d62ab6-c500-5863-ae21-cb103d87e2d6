import {
  computePeaks,
  peakSourceFromBuffer,
  type PeaksWorkerResponse,
} from './peaks';
import PeaksWorker from './peaks.worker.ts?worker';
import type { AudioBufferLike, Peaks } from '../types';

/** Raised on a compute() call that has been superseded by a newer one. */
export class PeaksSupersededError extends Error {
  constructor() {
    super('已切换到新音频，旧波形任务作废。');
    this.name = 'PeaksSupersededError';
  }
}

interface PendingJob {
  id: number;
  resolve: (peaks: Peaks) => void;
  reject: (err: unknown) => void;
}

/**
 * Client for the peaks Web Worker.
 *
 * - Peak calculation for a freshly decoded buffer runs off the main thread;
 *   long files no longer freeze transport / chapter editing.
 * - Only copies of the required channels (up to two) are posted — the
 *   original AudioBuffer stays with the main thread for playback and the
 *   silence/loudness QC scans.
 * - Rapidly switching files: starting a new job supersedes the previous
 *   one. The old worker is terminated outright (its CPU-heavy scan stops
 *   immediately), the stale promise rejects with PeaksSupersededError, and
 *   only the newest request can ever resolve its peaks.
 * - If Web Workers are unavailable the computation falls back to the
 *   main-thread pure function so the app still works.
 */
export class PeaksWorkerClient {
  private worker: Worker | null = null;
  private job: PendingJob | null = null;
  private nextId = 1;
  private readonly workersSupported = typeof Worker !== 'undefined';

  compute(buffer: AudioBufferLike): Promise<Peaks> {
    // a newer load invalidates whatever is in flight
    this.cancelJob(new PeaksSupersededError());

    // Environments without Web Workers: keep working on the main thread.
    if (!this.workersSupported) {
      return Promise.resolve(computePeaks(buffer));
    }

    return new Promise<Peaks>((resolve, reject) => {
      const id = this.nextId++;
      this.job = { id, resolve, reject };
      try {
        // fresh worker per active job: terminating the old one in
        // cancelJob() guarantees a stale long scan burns no more CPU
        const worker = new PeaksWorker();
        this.worker = worker;
        worker.onmessage = (e: MessageEvent<PeaksWorkerResponse | { id: number; error: string }>) => {
          const job = this.job;
          if (!job || job.id !== id) return; // stale / superseded reply
          this.job = null;
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          const data = e.data;
          if ('error' in data) {
            job.reject(new Error(data.error));
          } else {
            job.resolve({ min: data.min, max: data.max, rate: data.rate, duration: data.duration });
          }
        };
        worker.onerror = (e: ErrorEvent) => {
          const job = this.job;
          if (!job || job.id !== id) return;
          this.job = null;
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          job.reject(new Error(e.message || '波形计算 Worker 发生错误。'));
        };

        const source = peakSourceFromBuffer(buffer);
        // copies only — slicing allocates fresh ArrayBuffers, so the worker
        // receives transfers and the AudioBuffer's own data is untouched
        const copies = source.channels.map((data) => data.slice());
        worker.postMessage(
          { id, ...source, channels: copies },
          copies.map((data) => data.buffer),
        );
      } catch (err) {
        if (this.job?.id === id) {
          this.job = null;
          this.terminateWorker();
        }
        reject(err instanceof Error ? err : new Error('无法启动波形计算 Worker。'));
      }
    });
  }

  /** Reject the in-flight job and kill its worker so the scan stops now. */
  private cancelJob(reason: unknown): void {
    const job = this.job;
    this.job = null;
    this.terminateWorker();
    job?.reject(reason);
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  /** Tear down on app unmount. */
  dispose(): void {
    this.cancelJob(new PeaksSupersededError());
  }
}
