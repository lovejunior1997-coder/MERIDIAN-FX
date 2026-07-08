/* ============================================================
   strategy.js — YOUR rules, in code.
   Two setups, both trend-aligned with the higher timeframe:
     A) TRENDLINE  : 3 touches; entry at 3rd LH (sell) / 3rd HL (buy)
     B) SMC BOS+ZONE: break of structure, retest of supply/demand
   Pure functions over candles [{t,o,h,l,c}]. No I/O.
   ============================================================ */

// ---------- swing points (fractal pivots) ----------
function swings(c, lb = 2) {
  const hi = [], lo = [];
  for (let i = lb; i < c.length - lb; i++) {
    let isH = true, isL = true;
    for (let j = i - lb; j <= i + lb; j++) {
      if (j === i) continue;
      if (c[j].h >= c[i].h) isH = false;
      if (c[j].l <= c[i].l) isL = false;
    }
    if (isH) hi.push({ i, p: c[i].h, t: c[i].t });
    if (isL) lo.push({ i, p: c[i].l, t: c[i].t });
  }
  return { hi, lo };
}

function atr(c, p = 14) {
  if (c.length < p + 1) return null;
  const tr = [];
  for (let i = 1; i < c.length; i++) {
    const pc = c[i - 1].c;
    tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - pc), Math.abs(c[i].l - pc)));
  }
  return tr.slice(-p).reduce((a, b) => a + b, 0) / p;
}

// ---------- market structure (HH/HL vs LH/LL) ----------
function structure(c, lb = 2) {
  const { hi, lo } = swings(c, lb);
  if (hi.length < 2 || lo.length < 2) return { bias: "neutral", hi, lo };
  const h1 = hi.at(-1).p, h0 = hi.at(-2).p;
  const l1 = lo.at(-1).p, l0 = lo.at(-2).p;
  let bias = "neutral";
  if (h1 > h0 && l1 > l0) bias = "bullish";       // higher highs + higher lows
  else if (h1 < h0 && l1 < l0) bias = "bearish";  // lower highs + lower lows
  return { bias, hi, lo };
}

// ---------- A) TRENDLINE: three touches ----------
// sell = 3 descending swing highs roughly on one line; entry at the 3rd LH
// buy  = 3 ascending swing lows roughly on one line;  entry at the 3rd HL
function trendlineSetup(c, bias, opts = {}) {
  const { tolAtr = 0.6, freshBars = 6, lb = 2 } = opts;
  const a = atr(c); if (!a) return null;
  const { hi, lo } = swings(c, lb);
  const n = c.length - 1;

  const build = (pts, dir) => {
    if (pts.length < 3) return null;
    const [A, B, C] = pts.slice(-3);
    // must be monotonic in the trend direction
    if (dir === "sell" && !(A.p > B.p && B.p > C.p)) return null;
    if (dir === "buy" && !(A.p < B.p && B.p < C.p)) return null;
    // the 3rd touch must be recent enough to act on
    if (n - C.i > freshBars) return null;
    // collinearity: project the A->B line to C's index, C must sit near it
    const slope = (B.p - A.p) / (B.i - A.i);
    const proj = A.p + slope * (C.i - A.i);
    const err = Math.abs(C.p - proj);
    if (err > a * tolAtr) return null;
    return { A, B, C, slope, err, touches: 3 };
  };

  // only ever with the higher-timeframe trend
  if (bias === "bearish") {
    const t = build(hi, "sell");
    if (!t) return null;
    const buf = a * 0.25;
    const entry = c[n].c, sl = t.C.p + buf;              // SL above the 3rd lower high
    if (sl <= entry) return null;
    return { type: "trendline", dir: "sell", entry, sl, touches: 3, anchor: t.C.p, atr: a,
             note: `3rd lower high at ${t.C.p.toFixed(5)}; descending trendline, ${t.err.toFixed(5)} off-line` };
  }
  if (bias === "bullish") {
    const t = build(lo, "buy");
    if (!t) return null;
    const buf = a * 0.25;
    const entry = c[n].c, sl = t.C.p - buf;              // SL below the 3rd higher low
    if (sl >= entry) return null;
    return { type: "trendline", dir: "buy", entry, sl, touches: 3, anchor: t.C.p, atr: a,
             note: `3rd higher low at ${t.C.p.toFixed(5)}; ascending trendline, ${t.err.toFixed(5)} off-line` };
  }
  return null;
}

