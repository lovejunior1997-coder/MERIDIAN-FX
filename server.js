/* ============================================================
   MERIDIAN backend — multi-venue live execution bridge
   Venues (auto-selected):
     • Vantage (or any MT4/MT5 broker) via MetaApi  <-- your demo
     • OANDA v20   (forex + metals, native REST)
     • Kraken spot (crypto)
   If MetaApi is configured, EVERYTHING routes through your MT5
   account (Vantage lists forex, metals and crypto CFDs), so you
   don't need OANDA or Kraken at all.

   Keys live here in .env and NEVER touch the browser. The frontend
   contract is unchanged: /health /order /close /price
   ============================================================
   ---- one-time Vantage setup (MetaApi) ----
   1) Create a free account at https://app.metaapi.cloud
   2) Accounts -> Add account -> platform MT5, broker "Vantage",
      enter your DEMO login number, master (trading) password,
      and the exact server name (e.g. VantageInternational-Demo).
   3) MetaApi provisions it and shows an Account ID + region.
   4) Create an API token (auth-token) with trading access.
   5) Put the values in .env below and deploy.

   ---- .env.example ----
   PORT=8080
   ALLOWED_ORIGIN=https://claude.ai
   # --- Vantage via MetaApi (primary) ---
   MT_TOKEN=your-metaapi-auth-token
   MT_ACCOUNT=your-metaapi-account-id
   MT_REGION=new-york              # region shown on your MetaApi account
   MT_SUFFIX=                      # symbol suffix if your account uses one (e.g. .raw or +)
   # --- optional fallbacks (used only if MT_* is empty) ---
   OANDA_ENV=practice
   OANDA_TOKEN=
   OANDA_ACCOUNT=
   KRAKEN_KEY=
   KRAKEN_SECRET=
   # --- server-side guards ---
   MAX_NOTIONAL=25000
   DAILY_LOSS_LIMIT=500
   # --- AI analysis (server-side Claude key for the hosted app) ---
   ANTHROPIC_API_KEY=sk-ant-...
   # --- free live candles (optional but recommended) ---
   # get a free key at twelvedata.com -> covers forex, metals & crypto.
   # crypto also falls back to Kraken's free public OHLC with no key.
   TWELVE_DATA_KEY=
   # --- setup scanner + phone alerts ---
   TELEGRAM_BOT_TOKEN=      # from @BotFather
   TELEGRAM_CHAT_ID=        # from @userinfobot
   WATCHLIST=EUR/USD,GBP/USD,USD/JPY,XAU/USD
   # --- AUTONOMOUS TRADING (all optional; off by default) ---
   AUTO_TRADE=false            # master switch. Nothing trades until this is true.
   AUTO_ALLOW_LIVE=false       # refuses to trade a non-demo account unless true
   AUTO_RISK_PCT=0.5           # risk per trade, % of equity
   AUTO_MAX_TRADES_DAY=3
   AUTO_MAX_OPEN=2
   AUTO_DAILY_LOSS_PCT=3       # trips the kill switch, stays tripped
   AUTO_MIN_RR=2
   AUTO_MAX_SPREAD_PIPS=3
   AUTO_COOLDOWN_MIN=120       # per pair
   AUTO_SESSIONS=07:00-20:00   # UTC, comma-separated windows
   AUTO_CLAUDE_VETO=true       # Claude blocks trades near high-impact news
   ============================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { findSetups, structure, chartBrief } = require("./strategy");
const auto = require("./autotrader");
const bt = require("./backtest");

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// -------- config --------
const MT_TOKEN = process.env.MT_TOKEN;
const MT_ACCOUNT = process.env.MT_ACCOUNT;
const MT_REGION = process.env.MT_REGION || "new-york";
const MT_SUFFIX = process.env.MT_SUFFIX || "";
const MT_BASE = `https://mt-client-api-v1.${MT_REGION}.agiliumtrade.ai`;
const MD_BASE = `https://mt-market-data-client-api-v1.${MT_REGION}.agiliumtrade.ai`;

const O_ENV = process.env.OANDA_ENV || "practice";
const O_BASE = O_ENV === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
const O_TOKEN = process.env.OANDA_TOKEN;
const O_ACCT = process.env.OANDA_ACCOUNT;
const K_KEY = process.env.KRAKEN_KEY;
const K_SECRET = process.env.KRAKEN_SECRET;
const MAX_NOTIONAL = Number(process.env.MAX_NOTIONAL || 25000);
const DAILY_LOSS_LIMIT = Number(process.env.DAILY_LOSS_LIMIT || 0);

const USE_MT = Boolean(MT_TOKEN && MT_ACCOUNT);
const KRAKEN_SYM = { "BTC/USD": "XBTUSD", "ETH/USD": "ETHUSD", "SOL/USD": "SOLUSD", "XRP/USD": "XRPUSD", "ADA/USD": "ADAUSD", "LTC/USD": "LTCUSD", "DOGE/USD": "XDGUSD" };

// route: MetaApi wins when configured (Vantage covers all classes)
function venueFor(pair) {
  if (USE_MT) return "metaapi";
  if (KRAKEN_SYM[pair]) return "kraken";
  return "oanda";
}
const oandaSym = (pair) => pair.replace("/", "_");            // EUR/USD -> EUR_USD
const metaSym = (pair) => pair.replace("/", "") + MT_SUFFIX;  // EUR/USD -> EURUSD(+suffix)

// -------- daily loss guard --------
let dayRealized = 0, dayStamp = new Date().toDateString();
const resetDay = () => { const t = new Date().toDateString(); if (t !== dayStamp) { dayStamp = t; dayRealized = 0; } };

// -------- MetaApi adapter (Vantage MT4/MT5) --------
const mtH = () => ({ "auth-token": MT_TOKEN, "Content-Type": "application/json", Accept: "application/json" });
async function metaGet(path) {
  const r = await fetch(`${MT_BASE}/users/current/accounts/${MT_ACCOUNT}${path}`, { headers: mtH() });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.message || `MetaApi ${r.status}`);
  return b;
}
async function metaTrade(body) {
  const r = await fetch(`${MT_BASE}/users/current/accounts/${MT_ACCOUNT}/trade`, { method: "POST", headers: mtH(), body: JSON.stringify(body) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.message || `MetaApi ${r.status}`);
  if (b.stringCode && b.stringCode !== "TRADE_RETCODE_DONE" && b.stringCode !== "TRADE_RETCODE_PLACED")
    throw new Error(`${b.stringCode}: ${b.message || "rejected"}`);
  return b;
}
const METAAPI = {
  async summary() { const a = await metaGet("/account-information"); return { balance: Number(a.balance), account: MT_ACCOUNT, environment: `${a.broker || "Vantage"} ${a.platform || "mt5"}` }; },
  async price(pair) { const p = await metaGet(`/symbols/${metaSym(pair)}/current-price`); return { bid: Number(p.bid), ask: Number(p.ask) }; },
  async candles(pair, tf, limit = 200) {
    const map = { "15M": "15m", "1H": "1h", "4H": "4h", "1D": "1d" };
    const t = map[String(tf).toUpperCase()] || "1h";
    const url = `${MD_BASE}/users/current/accounts/${MT_ACCOUNT}/historical-market-data/symbols/${metaSym(pair)}/timeframes/${t}/candles?limit=${Math.min(limit, 1000)}`;
    const r = await fetch(url, { headers: mtH() });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b?.message || `MetaApi candles ${r.status}`);
    const rows = Array.isArray(b) ? b : [];
    return rows.map(c => ({ t: c.time, o: Number(c.open), h: Number(c.high), l: Number(c.low), c: Number(c.close) }))
               .filter(c => Number.isFinite(c.o) && Number.isFinite(c.c));
  },
  async order({ pair, side, lots, entry, stopLoss, takeProfit, decimals, rr }) {
    const volume = Math.max(0.01, Math.round((lots || 0.01) * 100) / 100); // MT trades in lots, min 0.01
    // fetch the live price and rebuild stops around the ACTUAL fill, on the correct side,
    // never closer than a minimum distance (fixes TRADE_RETCODE_INVALID_STOPS)
    const q = await METAAPI.price(pair);
    const px = side === "sell" ? q.bid : q.ask;
    const d = Number.isFinite(decimals) ? decimals : (px >= 1000 ? 2 : px >= 100 ? 3 : 5);
    const minFrac = Number(process.env.MIN_STOP_FRAC || 0.0004); // small floor; only engages on ultra-tight stops
    const floor = px * minFrac;
    const anchor = Number(entry) || px;
    let sl, tp, slDist;
    if (stopLoss) { slDist = Math.max(Math.abs(anchor - Number(stopLoss)), floor); sl = side === "sell" ? px + slDist : px - slDist; }
    if (takeProfit || (rr && slDist)) {
      const tpDist = rr && slDist ? slDist * rr : Math.max(Math.abs(Number(takeProfit) - anchor), floor); // lock exact R:R when provided
      tp = side === "sell" ? px - tpDist : px + tpDist;
    }
    const b = await metaTrade({
      actionType: side === "sell" ? "ORDER_TYPE_SELL" : "ORDER_TYPE_BUY",
      symbol: metaSym(pair), volume,
      ...(sl ? { stopLoss: +sl.toFixed(d) } : {}),
      ...(tp ? { takeProfit: +tp.toFixed(d) } : {}),
    });
    return { id: b.orderId || b.positionId || "filled", volume, price: +px.toFixed(d) };
  },
  async positions() {
    const list = await metaGet("/positions");
    return (Array.isArray(list) ? list : []).map(p => ({
      id: String(p.id), symbol: p.symbol, dir: p.type === "POSITION_TYPE_SELL" ? "short" : "long",
      volume: Number(p.volume), entry: Number(p.openPrice), current: Number(p.currentPrice),
      sl: p.stopLoss != null ? Number(p.stopLoss) : null, tp: p.takeProfit != null ? Number(p.takeProfit) : null,
      pnl: Number(p.profit ?? p.unrealizedProfit ?? 0),
    }));
  },
  async close(pair) { const b = await metaTrade({ actionType: "POSITIONS_CLOSE_SYMBOL", symbol: metaSym(pair) }); return { closed: b.stringCode || "ok" }; },
};

// -------- OANDA adapter --------
const oH = () => ({ Authorization: `Bearer ${O_TOKEN}`, "Content-Type": "application/json" });
async function oanda(path, opts = {}) {
  const r = await fetch(`${O_BASE}/v3/accounts/${O_ACCT}${path}`, { ...opts, headers: oH() });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b?.errorMessage || `OANDA ${r.status}`);
  return b;
}
const OANDA = {
  async summary() { const s = await oanda("/summary"); return { balance: Number(s.account.balance), account: O_ACCT, environment: O_ENV }; },
  async price(pair) { const d = await oanda(`/pricing?instruments=${oandaSym(pair)}`); const p = d.prices[0]; return { bid: Number(p.bids[0].price), ask: Number(p.asks[0].price) }; },
  async order({ pair, side, units, stopLoss, takeProfit }) {
    const dp = pair.includes("JPY") ? 3 : pair.startsWith("X") ? 2 : 5;
    const u = Math.round(Math.abs(units));
    const body = { order: { type: "MARKET", instrument: oandaSym(pair), units: String(side === "sell" ? -u : u), timeInForce: "FOK", positionFill: "DEFAULT",
      ...(stopLoss ? { stopLossOnFill: { price: Number(stopLoss).toFixed(dp) } } : {}),
      ...(takeProfit ? { takeProfitOnFill: { price: Number(takeProfit).toFixed(dp) } } : {}) } };
    const d = await oanda("/orders", { method: "POST", body: JSON.stringify(body) });
    const f = d.orderFillTransaction;
    return { id: f?.id || d.orderCreateTransaction?.id, price: f?.price ? Number(f.price) : null };
  },
  async close(pair) { const d = await oanda(`/positions/${oandaSym(pair)}/close`, { method: "PUT", body: JSON.stringify({ longUnits: "ALL", shortUnits: "ALL" }) }); const pl = Number(d.longOrderFillTransaction?.pl || d.shortOrderFillTransaction?.pl || 0); dayRealized += pl; return { realizedPL: pl }; },
};

// -------- Kraken adapter --------
async function krakenPublic(endpoint, qs = "") { const r = await fetch(`https://api.kraken.com/0/public/${endpoint}${qs}`); const j = await r.json(); if (j.error?.length) throw new Error("Kraken: " + j.error.join("; ")); return j.result; }
async function krakenPrivate(endpoint, params = {}) {
  if (!K_KEY || !K_SECRET) throw new Error("Kraken not configured");
  const path = `/0/private/${endpoint}`, nonce = Date.now() * 1000;
  const postdata = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
  const sha256 = crypto.createHash("sha256").update(nonce + postdata).digest();
  const sign = crypto.createHmac("sha512", Buffer.from(K_SECRET, "base64")).update(Buffer.concat([Buffer.from(path), sha256])).digest("base64");
  const r = await fetch(`https://api.kraken.com${path}`, { method: "POST", headers: { "API-Key": K_KEY, "API-Sign": sign, "Content-Type": "application/x-www-form-urlencoded" }, body: postdata });
  const j = await r.json(); if (j.error?.length) throw new Error("Kraken: " + j.error.join("; ")); return j.result;
}
const KRAKEN = {
  async summary() { const b = await krakenPrivate("Balance"); return { balance: Number(b?.ZUSD || 0), account: "kraken-spot", environment: "live" }; },
  async price(pair) { const d = await krakenPublic("Ticker", `?pair=${KRAKEN_SYM[pair]}`); const k = Object.keys(d)[0]; const last = Number(d[k].c[0]); return { bid: last, ask: last }; },
  async order({ pair, side, units, stopLoss }) { const sym = KRAKEN_SYM[pair]; if (!sym) throw new Error(`${pair} not mapped for Kraken`); const params = { pair: sym, type: side === "sell" ? "sell" : "buy", ordertype: "market", volume: String(Math.abs(units)) }; if (stopLoss) { params["close[ordertype]"] = "stop-loss"; params["close[price]"] = String(stopLoss); } const d = await krakenPrivate("AddOrder", params); return { id: d?.txid?.[0] || "submitted", price: null }; },
  async close() { throw new Error("Kraken spot: flatten with an opposite market order"); },
};

const venue = (name) => (name === "metaapi" ? METAAPI : name === "kraken" ? KRAKEN : OANDA);

// -------- routes --------
app.get("/health", async (_req, res) => {
  const out = { ok: true, broker: [], environment: USE_MT ? "vantage-mt5" : O_ENV, primary: USE_MT ? "MetaApi/Vantage" : "OANDA" };
  try { if (USE_MT) { const s = await METAAPI.summary(); out.broker.push("Vantage (MetaApi)"); out.account = s.account; out.balance = s.balance; out.environment = s.environment; } } catch (e) { out.mtError = e.message; }
  try { if (!USE_MT && O_TOKEN) { const s = await OANDA.summary(); out.broker.push("OANDA"); out.account = s.account; out.balance = s.balance; } } catch (e) { out.oandaError = e.message; }
  try { if (!USE_MT && K_KEY) { const s = await KRAKEN.summary(); out.broker.push("Kraken"); out.cryptoBalance = s.balance; } } catch (e) { out.krakenError = e.message; }
  out.broker = out.broker.join(" + ") || "none";
  res.json(out);
});

app.get("/price/:pair", async (req, res) => {
  try { res.json(await venue(venueFor(req.params.pair)).price(req.params.pair)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/order", async (req, res) => {
  resetDay();
  try {
    const { pair, side, units, lots, stopLoss, takeProfit } = req.body || {};
    if (!pair || !side) return res.status(400).json({ error: "pair and side required" });
    if (DAILY_LOSS_LIMIT > 0 && dayRealized <= -DAILY_LOSS_LIMIT) return res.status(423).json({ error: "daily loss limit reached — halted" });
    const v = venue(venueFor(pair));
    // notional guard from a fresh quote (units-based; MetaApi path may skip if units absent)
    if (units) { const q = await v.price(pair).catch(() => null); if (q && Math.abs(units) * q.ask > MAX_NOTIONAL) return res.status(400).json({ error: `notional exceeds MAX_NOTIONAL ($${MAX_NOTIONAL})` }); }
    const r = await v.order({ pair, side, units, lots, stopLoss, takeProfit });
    res.json({ ok: true, venue: venueFor(pair), ...r });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.post("/close/:pair", async (req, res) => {
  try { res.json({ ok: true, ...(await venue(venueFor(req.params.pair)).close(req.params.pair)) }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// -------- free candle sources (no MetaApi market-data plan needed) --------
const TD_KEY = process.env.TWELVE_DATA_KEY;

// Kraken public OHLC — free, no key, crypto only
async function krakenCandles(pair, tf, limit = 200) {
  const sym = KRAKEN_SYM[pair];
  if (!sym) throw new Error(`${pair} not a Kraken symbol`);
  const mins = { "15M": 15, "1H": 60, "4H": 240, "1D": 1440 }[String(tf).toUpperCase()] || 60;
  const d = await krakenPublic("OHLC", `?pair=${sym}&interval=${mins}`);
  const key = Object.keys(d).find(k => k !== "last");
  const rows = (d[key] || []).slice(-limit);
  return rows.map(r => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

// Twelve Data — free tier key, covers forex, metals and crypto
async function twelveCandles(pair, tf, limit = 200) {
  if (!TD_KEY) throw new Error("TWELVE_DATA_KEY not set");
  const iv = { "15M": "15min", "1H": "1h", "4H": "4h", "1D": "1day" }[String(tf).toUpperCase()] || "1h";
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=${iv}&outputsize=${Math.min(limit, 500)}&apikey=${TD_KEY}`;
  const r = await fetch(url);
  const b = await r.json().catch(() => ({}));
  if (b.status === "error" || !Array.isArray(b.values)) throw new Error(b.message || "Twelve Data error");
  return b.values.map(v => ({ t: Date.parse(v.datetime), o: +v.open, h: +v.high, l: +v.low, c: +v.close }))
                 .filter(c => Number.isFinite(c.c)).reverse(); // API returns newest-first
}

// try each source in order until one yields usable candles
async function getCandles(pair, tf, limit) {
  const isCrypto = Boolean(KRAKEN_SYM[pair]);
  const chain = [];
  if (USE_MT && METAAPI.candles) chain.push(["metaapi", () => METAAPI.candles(pair, tf, limit)]);
  if (isCrypto) chain.push(["kraken", () => krakenCandles(pair, tf, limit)]);
  if (TD_KEY) chain.push(["twelvedata", () => twelveCandles(pair, tf, limit)]);
  const errors = [];
  for (const [name, fn] of chain) {
    try { const rows = await fn(); if (rows && rows.length >= 30) return { source: name, candles: rows }; errors.push(`${name}: too few candles`); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  throw new Error(errors.join(" | ") || "no candle source configured");
}

// ---- real historical candles (drives the chart AND the indicators) ----
app.get("/candles/:pair", async (req, res) => {
  try {
    const tf = req.query.tf || "1H";
    const { source, candles } = await getCandles(req.params.pair, tf, Number(req.query.limit) || 200);
    res.json({ pair: req.params.pair, tf, source, candles });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- live open positions from the broker (source of truth) ----
app.get("/positions", async (_req, res) => {
  try {
    const v = venue(USE_MT ? "metaapi" : "oanda");
    if (!v.positions) return res.json({ positions: [], note: "not supported for this venue" });
    res.json({ positions: await v.positions() });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- AI analysis, read through YOUR framework ----
// Daily structure -> bias. Then trendline touches + BOS/zones on the entry timeframe.
// Claude interprets THOSE facts. It never invents levels.
app.post("/analyze", async (req, res) => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set on server" });
  const d = req.body || {};
  const pair = d.pair, tf = (d.tf || "1H").toUpperCase();
  const dec = Number.isFinite(d.decimals) ? d.decimals : 5;

  try {
    // pull real candles: daily for bias, entry timeframe for the setup
    const daily = await getCandles(pair, "1D", 120);
    const ltf = await getCandles(pair, tf, 200);
    const b = chartBrief(daily.candles, ltf.candles);

    const tl = b.trendline
      ? `${b.trendline.touches} touch(es) on the ${b.trendline.direction} trendline; line currently at ${b.trendline.linePrice}; price is ${b.trendline.distanceATR} ATR away; ${b.trendline.ready ? "THIRD TOUCH IS IN PLACE" : "third touch NOT yet formed"}.`
      : "no valid trendline in the direction of the daily trend.";
    const smc = b.smc
      ? (b.smc.bos
          ? `Break of structure confirmed through ${b.smc.brokeLevel}. Origin ${b.smc.kind} zone ${b.smc.zone ? b.smc.zone.lo + "-" + b.smc.zone.hi : "not identified"}. Price ${b.smc.inZone ? "IS INSIDE the zone now" : `is ${b.smc.distanceATR} ATR away from it`}.`
          : `No break of structure yet. Watch ${b.smc.watchLevel}.`)
      : "no SMC read available.";

    const mode = String(d.mode || "rules").toLowerCase();   // "rules" | "claude"

    const rulesPrompt = `You are analysing a chart for a trader with 8 years' experience who trades ONE way. Use HIS framework only. Do not mention RSI, MACD or generic indicators.

HIS RULES:
- Directional bias comes from the DAILY structure. He only ever trades WITH that trend.
- Trendline setup: he needs THREE touches. He enters on the 3rd lower high (sell) or 3rd higher low (buy). Stop goes just beyond that swing.
- SMC setup: after a break of structure, he waits for price to return into the origin supply zone (sell) or demand zone (buy), entering on a lower timeframe.
- No setup = no trade. Patience is part of the edge.

CHART FACTS (computed from real ${ltf.source} candles — these are the only levels you may use):
- Pair ${pair}, entry timeframe ${tf}, current price ${b.price}, ATR ${b.atr}
- DAILY structure: ${b.htfBias}. Recent daily swing highs ${JSON.stringify(b.htfSwingHighs)}, lows ${JSON.stringify(b.htfSwingLows)}
- ${tf} structure: ${b.ltfBias}. Swing highs ${JSON.stringify(b.ltfSwingHighs)}, lows ${JSON.stringify(b.ltfSwingLows)}
- TRENDLINE: ${tl}
- SMC: ${smc}

Search for current news/sentiment on ${pair} that could matter.
Then answer as his analyst. If no setup is valid yet, say so plainly and describe what must happen first.

Reply with ONLY JSON, no fences:
{"bias":"long|short|neutral","setupValid":true|false,"setupType":"trendline|smc|none","confidence":<0-100 int>,"entry":<number>,"stopLoss":<number>,"structureRead":"<1-2 sentences>","setupRead":"<1-2 sentences>","waitFor":"<what to wait for; empty if valid>","risks":["short","short"],"catalysts":["short","..."]}`;

    const claudePrompt = `You are an independent technical analyst. Form YOUR OWN view of ${pair} on ${tf}. You may use any method — structure, momentum, support/resistance, trend, patterns — and current news. Only use the real price levels given below; do not invent numbers outside this range.

REAL DATA (${ltf.source} candles):
- Pair ${pair}, entry timeframe ${tf}, current price ${b.price}, ATR ${b.atr}
- DAILY structure: ${b.htfBias}. Recent daily swing highs ${JSON.stringify(b.htfSwingHighs)}, lows ${JSON.stringify(b.htfSwingLows)}
- ${tf} structure: ${b.ltfBias}. Swing highs ${JSON.stringify(b.ltfSwingHighs)}, lows ${JSON.stringify(b.ltfSwingLows)}

Search for current news/sentiment on ${pair}.

Rules for your levels:
- If you see a trade, set entry near ${b.price}, put stopLoss beyond a real nearby swing from the lists above, sized sensibly vs ATR ${b.atr}.
- If nothing is compelling, set tradeable=false and say why. "No trade" is a valid, honest answer.
- Be conservative with confidence. You have NO verified track record; never imply certainty.

Reply with ONLY JSON, no fences:
{"bias":"long|short|neutral","tradeable":true|false,"confidence":<0-100 int>,"entry":<number>,"stopLoss":<number>,"method":"<approach used>","structureRead":"<1-2 sentences>","setupRead":"<why enter here / why not>","risks":["short","short"],"catalysts":["short","..."]}`;

    const prompt = mode === "claude" ? claudePrompt : rulesPrompt;

    const call = async (useTools) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5", max_tokens: 1200,
          messages: [{ role: "user", content: prompt }],
          ...(useTools ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}) }),
      });
      if (!r.ok) { let m = ""; try { m = (await r.json())?.error?.message || ""; } catch (_) {} throw new Error(`Anthropic ${r.status}${m ? " — " + m : ""}`); }
      return r.json();
    };
    let data; try { data = await call(true); } catch (e1) { data = await call(false); }
    const text = (data.content || []).map(x => (x.type === "text" ? x.text : "")).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no analysis parsed");
    const j = JSON.parse(m[0]);

    const out = {
      mode,
      confidence: Math.max(0, Math.min(100, Math.round(j.confidence || 0))),
      structureRead: j.structureRead || "", setupRead: j.setupRead || "",
      risks: Array.isArray(j.risks) ? j.risks.slice(0, 3) : [],
      catalysts: Array.isArray(j.catalysts) ? j.catalysts.slice(0, 4) : [],
    };

    if (mode === "claude") {
      /* ---- CLAUDE'S OWN VIEW ----
         Claude proposes bias, entry and stop. We validate the stop is on the
         correct side and not absurdly tight; we do NOT invent levels for it.  */
      const bias = (j.bias || "neutral").toLowerCase();
      const isShort = bias === "short" || bias === "sell";
      let entry = Number(j.entry), sl = Number(j.stopLoss);
      const a = b.atr || b.price * 0.001;
      const tradeable = Boolean(j.tradeable) && bias !== "neutral" && Number.isFinite(entry) && Number.isFinite(sl);
      const sideOK = tradeable && (isShort ? sl > entry : sl < entry);
      const farEnough = tradeable && Math.abs(entry - sl) >= a * 0.3;   // reject ultra-tight AI stops
      const valid = tradeable && sideOK && farEnough;
      Object.assign(out, {
        setupValid: valid, setupType: valid ? "claude" : "none",
        bias: isShort ? "short" : bias === "long" || bias === "buy" ? "long" : "neutral",
        entry: valid ? entry : b.price,
        stopLoss: valid ? sl : null,
        method: j.method || "",
        setupNote: valid ? (j.method || "Claude analysis") : "",
        levelsFrom: valid ? "claude — independent analysis" : "none — Claude sees no trade",
        waitFor: valid ? "" : (j.setupRead || "Claude does not see a compelling trade right now."),
      });
      if (!valid) out.confidence = Math.min(out.confidence, 30);
    } else {
      /* ---- YOUR RULES ARE AUTHORITATIVE ---- */
      const det = findSetups({ htf: daily.candles, ltf: ltf.candles, rr: Number(d.rr) || 3 });
      if (det.setups.length) {
        const pick = det.setups.find(x => x.type === j.setupType) || det.setups[0];
        Object.assign(out, {
          setupValid: true, setupType: pick.type,
          bias: pick.dir === "sell" ? "short" : "long",
          entry: pick.entry, stopLoss: pick.sl,
          setupNote: pick.note, levelsFrom: "strategy.js — your rules", waitFor: "",
        });
      } else {
        Object.assign(out, {
          setupValid: false, setupType: "none",
          bias: b.htfBias === "bullish" ? "long" : b.htfBias === "bearish" ? "short" : "neutral",
          entry: b.price, stopLoss: null,
          setupNote: "", levelsFrom: "none — no valid setup",
          waitFor: j.waitFor || "No valid setup. Wait for a third trendline touch, or a break of structure with a return into the zone.",
        });
        out.confidence = Math.min(out.confidence, 25);
      }
    }

    res.json({ ...out, brief: b, source: ltf.source, decimals: dec });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ============================================================
   SETUP SCANNER — scans YOUR rules across a watchlist.
   HTF bias (1D) -> LTF entry (1H or 15M).
   A) trendline 3-touch   B) BOS + supply/demand retest
   Alerts to Telegram so you never sit on charts.
   ============================================================ */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID;
