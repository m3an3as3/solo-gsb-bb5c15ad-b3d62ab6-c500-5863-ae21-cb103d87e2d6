import {
  searchRepeats,
  type RepeatSearchWorkerRequest,
  type RepeatSearchWorkerResponse,
} from './repeatSearch';

/**
 * Repeat-search worker: the full-recording scan (decimate → energy coarse
 * screen → normalized waveform correlation) runs here so the main thread
 * (playback transport, chapter editing) never blocks.
 *
 * As with the peaks worker, the main thread posts COPIES of only the
 * channels it needs (up to two), never the AudioBuffer itself; the decoded
 * buffer stays owned by the main thread for playback and QC.
 *
 * The DOM and webworker TS libs cannot be mixed in one program, so the
 * global scope is described with the small structural type we actually use.
 */
type RepeatSearchWorkerOut = RepeatSearchWorkerResponse | { id: number; error: string };

interface RepeatSearchWorkerScope {
  onmessage: ((ev: MessageEvent<RepeatSearchWorkerRequest>) => void) | null;
  postMessage(message: RepeatSearchWorkerOut): void;
}

const worker = self as unknown as RepeatSearchWorkerScope;

worker.onmessage = (e: MessageEvent<RepeatSearchWorkerRequest>) => {
  const { id, sampleStart, sampleEnd, duration, length, sampleRate, channels } = e.data;
  try {
    const hits = searchRepeats(
      { duration, length, sampleRate, channels },
      { start: sampleStart, end: sampleEnd },
    );
    worker.postMessage({ id, hits });
  } catch (err) {
    worker.postMessage({
      id,
      error: err instanceof Error ? err.message : '重复录制搜索失败。',
    });
  }
};

export {};