// ---------- B) SMC: break of structure + zone retest ----------
// bull: close breaks the last swing high -> demand zone = last down-candle before the impulse
//       setup fires when price returns into that zone
function bosZoneSetup(c, bias, opts = {}) {
  const { lookback = 25, lb = 2 } = opts;
  const a = atr(c); if (!a) return null;
  const { hi, lo } = swings(c, lb);
  const n = c.length - 1, last = c[n];

  if (bias === "bullish" && hi.length) {
    const sh = hi.at(-1);
    let bi = -1;                                          // break candle index
    for (let i = sh.i + 1; i <= n; i++) if (c[i].c > sh.p) { bi = i; break; }
    if (bi < 0) return null;
    let zi = -1;                                          // last bearish candle before the impulse
    for (let i = bi; i >= Math.max(0, bi - lookback); i--) if (c[i].c < c[i].o) { zi = i; break; }
    if (zi < 0) return null;
    const zone = { lo: c[zi].l, hi: c[zi].h };
    const retest = last.l <= zone.hi && last.c >= zone.lo; // price came back into demand
    if (!retest) return null;
    const entry = last.c, sl = zone.lo - a * 0.25;
    if (sl >= entry) return null;
    return { type: "smc", dir: "buy", entry, sl, atr: a, zone,
             note: `bullish BOS above ${sh.p.toFixed(5)}, retesting demand ${zone.lo.toFixed(5)}-${zone.hi.toFixed(5)}` };
  }

  if (bias === "bearish" && lo.length) {
    const sl_ = lo.at(-1);
    let bi = -1;
    for (let i = sl_.i + 1; i <= n; i++) if (c[i].c < sl_.p) { bi = i; break; }
    if (bi < 0) return null;
    let zi = -1;                                          // last bullish candle before the down impulse
    for (let i = bi; i >= Math.max(0, bi - lookback); i--) if (c[i].c > c[i].o) { zi = i; break; }
    if (zi < 0) return null;
    const zone = { lo: c[zi].l, hi: c[zi].h };
    const retest = last.h >= zone.lo && last.c <= zone.hi; // price came back up into supply
    if (!retest) return null;
    const entry = last.c, sl = zone.hi + a * 0.25;
    if (sl <= entry) return null;
    return { type: "smc", dir: "sell", entry, sl, atr: a, zone,
             note: `bearish BOS below ${sl_.p.toFixed(5)}, retesting supply ${zone.lo.toFixed(5)}-${zone.hi.toFixed(5)}` };
  }
  return null;
}

// ---------- combine: HTF bias -> LTF entry ----------
function findSetups({ htf, ltf, rr = 3, minRR = 2 }) {
  const { bias } = structure(htf);                        // daily/4H directional bias
  if (bias === "neutral") return { bias, setups: [] };

  const out = [];
  for (const fn of [trendlineSetup, bosZoneSetup]) {
    const s = fn(ltf, bias);
    if (!s) continue;
    const risk = Math.abs(s.entry - s.sl);
    if (!risk) continue;
    const tp = s.dir === "sell" ? s.entry - risk * rr : s.entry + risk * rr;
    const stopPct = (risk / s.entry) * 100;
    if (rr < minRR) continue;
    out.push({ ...s, tp, rr, risk, stopPct: +stopPct.toFixed(3), htfBias: bias });
  }
  return { bias, setups: out };
}

/* ------------------------------------------------------------
   STATE REPORTERS — describe the chart, don't just trigger.
   Used to brief Claude in the trader's own framework.
------------------------------------------------------------ */