const WATCH = (process.env.WATCHLIST ||
  "EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,USD/CHF,NZD/USD,EUR/JPY,GBP/JPY,XAU/USD"
).split(",").map(x => x.trim()).filter(Boolean);

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) return { skipped: "telegram not configured" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" }),
    });
    return r.ok ? { sent: true } : { error: `telegram ${r.status}` };
  } catch (e) { return { error: e.message }; }
}

const seen = new Map();                         // de-dupe: one alert per setup per bar
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtSetup(pair, s, tf) {
  const d = pair.includes("JPY") ? 3 : pair.startsWith("X") ? 2 : 5;
  const arrow = s.dir === "buy" ? "BUY" : "SELL";
  return `${arrow} *${pair}*  _${s.type}_ (${tf})\n`
       + `entry \`${s.entry.toFixed(d)}\`  SL \`${s.sl.toFixed(d)}\`  TP \`${s.tp.toFixed(d)}\`\n`
       + `R:R 1:${s.rr}  ·  stop ${s.stopPct}%  ·  HTF ${s.htfBias}\n`
       + `${s.note}`;
}

async function runScan(q = {}) {
  const tf = String(q.tf || "1H").toUpperCase();
  const rr = Number(q.rr) || 3;
  const notify = String(q.notify ?? "1") !== "0";
  const pairs = q.pairs ? String(q.pairs).split(",").map(x => x.trim()) : WATCH;

  const found = [], errors = [];
  for (const pair of pairs) {
    try {
      const daily = await getCandles(pair, "1D", 120);
      await sleep(150);                                   // stay under data-source rate limits
      const ltf = await getCandles(pair, tf, 200);
      const strategies = q.strat ? String(q.strat).split(",") : ["trendline", "smc"];
      const { bias, setups } = findSetups({ htf: daily.candles, ltf: ltf.candles, rr, strategies, tf });
      for (const s of setups) {
        const key = `${pair}:${s.type}:${s.dir}:${ltf.candles.at(-1).t}`;
        if (notify) {                                     // de-dupe ALERTS only
          if (seen.has(key)) continue;                    // already alerted on this bar
          seen.set(key, Date.now());
        }
        found.push({ pair, tf, source: ltf.source, ...s });
      }
      if (!setups.length) errors.push({ pair, bias, note: "no setup" });
      await sleep(150);
    } catch (e) { errors.push({ pair, error: e.message }); }
  }

  const cut = Date.now() - 864e5;                          // prune de-dupe cache (24h)
  for (const [k, v] of seen) if (v < cut) seen.delete(k);

  let tg = null;
  if (found.length && notify) {
    const body = found.map(s => fmtSetup(s.pair, s, s.tf)).join("\n\n");
    tg = await telegram(`*MERIDIAN — ${found.length} setup${found.length > 1 ? "s" : ""}*\n\n${body}`);
  }
  return { scanned: pairs.length, found, telegram: tg, skipped: errors };
}

