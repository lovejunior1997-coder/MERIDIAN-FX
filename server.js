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
   ============================================================ */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// -------- config --------
const MT_TOKEN = process.env.MT_TOKEN;
const MT_ACCOUNT = process.env.MT_ACCOUNT;
const MT_REGION = process.env.MT_REGION || "new-york";
const MT_SUFFIX = process.env.MT_SUFFIX || "";
const MT_BASE = `https://mt-client-api-v1.${MT_REGION}.agiliumtrade.ai`;

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
  async order({ pair, side, lots, stopLoss, takeProfit }) {
    const volume = Math.max(0.01, Math.round((lots || 0.01) * 100) / 100); // MT trades in lots, min 0.01
    const b = await metaTrade({
      actionType: side === "sell" ? "ORDER_TYPE_SELL" : "ORDER_TYPE_BUY",
      symbol: metaSym(pair), volume,
      ...(stopLoss ? { stopLoss: Number(stopLoss) } : {}),
      ...(takeProfit ? { takeProfit: Number(takeProfit) } : {}),
    });
    return { id: b.orderId || b.positionId || "filled", volume };
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

// ---- AI analysis (runs Claude server-side with YOUR key) ----
app.post("/analyze", async (req, res) => {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set on server" });
  try {
    const d = req.body || {};
    const trend = d.sma20 > d.sma50 ? "SMA20 above SMA50 (bullish)" : "SMA20 below SMA50 (bearish)";
    const prompt = `You are a disciplined FX analyst. Analyze ${d.pair} on ${d.tf} using ONLY this data plus current news you find. Do not invent levels.
DATA: price ${d.price}, change ${Number(d.changePct).toFixed(2)}%, SMA20 ${d.sma20}, SMA50 ${d.sma50} (${trend}), RSI14 ${Number(d.rsi).toFixed(1)}, ATR14 ${d.atr}, 30-bar range ${d.lo30}-${d.hi30}, pip ${d.pip}.
Search latest news/sentiment for ${d.pair}. Respond with ONLY JSON, no fences:
{"bias":"long|short|neutral","confidence":<0-100 int>,"entry":<num>,"stopLoss":<num>,"takeProfit":<num>,"rationale":"<=2 sentences","risks":["short","short"],"catalysts":["short","..."]}`;
    const call = async (useTools) => {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: prompt }], ...(useTools ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}) }),
      });
      if (!r.ok) { let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch (_) {} throw new Error(`Anthropic ${r.status}${msg ? " — " + msg : ""}`); }
      return r.json();
    };
    let data;
    try { data = await call(true); } catch (e1) {
      try { data = await call(false); } catch (e2) { throw new Error(e2.message); } // retry without web search, surface real reason
    }
    const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("\n");
    const m = text.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("no signal parsed");
    res.json(JSON.parse(m[0]));
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
