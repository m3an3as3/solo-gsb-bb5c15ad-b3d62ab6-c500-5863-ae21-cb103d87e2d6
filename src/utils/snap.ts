/** Nearest-value snapping shared by single-chapter and chained edits. */
export function snapToValue(v: number, targets: number[], threshold: number): number {
  if (threshold <= 0) return v;
  let best = v;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(t - v);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}
