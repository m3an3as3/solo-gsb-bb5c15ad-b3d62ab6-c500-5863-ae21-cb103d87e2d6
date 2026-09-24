import {
  popSourceFromBuffer,
  scanChannelRuns,
  type PopRun,
  type PopScanWorkerResponse,
} from './popRepair';
import PopRepairWorker from './popRepair.worker.ts?worker';
import type { AudioBufferLike } from '../types';

/** Raised on a scan that has been superseded by a newer one or canceled. */
export class PopScanSupersededError extends Error {
  constructor() {
    super('已发起新的爆音扫描，旧扫描作废。');
    this.name = 'PopScanSupersededError';
  }
}

interface PendingJob {
  id: number;
  resolve: (runs: PopRun[]) => void;
  reject: (err: unknown) => void;
}

/**
 * Client for the pop-scan Web Worker（与 RepeatSearchWorkerClient 同构）。
 *
 * - 全片逐声道稳健扫描在独立线程运行，长音频不冻结界面；
 * - 主线程只复制声道 PCM（slice 后的新 ArrayBuffer，transfer 移交），
 *   原 AudioBuffer 不出主线程；
 * - 连续扫描 / 更换音频：新任务立即 terminate 旧 Worker（CPU 扫描立刻
 *   停止），旧 Promise 以 PopScanSupersededError 拒绝，只有最新一次
 *   扫描能回写结果；
 * - 环境不支持 Worker 时退回主线程纯函数。
 */
export class PopRepairWorkerClient {
  private worker: Worker | null = null;
  private job: PendingJob | null = null;
  private nextId = 1;
  private readonly workersSupported = typeof Worker !== 'undefined';

  scan(buffer: AudioBufferLike): Promise<PopRun[]> {
    // a newer scan invalidates whatever is in flight
    this.cancel();

    // Environments without Web Workers: keep working on the main thread.
    if (!this.workersSupported) {
      return Promise.resolve().then(() => scanChannelRuns(popSourceFromBuffer(buffer)));
    }

    return new Promise<PopRun[]>((resolve, reject) => {
      const id = this.nextId++;
      this.job = { id, resolve, reject };
      try {
        // fresh worker per active job: terminating the old one in cancel()
        // guarantees a stale long scan burns no more CPU
        const worker = new PopRepairWorker();
        this.worker = worker;
        worker.onmessage = (
          e: MessageEvent<PopScanWorkerResponse | { id: number; error: string }>,
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
            job.resolve(data.runs);
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

        const source = popSourceFromBuffer(buffer);
        // copies only — slicing allocates fresh ArrayBuffers, so the worker
        // receives transfers and the AudioBuffer's own data is untouched
        const copies = source.channels.map((data) => data.slice());
        worker.postMessage(
          {
            id,
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
        reject(err instanceof Error ? err : new Error('无法启动爆音扫描 Worker。'));
      }
    });
  }

  /** Reject the in-flight job and kill its worker so the scan stops now. */
  cancel(): void {
    const job = this.job;
    this.job = null;
    this.terminateWorker();
    job?.reject(new PopScanSupersededError());
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
