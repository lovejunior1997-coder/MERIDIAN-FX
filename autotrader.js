/* ============================================================
   autotrader.js — unattended execution of YOUR setups.

   DESIGN PRINCIPLE: the strategy proposes, the guardrails dispose.
   Claude can only ever VETO a trade. It can never create one.

   Every trade must pass, in order:
     1.  auto-trading enabled + kill switch not tripped
     2.  demo account (unless AUTO_ALLOW_LIVE=true explicitly)
     3.  inside trading session hours
     4.  daily loss limit not breached
     5.  max trades/day not reached
     6.  max open positions not reached
     7.  pair not in cooldown
     8.  R:R at or above minimum
     9.  spread acceptable
     10. Claude news/context veto (if enabled)
   Any failure = no trade, logged with the reason.
   ============================================================ */

const STATE = {
  killSwitch: false,
  killReason: "",
  day: new Date().toISOString().slice(0, 10),
  tradesToday: 0,
  realizedToday: 0,
  startBalance: null,
  cooldown: new Map(),      // pair -> timestamp of last trade
  log: [],                  // recent decisions, newest first
};

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const cfg = () => ({
  enabled: String(process.env.AUTO_TRADE || "false").toLowerCase() === "true",
  allowLive: String(process.env.AUTO_ALLOW_LIVE || "false").toLowerCase() === "true",
  riskPct: num(process.env.AUTO_RISK_PCT, 0.5),
  maxTradesDay: num(process.env.AUTO_MAX_TRADES_DAY, 3),
  maxOpen: num(process.env.AUTO_MAX_OPEN, 2),
  dailyLossPct: num(process.env.AUTO_DAILY_LOSS_PCT, 3),
  minRR: num(process.env.AUTO_MIN_RR, 2),
  maxSpreadPips: num(process.env.AUTO_MAX_SPREAD_PIPS, 3),
  cooldownMin: num(process.env.AUTO_COOLDOWN_MIN, 120),
  sessions: process.env.AUTO_SESSIONS || "07:00-20:00",  // UTC
  claudeVeto: String(process.env.AUTO_CLAUDE_VETO || "true").toLowerCase() === "true",
});

function log(entry) {
  STATE.log.unshift({ ts: new Date().toISOString(), ...entry });
  STATE.log = STATE.log.slice(0, 200);
}

function rollDay(balance) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== STATE.day) {
    STATE.day = today; STATE.tradesToday = 0; STATE.realizedToday = 0; STATE.startBalance = balance;
    log({ event: "day_roll", day: today, startBalance: balance });
  }
  if (STATE.startBalance == null) STATE.startBalance = balance;
}

function inSession(sessions) {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return sessions.split(",").some(win => {
    const [a, b] = win.trim().split("-");
    if (!a || !b) return true;
    const [ah, am] = a.split(":").map(Number), [bh, bm] = b.split(":").map(Number);
    return mins >= ah * 60 + am && mins <= bh * 60 + bm;
  });
}

const pipOf = (pair) => (pair.includes("JPY") ? 0.01 : pair.startsWith("X") ? 0.1 : 0.0001);
const contractOf = (pair) => (pair.startsWith("X") ? 100 : 100000);

