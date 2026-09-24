import { buildFadeCurve, type FadeSpec } from './fade';

/** Thrown when a decode() call is superseded by a newer file selection. */
export class StaleDecodeError extends Error {
  constructor() {
    super('该音频的解码已被后续选择取代。');
    this.name = 'StaleDecodeError';
  }
}

/**
 * Thin wrapper around Web Audio API for buffer playback.
 * Supports full-file playback and segment (chapter) preview, optionally
 * with a fade-in/fade-out gain envelope fitted to the played segment.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  /** increments per decode(); only the newest decode may publish a buffer */
  private decodeSeq = 0;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** per-preview fade envelope node (source -> env -> gain) */
  private env: GainNode | null = null;
  /** ctx.currentTime at which playback started */
  private startedAt = 0;
  /** buffer offset at which playback started */
  private offset = 0;
  /** buffer currently being played (defaults to the decoded source buffer) */
  private playbackBuffer: AudioBuffer | null = null;
  private stopAt: number | null = null;
  private stopTimer: number | null = null;
  playing = false;
  onEnded: (() => void) | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  async decode(file: File): Promise<AudioBuffer> {
    const ctx = this.ensureCtx();
    const seq = ++this.decodeSeq;
    const data = await file.arrayBuffer();
    // Another file was selected while this one was still decoding.
    if (seq !== this.decodeSeq) throw new StaleDecodeError();
    const decoded = await ctx.decodeAudioData(data);
    // Decoding itself is async too — never let an older decode publish.
    if (seq !== this.decodeSeq) throw new StaleDecodeError();
    this.stop();
    this.buffer = decoded;
    return this.buffer;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get hasBuffer(): boolean {
    return this.buffer !== null;
  }

  /** Current playback position in seconds (buffer timeline). */
  getTime(): number {
    if (!this.playing || !this.ctx) return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startedAt);
    return Math.min(t, this.playbackBuffer?.duration ?? this.duration);
  }

  /**
   * Select which buffer subsequent play() calls use. Pass null to restore
   * the decoded source buffer (used when leaving processed-buffer audition).
   */
  setPlaybackBuffer(buffer: AudioBuffer | null): void {
    this.playbackBuffer = buffer;
  }

  /** Lazily created / resumed AudioContext (for wrapping processed PCM). */
  getContext(): AudioContext {
    return this.ensureCtx();
  }

  /**
   * Play an arbitrary buffer (defaults to the decoded source buffer). The
   * processed-buffer path lets the muting panel audition the exact same PCM
   * that gets exported; switching buffers always tears the previous source down
   * first, so sounds never layer.
   */
  play(from: number, to?: number, fade?: FadeSpec, buffer?: AudioBuffer): void {
    const target = buffer ?? this.playbackBuffer ?? this.buffer;
    if (!target) return;
    const ctx = this.ensureCtx();
    this.stopSource();
    const source = ctx.createBufferSource();
    source.buffer = target;
    const dur = target.duration;
    const start = Math.max(0, Math.min(from, dur));
    this.offset = start;
    this.stopAt = to !== undefined ? Math.min(to, dur) : null;
    const segLen = Math.max(0, (this.stopAt ?? dur) - start);
    const t0 = ctx.currentTime;

    // Fade envelope: a dedicated GainNode per preview, fitted to the actual
    // playback segment. Rebuilding never touches the master gain, and the
    // old node is fully torn down in stopSource() — no overlapping sound.
    const curve = fade ? buildFadeCurve(fade.fadeIn, fade.fadeOut, segLen) : null;
    if (curve && curve.length > 1) {
      const env = ctx.createGain();
      env.gain.setValueAtTime(curve[0].gain, t0 + curve[0].t);
      for (let i = 1; i < curve.length; i++) {
        env.gain.linearRampToValueAtTime(curve[i].gain, t0 + curve[i].t);
      }
      source.connect(env);
      env.connect(this.gain!);
      this.env = env;
    } else {
      source.connect(this.gain!);
    }

    source.onended = () => {
      // onended also fires on manual stop(); only the CURRENT source may
      // change state — a superseded source's event must be ignored.
      if (this.source !== source || !this.playing) return;
      this.playing = false;
      this.offset = this.stopAt ?? this.offset;
      this.clearTimer();
      this.clearEnvelope();
      this.onEnded?.();
    };

    if (this.stopAt !== null && this.stopAt > start) {
      source.start(t0, start, this.stopAt - start);
    } else {
      source.start(t0, start);
    }
    this.source = source;
    this.startedAt = t0;
    this.playing = true;
  }

  pause(): number {
    const t = this.getTime();
    this.stop();
    this.offset = t;
    return t;
  }

  stop(): void {
    this.playing = false;
    this.stopSource();
    this.clearTimer();
  }

  private stopSource(): void {
    this.clearEnvelope();
    if (this.source) {
      const s = this.source;
      this.source = null;
      this.playing = false;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
      s.disconnect();
    }
  }

  /** Cancel pending fade automation and detach the envelope node. */
  private clearEnvelope(): void {
    if (this.env) {
      const e = this.env;
      this.env = null;
      try {
        e.gain.cancelScheduledValues(0);
      } catch {
        /* ignore */
      }
      e.disconnect();
    }
  }

  private clearTimer(): void {
    if (this.stopTimer !== null) {
      window.clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
