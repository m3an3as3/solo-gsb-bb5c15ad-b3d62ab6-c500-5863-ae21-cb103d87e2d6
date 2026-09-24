import {
  emptyHistory,
  record,
  undo,
  redo,
  MERGE_WINDOW_MS,
  HISTORY_LIMIT,
} from '../src/utils/history';

let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${msg}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}${a === e ? '' : `: expected ${e}, got ${a}`}`);
}

// --- basic undo/redo of a recorded transition ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', time: 1 });
  const u = undo(h)!;
  check(u !== null && u.state === 'a', 'undo restores before state');
  const r = redo(u.history)!;
  check(r.state === 'b', 'redo restores after state');
}

// --- recording clears the redo stack (branching) ---
{
  let h = record(emptyHistory<string>(), { before: 'a', after: 'b', time: 1 });
  h = undo(h)!.history; // now on 'a', redo stack has one entry
  check(h.redoStack.length === 1, 'one redo entry after undo');
  h = record(h, { before: 'a', after: 'c', time: 2 });
  check(h.redoStack.length === 0, 'new edit clears redo stack');
  check(redo(h) === null, 'redo unavailable after branch');
  eq(undo(h)!.state, 'a', 'undo of branched edit reaches its before state');
}

// --- undo/redo on empty history are no-ops ---
{
  const h = emptyHistory<string>();
  check(undo(h) === null, 'undo empty returns null');
  check(redo(h) === null, 'redo empty returns null');
}

// --- same mergeKey within window coalesces, preserving earliest before ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', mergeKey: 'move:1', time: 100 });
  h = record(h, { before: 'b', after: 'c', mergeKey: 'move:1', time: 100 + 300 });
  h = record(h, { before: 'c', after: 'd', mergeKey: 'move:1', time: 100 + 600 });
  check(h.undoStack.length === 1, 'three rapid same-key edits merge into one entry');
  const u = undo(h)!;
  check(u.state === 'a', 'merged undo jumps back to gesture start');
  check(redo(u.history)!.state === 'd', 'merged redo reaches gesture end');
}

// --- merge window expiry splits entries ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', mergeKey: 'move:1', time: 100 });
  h = record(
    h,
    { before: 'b', after: 'c', mergeKey: 'move:1', time: 100 + MERGE_WINDOW_MS + 1 },
  );
  check(h.undoStack.length === 2, 'same key after pause starts a new entry');
}

// --- different mergeKeys never merge ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', mergeKey: 'move:1', time: 100 });
  h = record(h, { before: 'b', after: 'c', mergeKey: 'move:2', time: 101 });
  h = record(h, { before: 'c', after: 'd', mergeKey: 'rename:1', time: 102 });
  check(h.undoStack.length === 3, 'different keys stay separate entries');
}

// --- unkeyed entries never merge ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', time: 100 });
  h = record(h, { before: 'b', after: 'c', time: 101 });
  check(h.undoStack.length === 2, 'entries without mergeKey never coalesce');
}

// --- full multi-step walk back and forth ---
{
  let h = emptyHistory<number>();
  for (let i = 1; i <= 3; i++) h = record(h, { before: i - 1, after: i, time: i });
  let step = undo(h)!;
  eq(step.state, 2, 'undo 3 -> 2');
  step = undo(step.history)!;
  eq(step.state, 1, 'undo 2 -> 1');
  step = undo(step.history)!;
  eq(step.state, 0, 'undo 1 -> 0');
  check(undo(step.history) === null, 'nothing more to undo');
  let fwd = redo(step.history)!;
  eq(fwd.state, 1, 'redo 0 -> 1');
  fwd = redo(fwd.history)!;
  eq(fwd.state, 2, 'redo 1 -> 2');
  fwd = redo(fwd.history)!;
  eq(fwd.state, 3, 'redo 2 -> 3');
  check(redo(fwd.history) === null, 'nothing more to redo');
}

// --- history limit drops oldest entries ---
{
  let h = emptyHistory<number>();
  for (let i = 1; i <= HISTORY_LIMIT + 10; i++) {
    h = record(h, { before: i - 1, after: i, time: i });
  }
  check(h.undoStack.length === HISTORY_LIMIT, 'undo stack capped at limit');
  // oldest surviving entry is 10 -> 11
  let cur = HISTORY_LIMIT + 10;
  for (let i = 0; i < HISTORY_LIMIT; i++) {
    const s = undo(h)!;
    cur = s.state as number;
    h = s.history;
  }
  eq(cur, 10, 'oldest retained undo step restores state 10');
}

// --- custom merge window is honored ---
{
  let h = emptyHistory<string>();
  h = record(h, { before: 'a', after: 'b', mergeKey: 'k', time: 0 }, 50);
  h = record(h, { before: 'b', after: 'c', mergeKey: 'k', time: 51 }, 50);
  check(h.undoStack.length === 2, 'custom window: 51ms > 50ms splits');
  h = record(h, { before: 'c', after: 'd', mergeKey: 'k', time: 52 }, 50);
  check(h.undoStack.length === 2, 'custom window: 1ms gap merges');
}

// --- a chained drag (anchor + followers) is ONE undo step restoring every follower ---
{
  type Ch = { id: string; start: number; end: number };
  const start: Ch[] = [
    { id: 'a', start: 0, end: 10 },
    { id: 'b', start: 20, end: 30 },
    { id: 'c', start: 35, end: 40 },
  ];
  const shifted = (d: number): Ch[] => start.map((c) => ({ ...c, start: c.start + d, end: c.end + d }));
  let h = emptyHistory<Ch[]>();
  // mousemove frames during one drag all carry mergeKey `move:a`
  h = record(h, { before: start, after: shifted(1), mergeKey: 'move:a', time: 10 });
  h = record(h, { before: shifted(1), after: shifted(3), mergeKey: 'move:a', time: 20 });
  h = record(h, { before: shifted(3), after: shifted(5), mergeKey: 'move:a', time: 30 });
  check(h.undoStack.length === 1, 'chained drag coalesces into one history entry');
  const undone = undo(h)!;
  eq(undone.state, start, 'undo restores anchor AND every follower to the pre-drag layout');
  const redone = redo(undone.history)!;
  eq(redone.state, shifted(5), 'redo replays the whole chained ripple');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
