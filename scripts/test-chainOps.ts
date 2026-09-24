import {
  chainMoveChapter,
  chainResizeChapter,
  planChainEdit,
  stopLabel,
  describeLimit,
} from '../src/utils/chainOps';
import type { Chapter } from '../src/types';

const D = 100; // duration
const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
let failures = 0;
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`FAIL ${msg}: expected ${e}, got ${a}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function ok(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${msg}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
/** 从结果中抽取每章的 [start,end]，便于断言。 */
function bounds(r: ReturnType<typeof chainMoveChapter>) {
  if (!r) return null;
  return r.chapters.map((c) => [c.start, c.end]);
}
const lock = (...ids: string[]) => new Set(ids);

// ===================== chain move =====================

// --- 向右拖动：后续未锁定章节整体平移，间隔与时长不变 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 35, 40)];
  const r = chainMoveChapter(cs, lock(), 'a', 5, D, 0, true)!;
  eq(
    bounds(r),
    [
      [5, 15],
      [25, 35],
      [40, 45],
    ],
    'move right ripples to all followers, gaps preserved (10 / 5)',
  );
  eq(r.delta, 5, 'move applied delta +5');
  eq(r.clipped, false, 'move not clipped');
  eq(r.movedIds, ['a', 'b', 'c'], 'all three chapters moved together');
}

// --- 向左拖动：只移动串，不能穿过前序章节（本例开头） ---
{
  const cs = [mk('a', 5, 10), mk('b', 20, 30)];
  const r = chainMoveChapter(cs, lock(), 'a', -8, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 5],
      [15, 25],
    ],
    'move left clamps at audio start',
  );
  ok(r.clipped && r.reason === 'audio-start', 'clip reason audio-start');
}

// --- 锁定章节阻止连锁：后续未锁章节不被带动，整串钳到锁定章节起点 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 35, 50)];
  // a 与锁定的 b 之间有 10s 空隙：请求 +15，只能移 +10（a 末端贴到 b 起点）
  const r = chainMoveChapter(cs, lock('b'), 'a', 15, D, 0, true)!;
  eq(
    bounds(r),
    [
      [10, 20],
      [20, 30],
      [35, 50],
    ],
    'ripple stops at locked b; c beyond the lock stays put',
  );
  ok(r.clipped && r.reason === 'locked-chapter', 'clip reason locked-chapter');
  eq(r.movedIds, ['a'], 'only anchor moves (b is lock, c past lock excluded)');
  eq(r.stop && stopLabel(r.stop), '锁定章节「b」', 'stop names the locked chapter');
}

// --- 锁定章节之后的未锁定章节即便有空隙也不参与连锁 ---
{
  const cs = [mk('a', 0, 10), mk('L', 20, 25), mk('b', 30, 40)];
  const r = chainMoveChapter(cs, lock('L'), 'a', 2, D, 0, true)!;
  eq(
    bounds(r),
    [
      [2, 12],
      [20, 25],
      [30, 40],
    ],
    'unlocked chapter past a locked one is not in the run',
  );
}

// --- 中间未锁定章节被拖动：带动其后章节，其前章节不动 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 40, 50)];
  const r = chainMoveChapter(cs, lock(), 'b', 25, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 10],
      [25, 35],
      [45, 55],
    ],
    'moving middle chapter ripples only forward',
  );
}

// --- 向左移动时不能穿过紧邻的前序章节（间隔为 0） ---
{
  const cs = [mk('a', 0, 10), mk('b', 10, 20), mk('c', 30, 40)];
  const r = chainMoveChapter(cs, lock(), 'b', 5, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 10],
      [10, 20],
      [30, 40],
    ],
    'move left blocked by preceding chapter end',
  );
  ok(r.clipped && r.reason === 'neighbor', 'clip reason neighbor');
}

// --- 音频结尾止点：整串末端钳到 duration ---
{
  const cs = [mk('a', 80, 90), mk('b', 95, 100)];
  // 串末端已在 100，任何右移都被钳为 0
  const r = chainMoveChapter(cs, lock(), 'a', 85, D, 0, true)!;
  eq(
    bounds(r),
    [
      [80, 90],
      [95, 100],
    ],
    'move right clamps run end at audio duration',
  );
  ok(r.clipped && r.reason === 'audio-end', 'clip reason audio-end');
  eq(r.stop?.kind, 'audio-end', 'stop is audio-end');
  eq(r.limitAt, D, 'wall coordinate is duration');
}

// ===================== chain resize =====================

// --- 右边缘向右：连带后续未锁定章节，锚点变长，间隔不变 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 35, 40)];
  const r = chainResizeChapter(cs, lock(), 'a', 'end', 15, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 15],
      [25, 35],
      [40, 45],
    ],
    'resize end +5 grows anchor and shifts followers by +5',
  );
  eq(r.delta, 5, 'resize ripple delta +5');
  eq(r.movedIds, ['a', 'b', 'c'], 'resize moves anchor and followers');
}

// --- 右边缘向左：锚点缩短，后续章节跟着左移（间隔不变） ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30)];
  const r = chainResizeChapter(cs, lock(), 'a', 'end', 7, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 7],
      [17, 27],
    ],
    'resize end -3 shrinks anchor and pulls followers left',
  );
}

// --- 右边缘受锁定章节阻挡 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30)];
  // 空隙 10s：请求终点 25（+15），最多 +10 贴到 b 起点
  const r = chainResizeChapter(cs, lock('b'), 'a', 'end', 25, D, 0, true)!;
  eq(
    bounds(r),
    [
      [0, 20],
      [20, 30],
    ],
    'resize end blocked by locked follower',
  );
  ok(r.clipped && r.reason === 'locked-chapter', 'resize clip reason locked-chapter');
  eq(r.movedIds, ['a'], 'locked follower does not move');
}

// --- 右边缘受音频结尾阻挡（串末端） ---
{
  const cs = [mk('a', 80, 90), mk('b', 95, 100)];
  const r = chainResizeChapter(cs, lock(), 'a', 'end', 92, D, 0, true)!;
  eq(
    bounds(r),
    [
      [80, 90],
      [95, 100],
    ],
    'resize end blocked by audio end through the run',
  );
  ok(r.clipped && r.reason === 'audio-end', 'resize clip reason audio-end');
}

// --- 右边缘不能短于最小时长（连带的后续章节随 -9.8 整体左移，间隔保持） ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = chainResizeChapter(cs, lock(), 'a', 'end', 10.1, D, 0, true)!;
  eq(bounds(r)![0], [10, 10.2], 'resize end enforces 0.2s minimum (anchor start fixed)');
  ok(r.clipped && r.reason === 'min-duration', 'resize clip reason min-duration');
  // 连锁仍然保持间隔：b 从 [30,40] 左移 9.8 -> [20.2,30.2]，与 a 间隔仍为 10
  eq(bounds(r)![1], [20.2, 30.2], 'followers shift with the shrink, gap preserved at 10s');
}

// --- 左边缘调整只动本章节起点，任何模式下都不连带后续 ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const r = chainResizeChapter(cs, lock(), 'a', 'start', 12, D, 0, true)!;
  eq(
    bounds(r),
    [
      [12, 20],
      [30, 40],
    ],
    'resize start never ripples forward',
  );
  eq(r.movedIds, ['a'], 'only anchor in movedIds');
}

// --- 左边缘不能穿越前序章节 ---
{
  const cs = [mk('a', 0, 10), mk('b', 10, 20)];
  const r = chainResizeChapter(cs, lock(), 'b', 'start', 5, D, 0, true)!;
  eq(bounds(r)![1], [10, 20], 'resize start blocked at prev chapter end');
  ok(r.clipped && r.reason === 'neighbor', 'resize-start clip reason neighbor');
}

// --- 左边缘不能短于最小时长（右侧无前序章节时） ---
{
  const cs = [mk('a', 10, 20)];
  const r = chainResizeChapter(cs, lock(), 'a', 'start', 19.95, D, 0, true)!;
  eq(bounds(r)![0], [19.8, 20], 'resize start enforces minimum duration');
  ok(r.clipped && r.reason === 'min-duration', 'resize-start clip reason min-duration');
}

// ===================== locks =====================

// --- 锁定章节不能被移动/缩放（任何模式） ---
{
  const cs = [mk('a', 0, 10)];
  eq(chainMoveChapter(cs, lock('a'), 'a', 5, D, 0, true), null, 'locked move returns null');
  eq(chainResizeChapter(cs, lock('a'), 'a', 'end', 8, D, 0, true), null, 'locked resize returns null');
  eq(chainMoveChapter(cs, lock('a'), 'a', 5, D, 0, false), null, 'locked move null even with follow off');
}

// --- 关闭连锁 follow=false：单章编辑，不带动后续，仍被相邻章节钳制 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 35, 40)];
  const r = chainMoveChapter(cs, lock(), 'a', 5, D, 0, false)!;
  eq(
    bounds(r),
    [
      [5, 15],
      [20, 30],
      [35, 40],
    ],
    'follow=false moves only the anchor',
  );
  eq(r.movedIds, ['a'], 'no followers when chain disabled');
}

// --- 非连锁下相邻章节仍是硬边界 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30)];
  const r = chainMoveChapter(cs, lock(), 'a', 15, D, 0, false)!;
  eq(bounds(r)![0], [10, 20], 'follow=false clamped at next chapter');
  ok(r.clipped && r.reason === 'neighbor', 'follow=false reports neighbor clip');
}

// ===================== plan / messages =====================

// --- plan：返回后续章节与两侧空间 ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('L', 40, 50), mk('c', 55, 60)];
  const p = planChainEdit(cs, lock('L'), 'a', D, 'move')!;
  eq(
    p.followers.map((f) => f.id),
    ['b'],
    'plan followers stop before locked chapter',
  );
  eq(p.maxForward, 10, 'plan forward room = L.start - runEnd = 40 - 30');
  eq(p.forwardStop.kind, 'locked-chapter', 'plan forward stop is the lock');
  eq(p.maxBackward, 0, 'plan backward room zero at audio start');
}

// --- plan 对锁定章节返回 null ---
{
  const cs = [mk('a', 0, 10)];
  eq(planChainEdit(cs, lock('a'), 'a', D, 'move'), null, 'plan null for locked chapter');
}

// --- 提示文案覆盖所有原因 ---
{
  ok(describeLimit('locked-chapter', { kind: 'locked-chapter', id: 'b', title: 'B' }).includes('B'), 'locked message names chapter');
  ok(describeLimit('audio-end').includes('音频结尾'), 'audio-end message');
  ok(describeLimit('audio-start').includes('音频开头'), 'audio-start message');
  ok(describeLimit('neighbor', { kind: 'chapter', id: 'c', title: 'C' }).includes('C'), 'neighbor message names chapter');
  ok(describeLimit('min-duration').includes('0.2'), 'min-duration message mentions 0.2s');
}

// ===================== 不变量：任何结果都不重叠 =====================

// --- 随机压力：随机锁定/拖动后章节两两不重叠 ---
{
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let violations = 0;
  for (let trial = 0; trial < 300; trial++) {
    // build non-overlapping chapters
    const n = 2 + Math.floor(rand() * 5);
    const cs: Chapter[] = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      t += rand() * 4;
      const len = 1 + rand() * 8;
      cs.push(mk(`c${i}`, t, Math.min(D, t + len)));
      t += len;
      if (t >= D - 2) break;
    }
    const locked = new Set<string>();
    cs.forEach((c) => {
      if (rand() < 0.3) locked.add(c.id);
    });
    const id = cs[Math.floor(rand() * cs.length)].id;
    const target = rand() * D;
    const useResize = rand() < 0.4;
    const r = useResize
      ? chainResizeChapter(cs, locked, id, rand() < 0.5 ? 'start' : 'end', target, D, 0.3, true)
      : chainMoveChapter(cs, locked, id, target, D, 0.3, true);
    if (!r) continue;
    const list = [...r.chapters].sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end - 1e-6) violations++;
    }
    for (const c of list) {
      if (c.start < -1e-6 || c.end > D + 1e-6) violations++;
      if (c.end - c.start < 0.2 - 1e-6) violations++;
    }
  }
  ok(violations === 0, `300 random chain edits: no overlap / out-of-bounds / too-short chapters (${violations} violations)`);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
