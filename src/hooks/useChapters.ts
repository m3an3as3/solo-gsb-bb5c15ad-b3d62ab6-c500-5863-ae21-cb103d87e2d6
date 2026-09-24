import { useCallback, useMemo, useRef, useState } from 'react';
import type { Chapter } from '../types';
import { uid } from '../utils/time';
import { createChapterInGap, findFreeGap, sorted } from '../utils/chapterOps';
import {
  chainMoveChapter,
  chainResizeChapter,
  type ChainEditResult,
} from '../utils/chainOps';
import { emptyHistory, record, undo as undoStep, redo as redoStep, type History } from '../utils/history';

export type { ChainEditResult } from '../utils/chainOps';

function sameChapter(a: Chapter, b: Chapter): boolean {
  return a.id === b.id && a.title === b.title && a.start === b.start && a.end === b.end;
}

function chaptersEqual(a: Chapter[], b: Chapter[]): boolean {
  if (a === b || a.length !== b.length) return a === b;
  return a.every((c, i) => sameChapter(c, b[i]));
}

export function useChapters(duration: number) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 连锁移动模式开关（仅当前会话）
  const [chainMode, setChainMode] = useState(false);
  // 锁定章节 id 集合：不写入章节数据、不导出、随导入重置，仅当前会话有效
  const [lockedIds, setLockedIds] = useState<ReadonlySet<string>>(new Set());
  // mirror of `chapters` so commits can read fresh state without putting
  // history side effects inside a setState updater (StrictMode-safe)
  const chaptersRef = useRef<Chapter[]>(chapters);
  const lockedRef = useRef<ReadonlySet<string>>(lockedIds);
  const chainRef = useRef(chainMode);
  chainRef.current = chainMode;
  const historyRef = useRef<History<Chapter[]>>(emptyHistory<Chapter[]>());

  /**
   * Apply a new chapter list and record it as one reversible step. Edits
   * carrying the same mergeKey within the merge window collapse into one
   * step (mouse drag, held nudge key, typing a title). No-op transitions
   * are not recorded.
   */
  const commit = useCallback((next: Chapter[], mergeKey?: string) => {
    const prev = chaptersRef.current;
    if (chaptersEqual(prev, next)) return;
    historyRef.current = record(historyRef.current, {
      before: prev,
      after: next,
      mergeKey,
      time: Date.now(),
    });
    chaptersRef.current = next;
    setChapters(next);
  }, []);

  const addChapter = useCallback(
    (start: number, end: number, title?: string): string => {
      const id = uid();
      const n = chaptersRef.current.length + 1;
      commit([...chaptersRef.current, { id, title: title ?? `章节 ${n}`, start, end }]);
      setSelectedId(id);
      return id;
    },
    [commit],
  );

  /** Append several chapters at once, as a single undoable step (apply all). */
  const addMany = useCallback(
    (ranges: { start: number; end: number }[]) => {
      if (ranges.length === 0) return;
      const prev = chaptersRef.current;
      const next = [...prev];
      ranges.forEach((r, i) => {
        next.push({
          id: uid(),
          title: `章节 ${prev.length + i + 1}`,
          start: r.start,
          end: r.end,
        });
      });
      commit(next);
    },
    [commit],
  );

  /**
   * Replace the whole chapter list in one transaction (chapter-file import).
   * The caller must build `next` up-front and guarantee it is sorted and
   * non-overlapping; this performs no partial writes — either the complete
   * list is committed as a single undoable step or the function throws before
   * touching any state.
   */
  const replaceAll = useCallback(
    (next: Chapter[]) => {
      if (chaptersEqual(chaptersRef.current, next)) return;
      for (let i = 1; i < next.length; i++) {
        if (next[i].start < next[i - 1].end - 1e-6) {
          throw new Error('章节列表存在重叠，导入已中止。');
        }
      }
      commit(next);
    },
    [commit],
  );

  /** Create from a drag range; returns new id or null if no room. */
  const createFromDrag = useCallback(
    (a: number, b: number, snapThreshold: number): string | null => {
      const range = createChapterInGap(chaptersRef.current, a, b, duration, snapThreshold);
      if (!range) return null;
      return addChapter(range.start, range.end);
    },
    [duration, addChapter],
  );

  /** Create a chapter of default length at the playhead. */
  const createAtPlayhead = useCallback(
    (at: number, len = 5): string | null => {
      const gap = findFreeGap(chaptersRef.current, at, len, duration);
      if (!gap) return null;
      return addChapter(gap.start, gap.end);
    },
    [duration, addChapter],
  );

  /**
   * Move a chapter. In chain mode the boundary shift ripples to subsequent
   * unlocked chapters. Returns the edit outcome (including any clipping
   * reason for the UI), 'locked' when the target is locked, or null when
   * nothing happened. The whole gesture (drag / repeated nudges) keeps one
   * mergeKey, so it is a single undo step that restores every follower.
   * follow=false 退化为单章编辑，钳制/吸附与传统行为完全一致，只是顺带返回
   * 钳制原因用于统一提示。
   */
  const move = useCallback(
    (id: string, desiredStart: number, snapThreshold: number): ChainEditResult | 'locked' | null => {
      if (lockedRef.current.has(id)) return 'locked';
      const r = chainMoveChapter(
        chaptersRef.current,
        lockedRef.current,
        id,
        desiredStart,
        duration,
        snapThreshold,
        chainRef.current,
      );
      if (!r) return 'locked';
      commit(r.chapters, `move:${id}`);
      return r;
    },
    [duration, commit],
  );

  const resize = useCallback(
    (
      id: string,
      edge: 'start' | 'end',
      desired: number,
      snapThreshold: number,
    ): ChainEditResult | 'locked' | null => {
      if (lockedRef.current.has(id)) return 'locked';
      const r = chainResizeChapter(
        chaptersRef.current,
        lockedRef.current,
        id,
        edge,
        desired,
        duration,
        snapThreshold,
        chainRef.current,
      );
      if (!r) return 'locked';
      commit(r.chapters, `resize:${id}:${edge}`);
      return r;
    },
    [duration, commit],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      // keystrokes in one editing run form a single undo step
      commit(
        chaptersRef.current.map((c) => (c.id === id ? { ...c, title } : c)),
        `rename:${id}`,
      );
    },
    [commit],
  );

  const remove = useCallback((id: string) => {
    commit(chaptersRef.current.filter((c) => c.id !== id));
    // drop the session lock of the removed chapter
    lockedRef.current = new Set([...lockedRef.current].filter((x) => x !== id));
    setLockedIds(lockedRef.current);
    setSelectedId((sel) => (sel === id ? null : sel));
  }, [commit]);

  /** Toggle the session-only lock of a chapter. Lock state is never exported. */
  const toggleLock = useCallback((id: string) => {
    setLockedIds((prevSet) => {
      const nextSet = new Set(prevSet);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      lockedRef.current = nextSet;
      return nextSet;
    });
  }, []);

  const unlockAll = useCallback(() => {
    lockedRef.current = new Set();
    setLockedIds(new Set());
  }, []);

  const toggleChainMode = useCallback(() => setChainMode((m) => !m), []);

  /** Restore the previous chapter state. Playback/locks are never touched. */
  const undo = useCallback(() => {
    const result = undoStep(historyRef.current);
    if (!result) return;
    historyRef.current = result.history;
    chaptersRef.current = result.state;
    setChapters(result.state);
    setSelectedId((sel) =>
      sel && result.state.some((c) => c.id === sel) ? sel : null,
    );
  }, []);

  /** Re-apply the next chapter state. Playback/locks are never touched. */
  const redo = useCallback(() => {
    const result = redoStep(historyRef.current);
    if (!result) return;
    historyRef.current = result.history;
    chaptersRef.current = result.state;
    setChapters(result.state);
    setSelectedId((sel) =>
      sel && result.state.some((c) => c.id === sel) ? sel : null,
    );
  }, []);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  /** New audio import: drop chapters, session locks and edit history. */
  const reset = useCallback(() => {
    historyRef.current = emptyHistory<Chapter[]>();
    chaptersRef.current = [];
    lockedRef.current = new Set();
    setLockedIds(new Set());
    setChapters([]);
    setSelectedId(null);
  }, []);

  const selected = useMemo(
    () => chapters.find((c) => c.id === selectedId) ?? null,
    [chapters, selectedId],
  );

  const sortedChapters = useMemo(() => sorted(chapters), [chapters]);

  // history mutations always accompany a chapters render, so reading the ref
  // here keeps the toolbar disabled state in sync
  const canUndo = historyRef.current.undoStack.length > 0;
  const canRedo = historyRef.current.redoStack.length > 0;

  return {
    chapters,
    sortedChapters,
    selected,
    selectedId,
    select,
    addChapter,
    addMany,
    replaceAll,
    createFromDrag,
    createAtPlayhead,
    move,
    resize,
    rename,
    remove,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
    chainMode,
    toggleChainMode,
    lockedIds,
    toggleLock,
    unlockAll,
  };
}

export type ChaptersApi = ReturnType<typeof useChapters>;
