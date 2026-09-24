export interface Chapter {
  id: string;
  title: string;
  start: number; // seconds
  end: number; // seconds
}

export type SortKey = 'start' | 'title' | 'duration';

/** Structural subset of the DOM AudioBuffer (avoids clashing with the global type). */
export interface AudioBufferLike {
  duration: number;
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  /** peaks per second */
  rate: number;
  duration: number;
}