app.get("/scan", async (req, res) => {
  try { res.json(await runScan(req.query)); } catch (e) { res.status(502).json({ error: e.message }); }
});

// quick check that alerts reach your phone
app.get("/scan/test-alert", async (_req, res) => res.json(await telegram("Meridian alerts are working.")));

/* ============================================================
   AUTONOMOUS TRADING — off unless AUTO_TRADE=true.
   Claude can only VETO. Guardrails decide. Kill switch always wins.
   ============================================================ */
async function accountSnapshot() {
  if (!USE_MT) throw new Error("auto-trading requires a MetaApi/MT broker");
  const a = await metaGet("/account-information");
  const server = String(a.server || "");
  const isDemo = /demo|practice/i.test(server) || /demo/i.test(String(a.type || ""));
  return { balance: Number(a.balance), equity: Number(a.equity ?? a.balance), server, isDemo };
}

const autoDeps = {
  scan: (opts) => runScan({ ...opts, notify: "0", strat: process.env.AUTO_STRATEGIES || "trendline,smc" }),      // scanner alerts are separate
  account: accountSnapshot,
  positions: () => METAAPI.positions(),
  price: (pair) => METAAPI.price(pair),
  order: (o) => METAAPI.order(o),
  notify: telegram,
};

app.get("/auto/status", (_req, res) => res.json(auto.status()));
app.post("/auto/stop",  (req, res) => { const s = auto.stop(req.query.reason || "manual stop"); telegram("🛑 Auto-trading STOPPED."); res.json(s); });
app.post("/auto/resume",(_req, res) => { const s = auto.resume(); telegram("▶️ Auto-trading resumed."); res.json(s); });
// GET aliases so you can hit them from a phone browser in a hurry
app.get("/auto/stop",   (req, res) => { const s = auto.stop(req.query.reason || "manual stop"); telegram("🛑 Auto-trading STOPPED."); res.json(s); });
app.get("/auto/resume", (_req, res) => res.json(auto.resume()));

