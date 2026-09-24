/** Format seconds as HH:MM:SS.mmm (WebVTT compatible). */
export function formatVttTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const whole = Math.floor(rest);
  const ms = Math.round((rest - whole) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(whole)}.${pad(ms, 3)}`;
}

/** Format seconds as H:MM:SS.d for compact UI display. */
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const tenth = Math.floor((s * 10) % 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(whole)}.${tenth}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
