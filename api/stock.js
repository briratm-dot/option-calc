// api/stock.js — Vercel/Netlify serverless function.
// Holds the FMP API key (server-side env var) and returns a clean snapshot.
// The browser NEVER sees the key. Frontend calls /api/stock?symbol=ADBE
//
// Env var required:  FMP_API_KEY
//
// Returns JSON:
// { symbol, name, asOf, range, lastClose,
//   returns:{ daily, m1, m3, m6, ytd, y1 },
//   vol6, vol12, mu6, mu12,
//   series:[{ d:"YYYY-MM-DD", c:Number }, ...] }   // ascending by date

const FMP_BASE = "https://financialmodelingprep.com/stable";
const TRADING_DAYS_YEAR = 252;

// ---- pure helpers (kept identical in spirit to the frontend math) ----
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function sampleStd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); // ddof=1
  return Math.sqrt(v);
}
// σ annualized over a trailing window of log returns
function annualVol(logret, window) {
  const w = logret.slice(-Math.min(window, logret.length));
  return sampleStd(w) * Math.sqrt(TRADING_DAYS_YEAR);
}
// μ = annualized ARITHMETIC GBM drift over a trailing window.
// The empirical mean log-return × 252 estimates the log-drift ν.
// The arithmetic drift is μ = ν + σ²/2, so that downstream ν = μ − σ²/2
// recovers the empirical log-drift exactly (no double counting).
function annualMuArith(logret, window) {
  const w = logret.slice(-Math.min(window, logret.length));
  const muLog = mean(w) * TRADING_DAYS_YEAR;
  const sd = sampleStd(w);
  const varAnnual = sd * sd * TRADING_DAYS_YEAR; // = σ²_annual
  return muLog + 0.5 * varAnnual;
}
function pctReturn(closes, lookbackTradingDays) {
  const i = closes.length - 1 - lookbackTradingDays;
  if (i < 0) return null;
  return (closes[closes.length - 1] / closes[i] - 1) * 100;
}

function sanitizeSymbol(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase();
  // letters, digits, dot, hyphen (covers BRK.B, equities, most tickers)
  if (!/^[A-Z0-9.\-]{1,12}$/.test(s)) return null;
  return s;
}

// FMP /stable/historical-price-eod/full returns either a flat array
// or (on some plans) an object { symbol, historical:[...] }. Handle both.
function extractHistorical(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.historical)) return json.historical;
  return [];
}

export default async function handler(req, res) {
  // CORS so the page works even if hosted on a different origin than the API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const apikey = process.env.FMP_API_KEY;
  if (!apikey) {
    return res.status(500).json({ error: "Missing FMP_API_KEY on the server. Set it as an environment variable." });
  }

  const symbol = sanitizeSymbol(req.query.symbol || "ADBE");
  if (!symbol) {
    return res.status(400).json({ error: "Invalid symbol. Use letters/digits, e.g. ADBE, AAPL, BRK.B." });
  }

  // pull ~400 calendar days to guarantee >=252 trading days
  const to = new Date();
  const from = new Date(to.getTime() - 400 * 24 * 3600 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const histUrl = `${FMP_BASE}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${iso(from)}&to=${iso(to)}&apikey=${apikey}`;
  const quoteUrl = `${FMP_BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apikey}`;

  try {
    const [histR, quoteR] = await Promise.all([fetch(histUrl), fetch(quoteUrl)]);

    if (!histR.ok) return res.status(502).json({ error: `FMP history error (${histR.status}).` });
    const histJson = await histR.json();
    let hist = extractHistorical(histJson);

    if (!hist.length) {
      return res.status(404).json({ error: `No price data for "${symbol}". Check the ticker or your FMP plan coverage.` });
    }

    // ascending by date
    hist.sort((a, b) => (a.date < b.date ? -1 : 1));
    const series = hist
      .filter((p) => typeof p.close === "number" && p.close > 0)
      .map((p) => ({ d: p.date, c: p.close }));
    const closes = series.map((p) => p.c);

    const quoteJson = await quoteR.json().catch(() => []);
    const q = Array.isArray(quoteJson) && quoteJson[0] ? quoteJson[0] : {};
    const name = q.name || symbol;

    const logret = logReturns(closes);
    const vol6 = annualVol(logret, 126) * 100;
    const vol12 = annualVol(logret, 252) * 100;
    const mu6 = annualMuArith(logret, 126) * 100;
    const mu12 = annualMuArith(logret, 252) * 100;

    // returns by trading-day offsets
    const daily = closes.length >= 2 ? (closes[closes.length - 1] / closes[closes.length - 2] - 1) * 100 : null;
    const m1 = pctReturn(closes, 21);
    const m3 = pctReturn(closes, 63);
    const m6 = pctReturn(closes, 126);
    const y1 = pctReturn(closes, 252);

    // YTD: last close of previous year as base
    const curYear = series[series.length - 1].d.slice(0, 4);
    let ytd = null;
    const prevYearIdx = series.map((p) => p.d.slice(0, 4)).lastIndexOf(String(Number(curYear) - 1));
    if (prevYearIdx >= 0) ytd = (closes[closes.length - 1] / closes[prevYearIdx] - 1) * 100;

    const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

    return res.status(200).json({
      symbol,
      name,
      asOf: series[series.length - 1].d,
      range: `${series[0].d} → ${series[series.length - 1].d}`,
      lastClose: Math.round(closes[closes.length - 1] * 100) / 100,
      returns: { daily: round1(daily), m1: round1(m1), m3: round1(m3), m6: round1(m6), ytd: round1(ytd), y1: round1(y1) },
      vol6: round1(vol6),
      vol12: round1(vol12),
      mu6: round1(mu6),
      mu12: round1(mu12),
      series,
    });
  } catch (e) {
    return res.status(500).json({ error: "Network/parse failure contacting FMP.", detail: String(e) });
  }
}
