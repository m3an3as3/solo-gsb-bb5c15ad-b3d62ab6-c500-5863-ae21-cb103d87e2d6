import {
  detectClicks,
  type ClickScanWorkerRequest,
  type ClickScanWorkerResponse,
} from './clickRepair';

/**
 * Click-scan worker: the per-channel median/MAD scan of the whole recording
 * runs here so the main thread (playback transport, chapter editing) never
 * blocks.
 *
 * As with the peaks / repeat-search workers, the main thread posts COPIES of
 * the channel data, never the AudioBuffer itself; the decoded buffer stays
 * owned by the main thread for playback and QC.
 *
 * The DOM and webworker TS libs cannot be mixed in one program, so the
 * global scope is described with the small structural type we actually use.
 */
type ClickScanWorkerOut = ClickScanWorkerResponse | { id: number; error: string };

interface ClickScanWorkerScope {
  onmessage: ((ev: MessageEvent<ClickScanWorkerRequest>) => void) | null;
  postMessage(message: ClickScanWorkerOut): void;
}

const worker = self as unknown as ClickScanWorkerScope;

worker.onmessage = (e: MessageEvent<ClickScanWorkerRequest>) => {
  const { id, length, sampleRate, channels } = e.data;
  try {
    const events = detectClicks({ length, sampleRate, channels });
    worker.postMessage({ id, events });
  } catch (err) {
    worker.postMessage({
      id,
      error: err instanceof Error ? err.message : '爆音扫描失败。',
    });
  }
};

export {};