// how many aligned touches has the trendline formed, and where is the line now?
function trendlineState(c, bias, opts = {}) {
  const { tolAtr = 0.6, lb = 2 } = opts;
  const a = atr(c); if (!a) return null;
  const { hi, lo } = swings(c, lb);
  const pts = bias === "bearish" ? hi : bias === "bullish" ? lo : null;
  if (!pts || pts.length < 2) return null;
  const desc = bias === "bearish";
  const recent = pts.slice(-4);

  let best = null;
  for (let s = 0; s < recent.length - 1; s++) {
    const A = recent[s], B = recent[s + 1];
    if (desc ? !(A.p > B.p) : !(A.p < B.p)) continue;
    const slope = (B.p - A.p) / (B.i - A.i);
    let touches = 2, maxErr = 0, prev = B.p;
    for (let k = s + 2; k < recent.length; k++) {
      const P = recent[k];
      const monotonic = desc ? P.p < prev : P.p > prev;
      const err = Math.abs(P.p - (A.p + slope * (P.i - A.i)));
      if (monotonic && err <= a * tolAtr) { touches++; maxErr = Math.max(maxErr, err); prev = P.p; }
      else break;
    }
    if (!best || touches > best.touches) best = { A, B, slope, touches, maxErr };
  }
  if (!best) return null;
  const n = c.length - 1;
  const linePrice = best.A.p + best.slope * (n - best.A.i);
  return {
    touches: best.touches,
    linePrice: +linePrice.toFixed(6),
    lastSwing: +pts.at(-1).p.toFixed(6),
    distanceATR: +(Math.abs(c[n].c - linePrice) / a).toFixed(2),
    ready: best.touches >= 3,
    direction: desc ? "descending (lower highs)" : "ascending (higher lows)",
  };
}

// has structure broken, and where is the origin zone?
function bosState(c, bias, opts = {}) {
  const { lb = 2, lookback = 25 } = opts;
  const a = atr(c); if (!a) return null;
  const { hi, lo } = swings(c, lb);
  const n = c.length - 1, last = c[n];

  const pack = (broke, level, zi, kind) => {
    if (zi < 0) return { bos: broke, brokeLevel: +level.toFixed(6), zone: null };
    const zone = { lo: +c[zi].l.toFixed(6), hi: +c[zi].h.toFixed(6) };
    const inZone = last.l <= zone.hi && last.h >= zone.lo;
    const gap = kind === "demand" ? last.c - zone.hi : zone.lo - last.c;
    return { bos: broke, brokeLevel: +level.toFixed(6), zone, kind, inZone,
             distanceATR: +(Math.max(gap, 0) / a).toFixed(2) };
  };

  if (bias === "bullish" && hi.length) {
    const sh = hi.at(-1);
    let bi = -1; for (let i = sh.i + 1; i <= n; i++) if (c[i].c > sh.p) { bi = i; break; }
    if (bi < 0) return { bos: false, watchLevel: +sh.p.toFixed(6), note: "no bullish BOS yet" };
    let zi = -1; for (let i = bi; i >= Math.max(0, bi - lookback); i--) if (c[i].c < c[i].o) { zi = i; break; }
    return pack(true, sh.p, zi, "demand");
  }
  if (bias === "bearish" && lo.length) {
    const sl = lo.at(-1);
    let bi = -1; for (let i = sl.i + 1; i <= n; i++) if (c[i].c < sl.p) { bi = i; break; }
    if (bi < 0) return { bos: false, watchLevel: +sl.p.toFixed(6), note: "no bearish BOS yet" };
    let zi = -1; for (let i = bi; i >= Math.max(0, bi - lookback); i--) if (c[i].c > c[i].o) { zi = i; break; }
    return pack(true, sl.p, zi, "supply");
  }
  return null;
}

// everything Claude needs to read the chart the way you do
function chartBrief(htf, ltf) {
  const H = structure(htf), L = structure(ltf);
  const a = atr(ltf);
  const n = ltf.length - 1;
  return {
    htfBias: H.bias,
    htfSwingHighs: H.hi.slice(-3).map(x => +x.p.toFixed(6)),
    htfSwingLows: H.lo.slice(-3).map(x => +x.p.toFixed(6)),
    ltfBias: L.bias,
    ltfSwingHighs: L.hi.slice(-4).map(x => +x.p.toFixed(6)),
    ltfSwingLows: L.lo.slice(-4).map(x => +x.p.toFixed(6)),
    price: +ltf[n].c.toFixed(6),
    atr: a ? +a.toFixed(6) : null,
    trendline: trendlineState(ltf, H.bias),
    smc: bosState(ltf, H.bias),
  };
}

module.exports = { swings, structure, atr, trendlineSetup, bosZoneSetup, findSetups,
                   trendlineState, bosState, chartBrief };

