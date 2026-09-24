import {
  DEFAULT_FADE,
  MAX_FADE_SEC,
  buildFadeCurve,
  clampFade,
  fitFadeTimes,
} from '../src/audio/fade';

let failures = 0;
function ok(cond: boolean, msg: string) {
  if (cond) console.log(`ok ${msg}`);
  else {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function near(actual: number, expected: number, msg: string, tol = 1e-9) {
  if (Math.abs(actual - expected) > tol) {
    failures++;
    console.error(`FAIL ${msg}: expected ~${expected}, got ${actual}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
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

// ---- clampFade ----
near(clampFade(2.5), 2.5, 'clampFade keeps in-range value');
near(clampFade(-1), 0, 'clampFade floors at 0');
near(clampFade(99), MAX_FADE_SEC, 'clampFade caps at MAX_FADE_SEC');
near(clampFade(NaN), 0, 'clampFade maps NaN to 0');
near(clampFade(Infinity), 0, 'clampFade maps Infinity to 0');
ok(MAX_FADE_SEC === 5, 'fade range is 0..5s');
ok(DEFAULT_FADE.enabled === false, 'fade preview defaults to off (original preview)');

// ---- fitFadeTimes ----
eq(fitFadeTimes(1, 2, 10), { fadeIn: 1, fadeOut: 2 }, 'fades that fit are kept as-is');
{
  // 4 + 6 = 10s of fades into a 5s chapter -> scaled by 5/10
  const f = fitFadeTimes(4, 5, 3);
  near(f.fadeIn + f.fadeOut, 3, 'compressed fades exactly tile the chapter');
  near(f.fadeIn / f.fadeOut, 4 / 5, 'compression is proportional to the sum');
  near(f.fadeIn, 3 * (4 / 9), 'fade-in scaled by length/sum');
}
eq(fitFadeTimes(0, 0, 10), { fadeIn: 0, fadeOut: 0 }, 'zero fades stay zero');
eq(fitFadeTimes(2, 2, 0), { fadeIn: 0, fadeOut: 0 }, 'zero-length segment kills fades');
eq(fitFadeTimes(2, 2, -1), { fadeIn: 0, fadeOut: 0 }, 'negative length is safe');
{
  const f = fitFadeTimes(5, 0, 2);
  near(f.fadeIn, 2, 'lone fade-in compresses to the whole segment');
  near(f.fadeOut, 0, 'zero fade-out untouched');
}

// ---- buildFadeCurve ----
{
  const c = buildFadeCurve(1, 2, 10);
  eq(c, [
    { t: 0, gain: 0 },
    { t: 1, gain: 1 },
    { t: 8, gain: 1 },
    { t: 10, gain: 0 },
  ], 'curve: up over fade-in, hold, down to silence at segment end');
}
{
  const c = buildFadeCurve(0, 0, 10);
  eq(c, [{ t: 0, gain: 1 }], 'no fades -> single constant point (envelope skipped)');
}
{
  const c = buildFadeCurve(0, 1.5, 4);
  eq(c, [
    { t: 0, gain: 1 },
    { t: 2.5, gain: 1 },
    { t: 4, gain: 0 },
  ], 'fade-out only: hold then ramp to 0 at the end');
}
{
  const c = buildFadeCurve(2, 0, 4);
  eq(c, [
    { t: 0, gain: 0 },
    { t: 2, gain: 1 },
    { t: 4, gain: 1 },
  ], 'fade-in only: ramp from silence then hold to the end');
}
{
  // fades exactly tiling the segment: the zero-length hold collapses
  const c = buildFadeCurve(5, 5, 4);
  eq(c, [
    { t: 0, gain: 0 },
    { t: 2, gain: 1 },
    { t: 4, gain: 0 },
  ], 'over-long fades compress proportionally, peak meets in the middle');
}
{
  const c = buildFadeCurve(3, 3, 0.2); // minimum-length chapter
  ok(c[0].t === 0 && c[0].gain === 0, 'tiny chapter starts at silence');
  ok(c[c.length - 1].t === 0.2 && c[c.length - 1].gain === 0, 'tiny chapter ends at silence');
}

// invariants over a sweep of inputs: continuous, in-bounds, never NaN
{
  let allOk = true;
  for (const fi of [0, 0.1, 1, 2.7, 5, 7, NaN]) {
    for (const fo of [0, 0.5, 3, 5, 9]) {
      for (const L of [0, 0.2, 1, 4.2, 30]) {
        const c = buildFadeCurve(fi, fo, L);
        for (let i = 0; i < c.length; i++) {
          const p = c[i];
          if (!Number.isFinite(p.t) || !Number.isFinite(p.gain)) allOk = false;
          if (p.t < -1e-9 || p.t - L > 1e-9) allOk = false; // never past the boundaries
          if (p.gain < 0 || p.gain > 1) allOk = false;
          if (i > 0 && c[i - 1].t > p.t + 1e-9) allOk = false; // monotonic time
        }
        if (fi > 0 && L > 0 && c[0].gain !== 0) allOk = false; // fade-in starts silent
        if (fo > 0 && L > 0 && c[c.length - 1].gain !== 0) allOk = false; // fade-out ends silent
        if (fo > 0 && L > 0 && Math.abs(c[c.length - 1].t - L) > 1e-9) allOk = false;
      }
    }
  }
  ok(allOk, 'curve invariants hold for the whole parameter sweep');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('all fade tests passed');
}
