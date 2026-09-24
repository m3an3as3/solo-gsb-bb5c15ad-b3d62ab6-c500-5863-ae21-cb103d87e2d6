import {
  computePeaksFromPCM,
  type PeaksWorkerRequest,
  type PeaksWorkerResponse,
} from './peaks';

/**
 * Peaks worker: waveform min/max peak computation for long audio runs here
 * so the main thread (playback transport, chapter editing) never blocks.
 *
 * The main thread posts COPIES of only the channels it needs (up to two),
 * never the AudioBuffer or transferred views: the original decoded buffer
 * stays owned by the main thread for playback and loudness/silence QC.
 * Result arrays are transferred back (the worker does not need them after).
 *
 * The DOM and webworker TS libs cannot be mixed in one program, so the
 * global scope is described with the small structural type we actually use.
 */
type PeaksWorkerOut = PeaksWorkerResponse | { id: number; error: string };

interface PeaksWorkerScope {
  onmessage: ((ev: MessageEvent<PeaksWorkerRequest>) => void) | null;
  postMessage(message: PeaksWorkerOut, transfer: Transferable[]): void;
  postMessage(message: PeaksWorkerOut): void;
}

const worker = self as unknown as PeaksWorkerScope;

worker.onmessage = (e: MessageEvent<PeaksWorkerRequest>) => {
  const { id, duration, length, sampleRate, channels } = e.data;
  try {
    const peaks = computePeaksFromPCM({ duration, length, sampleRate, channels });
    // transfer the output buffers back; the inputs were copies, so the
    // original AudioBuffer channel data on the main thread stays intact
    worker.postMessage({ id, ...peaks }, [peaks.min.buffer, peaks.max.buffer]);
  } catch (err) {
    worker.postMessage({
      id,
      error: err instanceof Error ? err.message : '波形峰值计算失败。',
    });
  }
};

export {};
