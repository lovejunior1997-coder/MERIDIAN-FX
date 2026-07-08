/* ============================================================
   backtest.js — walk-forward test of YOUR rules.

   Honest by construction:
   - No lookahead. At bar i the detector sees ltf[0..i] only,
     and daily candles dated at or before bar i.
   - Entry at the close of the signal bar (what you could actually get).
   - Management starts the NEXT bar.
   - If a bar's range contains BOTH the stop and the target, we assume
     the STOP filled first. Pessimistic on purpose — the alternative
     flatters every result you'll ever see.
   - Optional spread cost applied to entry.
   Results are in R (multiples of the risk taken), so they're
   comparable across pairs and position sizes.
   ============================================================ */

const { findSetups } = require("./strategy");

const T = (c) => (typeof c.t === "string" ? Date.parse(c.t) : Number(c.t));

function backtest({ htf, ltf, rr = 3, warmup = 60, cooldownBars = 5, spread = 0, maxBars = 0 }) {
  const trades = [];
  let open = null, lastEntry = -1e9;

  for (let i = warmup; i < ltf.length; i++) {
    const bar = ltf[i];

    // ---- manage an open trade (starting the bar AFTER entry) ----
    if (open && i > open.entryBar) {
      const hitSL = open.dir === "sell" ? bar.h >= open.sl : bar.l <= open.sl;
      const hitTP = open.dir === "sell" ? bar.l <= open.tp : bar.h >= open.tp;
      let exit = null, why = null;
      if (hitSL) { exit = open.sl; why = "SL"; }          // stop checked first: pessimistic
      else if (hitTP) { exit = open.tp; why = "TP"; }
      else if (maxBars && i - open.entryBar >= maxBars) { exit = bar.c; why = "TIME"; }

      if (exit != null) {
        const risk = Math.abs(open.entry - open.sl);
        const raw = open.dir === "sell" ? open.entry - exit : exit - open.entry;
        trades.push({
          pair: open.pair, type: open.type, dir: open.dir, htfBias: open.htfBias,
          entry: open.entry, sl: open.sl, tp: open.tp, exit, why,
          entryTime: open.entryTime, exitTime: T(bar),
          bars: i - open.entryBar,
          r: +(raw / risk).toFixed(3),
        });
        open = null;
        lastEntry = i;
        continue;                                         // no re-entry on the exit bar
      }
      continue;                                           // still in the trade
    }

    if (open) continue;
    if (i - lastEntry < cooldownBars) continue;

    // ---- look for a setup using ONLY data available at bar i ----
    const hist = ltf.slice(0, i + 1);
    const htfHist = htf.filter((c) => T(c) <= T(bar));
    if (htfHist.length < 30) continue;

    let res;
    try { res = findSetups({ htf: htfHist, ltf: hist, rr }); } catch (_) { continue; }
    if (!res.setups.length) continue;

    const s = res.setups[0];
    // apply spread to the entry (cost of crossing)
    const entry = s.dir === "sell" ? s.entry - spread : s.entry + spread;
    const risk = Math.abs(entry - s.sl);
    if (!risk) continue;
    const tp = s.dir === "sell" ? entry - risk * rr : entry + risk * rr;

    open = { ...s, entry, tp, entryBar: i, entryTime: T(bar) };
  }

  return { trades, openAtEnd: open ? { type: open.type, dir: open.dir, entryTime: open.entryTime } : null };
}

// ---------- metrics, all in R ----------
function summarize(trades) {
  const n = trades.length;
  if (!n) return { trades: 0 };
  const rs = trades.map((t) => t.r);
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r <= 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const grossWin = sum(wins.map((t) => t.r)), grossLoss = Math.abs(sum(losses.map((t) => t.r)));

  let eq = 0, peak = 0, maxDD = 0;
  const curve = rs.map((r) => { eq += r; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq - peak); return +eq.toFixed(3); });

  // longest losing streak — the number that actually breaks people
  let streak = 0, worstStreak = 0;
  for (const t of trades) { if (t.r <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0; }

  return {
    trades: n,
    wins: wins.length, losses: losses.length,
    winRate: +((wins.length / n) * 100).toFixed(1),
    totalR: +sum(rs).toFixed(2),
    expectancyR: +(sum(rs) / n).toFixed(3),
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0),
    maxDrawdownR: +maxDD.toFixed(2),
    worstLosingStreak: worstStreak,
    avgBarsHeld: +(sum(trades.map((t) => t.bars)) / n).toFixed(1),
    curve,
  };
}

function byType(trades) {
  const out = {};
  for (const t of ["trendline", "smc"]) {
    const subset = trades.filter((x) => x.type === t);
    if (subset.length) out[t] = summarize(subset);
  }
  return out;
}

function byDirection(trades) {
  const out = {};
  for (const d of ["buy", "sell"]) {
    const subset = trades.filter((x) => x.dir === d);
    if (subset.length) out[d] = summarize(subset);
  }
  return out;
}

function run(opts) {
  const { trades, openAtEnd } = backtest(opts);
  return {
    params: { rr: opts.rr ?? 3, warmup: opts.warmup ?? 60, cooldownBars: opts.cooldownBars ?? 5, spread: opts.spread ?? 0, bars: opts.ltf.length },
    overall: summarize(trades),
    byType: byType(trades),
    byDirection: byDirection(trades),
    openAtEnd,
    trades,
  };
}

module.exports = { backtest, summarize, byType, byDirection, run };