// the cron target: one autonomous pass
app.all("/auto/run", async (req, res) => {
  try { res.json(await auto.runAuto(autoDeps, { tf: req.query.tf || "1H", rr: req.query.rr || 3 })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});


/* ============================================================
   BACKTEST — walk YOUR rules over history. No lookahead.
   GET /backtest/EUR%2FUSD?tf=1H&rr=3&bars=1000&maxBars=80&trades=1
   ============================================================ */
app.get("/backtest/:pair", async (req, res) => {
  try {
    const pair = req.params.pair;
    const tf = String(req.query.tf || "1H").toUpperCase();
    const rr = Number(req.query.rr) || 3;
    const bars = Math.min(Number(req.query.bars) || 1000, 1000);
    const maxBars = Number(req.query.maxBars) || 80;
    const strategies = req.query.strat ? String(req.query.strat).split(",") : ["trendline", "smc"];
    const spreadPips = Number(req.query.spreadPips) || 0;
    const pip = pair.includes("JPY") ? 0.01 : pair.startsWith("X") ? 0.1 : 0.0001;

    const ltf = await getCandles(pair, tf, bars);
    await new Promise(r => setTimeout(r, 200));
    const daily = await getCandles(pair, "1D", 400);
    if (ltf.candles.length < 120) throw new Error(`only ${ltf.candles.length} candles returned — need more history`);

    const out = bt.run({ htf: daily.candles, ltf: ltf.candles, rr, warmup: 60,
                         cooldownBars: 5, spread: spreadPips * pip, maxBars, strategies, tf });
    const wantTrades = String(req.query.trades || "0") === "1";
    res.json({ pair, tf, source: ltf.source, params: out.params, overall: out.overall,
               byType: out.byType, byDirection: out.byDirection, openAtEnd: out.openAtEnd,
               trades: wantTrades ? out.trades : undefined });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Meridian bridge :${PORT} — ${USE_MT ? `Vantage via MetaApi (${MT_REGION})` : `OANDA ${O_ENV}${K_KEY ? " + Kraken" : ""}`}`));

/* Notes for Vantage:
   - MetaApi trades in LOTS (min 0.01). The app now sends both `units`
     and `lots`; the MetaApi adapter uses `lots`, OANDA/Kraken use `units`.
   - Symbol suffixes: some Vantage account types append a suffix
     (e.g. EURUSD.raw or EURUSD+). If orders 404 with "symbol not found",
     set MT_SUFFIX to match what you see in the MT5 Market Watch.
   - Take-profit + stop-loss are attached on entry (MT supports both natively).
   - Confirm your MetaApi region (MT_REGION) — it's shown on the account page.
*/