// ---------- Claude: veto only ----------
async function claudeVeto(setup, pair) {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { approve: true, reason: "no key — veto skipped" };
  const prompt = `A mechanical trading system wants to place this trade. You are a RISK GATE, not a trader.
Your ONLY job is to VETO if there is a clear reason not to trade right now.

TRADE: ${setup.dir.toUpperCase()} ${pair} (${setup.type})
entry ${setup.entry} · stop ${setup.sl} · target ${setup.tp} · R:R 1:${setup.rr}
higher-timeframe bias: ${setup.htfBias}
setup note: ${setup.note}

Search for imminent or very recent HIGH-IMPACT news for the currencies/asset in ${pair}
(central bank decisions, CPI/NFP prints, emergency statements, major geopolitical events).

VETO if: major scheduled news is within ~60 minutes, a shock event just hit, or the trade
runs directly against an obvious fresh fundamental catalyst.
APPROVE otherwise. Do NOT veto merely because the market looks uncertain — that is normal.

Reply with ONLY JSON, no fences:
{"approve": true|false, "reason": "one short sentence"}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5", max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }] }),
    });
    if (!r.ok) return { approve: false, reason: `veto check failed (${r.status}) — trade blocked` };
    const d = await r.json();
    const text = (d.content || []).map(b => (b.type === "text" ? b.text : "")).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) return { approve: false, reason: "veto response unparseable — trade blocked" };
    const j = JSON.parse(m[0]);
    return { approve: Boolean(j.approve), reason: String(j.reason || "").slice(0, 200) };
  } catch (e) {
    // fail CLOSED: if we cannot check the news, we do not trade
    return { approve: false, reason: `veto error (${e.message}) — trade blocked` };
  }
}

/* ------------------------------------------------------------
   runAuto — one pass. Call from cron.
   deps: { scan, account, positions, price, order, notify }
------------------------------------------------------------ */
async function runAuto(deps, opts = {}) {
  const c = cfg();
  const decisions = [];
  const reject = (pair, reason, extra = {}) => { decisions.push({ pair, action: "skip", reason, ...extra }); log({ pair, reason, ...extra }); };

  if (!c.enabled) return { ran: false, reason: "AUTO_TRADE is off", decisions };
  if (STATE.killSwitch) return { ran: false, reason: `kill switch: ${STATE.killReason}`, decisions };

  // --- account + demo guard ---
  const acct = await deps.account();
  if (!acct.isDemo && !c.allowLive) {
    STATE.killSwitch = true; STATE.killReason = "live account detected and AUTO_ALLOW_LIVE is false";
    return { ran: false, reason: STATE.killReason, decisions };
  }
  rollDay(acct.balance);

  // --- daily loss halt ---
  const dayPnl = acct.equity - STATE.startBalance;
  const lossCap = STATE.startBalance * (c.dailyLossPct / 100);
  if (dayPnl <= -lossCap) {
    STATE.killSwitch = true;
    STATE.killReason = `daily loss limit hit (${dayPnl.toFixed(2)} vs -${lossCap.toFixed(2)}). Reset manually.`;
    log({ event: "halt", reason: STATE.killReason });
    await deps.notify?.(`🛑 *AUTO-TRADING HALTED*\n${STATE.killReason}`);
    return { ran: false, reason: STATE.killReason, decisions };
  }

  if (!inSession(c.sessions)) return { ran: false, reason: `outside session (${c.sessions} UTC)`, decisions };
  if (STATE.tradesToday >= c.maxTradesDay) return { ran: false, reason: "max trades/day reached", decisions };

  const open = await deps.positions();
  if (open.length >= c.maxOpen) return { ran: false, reason: "max open positions reached", decisions };

  // --- find setups using YOUR rules ---
  const { found } = await deps.scan(opts);
  if (!found.length) return { ran: true, reason: "no setups", decisions };

  const placed = [];
  for (const s of found) {
    if (STATE.tradesToday >= c.maxTradesDay) { reject(s.pair, "max trades/day reached mid-run"); break; }
    if (open.length + placed.length >= c.maxOpen) { reject(s.pair, "max open reached mid-run"); break; }
    if (open.some(p => p.symbol?.replace("_", "/").startsWith(s.pair.split("/")[0]) && p.symbol?.includes(s.pair.split("/")[1]))) { reject(s.pair, "already have a position in this pair"); continue; }

    const last = STATE.cooldown.get(s.pair) || 0;
    if (Date.now() - last < c.cooldownMin * 60000) { reject(s.pair, `cooldown (${c.cooldownMin}m)`); continue; }
    if (s.rr < c.minRR) { reject(s.pair, `R:R ${s.rr} below minimum ${c.minRR}`); continue; }

    // --- spread check on the live quote ---
    let q;
    try { q = await deps.price(s.pair); } catch (e) { reject(s.pair, `no quote (${e.message})`); continue; }
    const spreadPips = Math.abs(q.ask - q.bid) / pipOf(s.pair);
    if (spreadPips > c.maxSpreadPips) { reject(s.pair, `spread ${spreadPips.toFixed(1)} pips > ${c.maxSpreadPips}`); continue; }

    // --- stale-signal guard: price must still be near the intended entry ---
    const px = s.dir === "sell" ? q.bid : q.ask;
    const drift = Math.abs(px - s.entry);
    if (drift > (s.atr || Math.abs(s.entry - s.sl)) * 0.5) { reject(s.pair, `signal stale — price moved ${drift.toFixed(5)} from entry`); continue; }

    // --- position sizing from real equity ---
    const riskAmt = acct.equity * (c.riskPct / 100);
    const stopDist = Math.abs(px - s.sl);
    if (!stopDist) { reject(s.pair, "zero stop distance"); continue; }
    const units = riskAmt / stopDist;
    const lots = Math.max(0.01, Math.round((units / contractOf(s.pair)) * 100) / 100);

    // --- Claude veto (fails CLOSED) ---
    if (c.claudeVeto) {
      const v = await claudeVeto(s, s.pair);
      if (!v.approve) { reject(s.pair, `Claude veto: ${v.reason}`, { veto: true }); continue; }
      s.vetoNote = v.reason;
    }

    // --- place it ---
    try {
      const r = await deps.order({ pair: s.pair, side: s.dir === "sell" ? "sell" : "buy",
        lots, units, entry: px, stopLoss: s.sl, takeProfit: s.tp, rr: s.rr,
        decimals: s.pair.includes("JPY") ? 3 : s.pair.startsWith("X") ? 2 : 5 });
      STATE.tradesToday++;
      STATE.cooldown.set(s.pair, Date.now());
      placed.push({ ...s, lots, brokerId: r.id, fill: r.price });
      decisions.push({ pair: s.pair, action: "placed", lots, id: r.id });
      log({ pair: s.pair, action: "placed", dir: s.dir, lots, rr: s.rr, id: r.id, veto: s.vetoNote });
      await deps.notify?.(`✅ *AUTO ${s.dir.toUpperCase()} ${s.pair}*\n${s.type} · ${lots} lots · R:R 1:${s.rr}\nentry \`${px}\` SL \`${s.sl}\` TP \`${s.tp}\`\n_${s.vetoNote || "no news conflict"}_`);
    } catch (e) {
      reject(s.pair, `order failed: ${e.message}`);
      await deps.notify?.(`⚠️ Auto order failed on ${s.pair}: ${e.message}`);
    }
  }

  return { ran: true, placed, decisions, tradesToday: STATE.tradesToday, dayPnl: +dayPnl.toFixed(2) };
}

const status = () => ({ ...cfg(), killSwitch: STATE.killSwitch, killReason: STATE.killReason,
  day: STATE.day, tradesToday: STATE.tradesToday, startBalance: STATE.startBalance,
  cooldown: Object.fromEntries(STATE.cooldown), log: STATE.log.slice(0, 25) });

const stop = (reason = "manual stop") => { STATE.killSwitch = true; STATE.killReason = reason; log({ event: "kill", reason }); return status(); };
const resume = () => { STATE.killSwitch = false; STATE.killReason = ""; log({ event: "resume" }); return status(); };

module.exports = { runAuto, status, stop, resume, STATE };
