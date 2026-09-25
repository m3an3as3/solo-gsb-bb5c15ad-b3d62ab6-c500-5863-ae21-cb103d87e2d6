import {
  clickScanSourceFromBuffer,
  detectClicks,
  type ClickEvent,
  type ClickScanWorkerResponse,
} from './clickRepair';
import ClickScanWorker from './clickScan.worker.ts?worker';
import type { AudioBufferLike } from '../types';

/** Raised on a scan that has been superseded by a newer one or canceled. */
export class ClickScanSupersededError extends Error {
  constructor() {
    super('已发起新的扫描，旧扫描作废。');
    this.name = 'ClickScanSupersededError';
  }
}

interface PendingJob {
  id: number;
  resolve: (events: ClickEvent[]) => void;
  reject: (err: unknown) => void;
}

/**
 * Client for the click-scan Web Worker.
 *
 * - The whole-recording per-channel scan runs off the main thread; long
 *   files no longer freeze transport / chapter editing.
 * - Only copies of the channel data are posted — the original AudioBuffer
 *   stays with the main thread for playback and QC.
 * - Consecutive scans: starting a new one supersedes the previous. The old
 *   worker is terminated outright (its CPU-heavy scan stops immediately),
 *   the stale promise rejects with ClickScanSupersededError, and only the
 *   newest scan can ever resolve its events.
 * - If Web Workers are unavailable the computation falls back to the
 *   main-thread pure function so the app still works.
 */
export class ClickScanWorkerClient {
  private worker: Worker | null = null;
  private job: PendingJob | null = null;
  private nextId = 1;
  private readonly workersSupported = typeof Worker !== 'undefined';

  scan(buffer: AudioBufferLike): Promise<ClickEvent[]> {
    // a newer scan invalidates whatever is in flight
    this.cancel();

    // Environments without Web Workers: keep working on the main thread.
    if (!this.workersSupported) {
      return Promise.resolve().then(() => detectClicks(clickScanSourceFromBuffer(buffer)));
    }

    return new Promise<ClickEvent[]>((resolve, reject) => {
      const id = this.nextId++;
      this.job = { id, resolve, reject };
      try {
        // fresh worker per active job: terminating the old one in cancel()
        // guarantees a stale long scan burns no more CPU
        const worker = new ClickScanWorker();
        this.worker = worker;
        worker.onmessage = (
          e: MessageEvent<ClickScanWorkerResponse | { id: number; error: string }>,
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
            job.resolve(data.events);
          }
        };
        worker.onerror = (e: ErrorEvent) => {
          const job = this.job;
          if (!job || job.id !== id) return;
          this.job = null;
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          job.reject(new Error(e.message || '爆音扫描 Worker 发生错误。'));
        };

        const source = clickScanSourceFromBuffer(buffer);
        // copies only — slicing allocates fresh ArrayBuffers, so the worker
        // receives transfers and the AudioBuffer's own data is untouched
        const copies = source.channels.map((data) => data.slice());
        worker.postMessage(
          {
            id,
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
        reject(err instanceof Error ? err : new Error('无法启动爆音扫描 Worker。'));
      }
    });
  }

  /** Reject the in-flight job and kill its worker so the scan stops now. */
  cancel(): void {
    const job = this.job;
    this.job = null;
    this.terminateWorker();
    job?.reject(new ClickScanSupersededError());
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
