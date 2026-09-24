import {
  scanChannelRuns,
  type PopScanWorkerRequest,
  type PopScanWorkerResponse,
} from './popRepair';

/**
 * 爆音扫描 worker：逐声道的稳健统计（中位数 / MAD）扫描在这里运行，
 * 长音频不阻塞主线程的播放与章节编辑。跨声道合并在主线程完成
 *（纯函数 mergeCrossChannelRuns，开销可忽略）。
 *
 * 与 peaks / repeat-search worker 一样，主线程只**复制**所需声道
 * 数据（transfer 副本），原始 AudioBuffer 始终留在主线程。
 */
type PopScanWorkerOut = PopScanWorkerResponse | { id: number; error: string };

interface PopScanWorkerScope {
  onmessage: ((ev: MessageEvent<PopScanWorkerRequest>) => void) | null;
  postMessage(message: PopScanWorkerOut): void;
}

const worker = self as unknown as PopScanWorkerScope;

worker.onmessage = (e: MessageEvent<PopScanWorkerRequest>) => {
  const { id, duration, length, sampleRate, channels } = e.data;
  try {
    const runs = scanChannelRuns({ duration, length, sampleRate, channels });
    worker.postMessage({ id, runs });
  } catch (err) {
    worker.postMessage({
      id,
      error: err instanceof Error ? err.message : '爆音扫描失败。',
    });
  }
};

export {};
