/**
 * Trackable undo/redo history for chapter edits.
 *
 * Each entry stores full before/after snapshots, so every recorded operation
 * (create / move / resize / rename / delete / apply-all-candidates) is
 * reversible without bespoke inverse logic.
 *
 * Continuous edits from one gesture (mouse drag, held arrow key, typing in a
 * title) carry the same `mergeKey` and coalesce into a single entry while
 * their timestamps stay within MERGE_WINDOW_MS. Recording a new entry always
 * discards the redo stack (history branching).
 */

export interface HistoryEntry<T> {
  before: T;
  after: T;
  /** Entries with the same key within the merge window collapse into one. */
  mergeKey?: string;
  time: number;
}

export interface History<T> {
  undoStack: HistoryEntry<T>[];
  redoStack: HistoryEntry<T>[];
}

/** Pause longer than this between same-key edits ends the coalesced gesture. */
export const MERGE_WINDOW_MS = 800;
/** Maximum retained undo steps (oldest are dropped first). */
export const HISTORY_LIMIT = 200;

export function emptyHistory<T>(): History<T> {
  return { undoStack: [], redoStack: [] };
}

/**
 * Record one reversible transition. Clears the redo stack. Merges with the
 * previous entry when it shares the mergeKey and the merge window has not
 * elapsed (the earlier `before` is preserved).
 */
export function record<T>(
  h: History<T>,
  entry: HistoryEntry<T>,
  mergeWindowMs = MERGE_WINDOW_MS,
  limit = HISTORY_LIMIT,
): History<T> {
  let undoStack = h.undoStack;
  const top = undoStack[undoStack.length - 1];
  if (
    entry.mergeKey !== undefined &&
    top?.mergeKey === entry.mergeKey &&
    entry.time - top.time <= mergeWindowMs
  ) {
    undoStack = [
      ...undoStack.slice(0, -1),
      { before: top.before, after: entry.after, mergeKey: entry.mergeKey, time: entry.time },
    ];
  } else {
    undoStack = [...undoStack, entry];
    if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
  }
  // any new edit branches off the current state: redo stack is discarded
  return { undoStack, redoStack: [] };
}

/** Step back; returns the restored state, or null when nothing to undo. */
export function undo<T>(h: History<T>): { history: History<T>; state: T } | null {
  const entry = h.undoStack[h.undoStack.length - 1];
  if (!entry) return null;
  return {
    history: {
      undoStack: h.undoStack.slice(0, -1),
      redoStack: [...h.redoStack, entry],
    },
    state: entry.before,
  };
}

/** Step forward; returns the restored state, or null when nothing to redo. */
export function redo<T>(h: History<T>): { history: History<T>; state: T } | null {
  const entry = h.redoStack[h.redoStack.length - 1];
  if (!entry) return null;
  return {
    history: {
      undoStack: [...h.undoStack, entry],
      redoStack: h.redoStack.slice(0, -1),
    },
    state: entry.after,
  };
}
