import {
  repeatSourceFromBuffer,
  searchRepeats,
  type RepeatHit,
  type RepeatSampleRange,
  type RepeatSearchWorkerResponse,
} from './repeatSearch';
import RepeatSearchWorker from './repeatSearch.worker.ts?worker';
import type { AudioBufferLike } from '../types';

/** Raised on a search that has been superseded by a newer one or canceled. */
export class RepeatSearchSupersededError extends Error {
  constructor() {
    super('已发起新的搜索，旧搜索作废。');
    this.name = 'RepeatSearchSupersededError';
  }
}

interface PendingJob {
  id: number;
  resolve: (hits: RepeatHit[]) => void;
  reject: (err: unknown) => void;
}

/**
 * Client for the repeat-search Web Worker.
 *
 * - The whole-recording scan runs off the main thread; long files no longer
 *   freeze transport / chapter editing.
 * - Only copies of the required channels (up to two) are posted — the
 *   original AudioBuffer stays with the main thread for playback and QC.
 * - Consecutive searches: starting a new one supersedes the previous. The
 *   old worker is terminated outright (its CPU-heavy scan stops
 *   immediately), the stale promise rejects with
 *   RepeatSearchSupersededError, and only the newest search can ever
 *   resolve its hits.
 * - If Web Workers are unavailable the computation falls back to the
 *   main-thread pure function so the app still works.
 */
export class RepeatSearchWorkerClient {
  private worker: Worker | null = null;
  private job: PendingJob | null = null;
  private nextId = 1;
  private readonly workersSupported = typeof Worker !== 'undefined';

  search(buffer: AudioBufferLike, sample: RepeatSampleRange): Promise<RepeatHit[]> {
    // a newer search invalidates whatever is in flight
    this.cancel();

    // Environments without Web Workers: keep working on the main thread.
    if (!this.workersSupported) {
      return Promise.resolve().then(() =>
        searchRepeats(repeatSourceFromBuffer(buffer), sample),
      );
    }

    return new Promise<RepeatHit[]>((resolve, reject) => {
      const id = this.nextId++;
      this.job = { id, resolve, reject };
      try {
        // fresh worker per active job: terminating the old one in cancel()
        // guarantees a stale long scan burns no more CPU
        const worker = new RepeatSearchWorker();
        this.worker = worker;
        worker.onmessage = (
          e: MessageEvent<RepeatSearchWorkerResponse | { id: number; error: string }>,
        ) => {
          const job = this.job;
          if (!job || job.id !== id) return; // stale / superseded reply
          this.job = null;
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          const data = e.data;
          if ('error' in data) {
            job.reject(new Error(data.error));
          } else {
            job.resolve(data.hits);
          }
        };
        worker.onerror = (e: ErrorEvent) => {
          const job = this.job;
          if (!job || job.id !== id) return;
          this.job = null;
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          job.reject(new Error(e.message || '重复录制搜索 Worker 发生错误。'));
        };

        const source = repeatSourceFromBuffer(buffer);
        // copies only — slicing allocates fresh ArrayBuffers, so the worker
        // receives transfers and the AudioBuffer's own data is untouched
        const copies = source.channels.map((data) => data.slice());
        worker.postMessage(
          {
            id,
            sampleStart: sample.start,
            sampleEnd: sample.end,
            duration: source.duration,
            length: source.length,
            sampleRate: source.sampleRate,
            channels: copies,
          },
          copies.map((data) => data.buffer),
        );
      } catch (err) {
        if (this.job?.id === id) {
          this.job = null;
          this.terminateWorker();
        }
        reject(err instanceof Error ? err : new Error('无法启动重复录制搜索 Worker。'));
      }
    });
  }

  /** Reject the in-flight job and kill its worker so the scan stops now. */
  cancel(): void {
    const job = this.job;
    this.job = null;
    this.terminateWorker();
    job?.reject(new RepeatSearchSupersededError());
  }

  private terminateWorker(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
  }

  /** Tear down on app unmount. */
  dispose(): void {
    this.cancel();
  }
}
