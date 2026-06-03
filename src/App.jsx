import React, { useState, useMemo, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart, ComposedChart, Bar, BarChart, Cell, ReferenceLine } from "recharts";

// ===== Fallback snapshot (ADBE) shown before the first live fetch =====
const FALLBACK = {
  symbol: "ADBE", name: "Adobe Inc.", asOf: "2026-06-02",
  range: "2025-05-22 → 2026-06-02", lastClose: 262.11,
  returns: { daily: -4.3, m1: 4.5, m3: -3.3, m6: -18.1, ytd: -21.4, y1: -36.9 },
  vol6: 39.7, vol12: 33.6, mu6: -32.2, mu12: -40.2, rate: 4.46, rateDate: "2026-06-02",
  series: [],
};

// ---------- Math: First Passage Time for GBM ----------
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}
function Phi(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function touchProb(b, nu, sigma, t) {
  if (t <= 0 || sigma <= 0) return 0;
  const s = sigma * Math.sqrt(t);
  const term1 = Phi((-b + nu * t) / s);
  const exponent = (2 * nu * b) / (sigma * sigma);
  const safeExp = exponent > 50 ? Math.exp(50) : Math.exp(exponent);
  const term2 = safeExp * Phi((-b - nu * t) / s);
  return Math.min(1, Math.max(0, term1 + term2));
}
function finishProb(b, nu, sigma, t) {
  if (t <= 0 || sigma <= 0) return 0;
  const s = sigma * Math.sqrt(t);
  return Math.min(1, Math.max(0, Phi((-b + nu * t) / s)));
}

// ---------- Black-Scholes-Merton (risk-neutral) call price ----------
function bsmCall(S, K, T, r, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(0, S - K * Math.exp(-r * T));
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  return S * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
}
// Back out IV from a market premium by bisection. null if premium <= intrinsic (no time value).
function impliedVol(price, S, K, T, r) {
  const intrinsic = Math.max(0, S - K * Math.exp(-r * T));
  if (!(price > intrinsic + 1e-4) || T <= 0) return null;
  let lo = 1e-4, hi = 5;
  if (bsmCall(S, K, T, r, hi) < price) return null;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (bsmCall(S, K, T, r, mid) > price) hi = mid; else lo = mid;
  }
  return 0.5 * (lo + hi);
}
// ---------- Long-call economics under a chosen (physical) measure ----------
// mu, sigma annualized (decimals); T in years; premium per share.
function callEconomics(S0, K, premium, sigma, mu, r, T) {
  const sqrtT = Math.sqrt(T);
  const drift = (mu - 0.5 * sigma * sigma) * T; // drift of ln(S_T)
  const s = sigma * sqrtT;
  const d2 = (Math.log(S0 / K) + drift) / s; // P(S_T > K)
  const d1 = d2 + s;
  const pITM = Phi(d2);
  const expPayoff = S0 * Math.exp(mu * T) * Phi(d1) - K * Phi(d2); // E_P[max(S_T-K,0)], value at expiry
  const BE = K + premium;
  const POP = Phi((Math.log(S0 / BE) + drift) / s);
  const EV = expPayoff - premium * Math.exp(r * T); // expected profit at expiry vs risk-free-grown premium
  const EVpct = premium > 0 ? (EV / premium) * 100 : 0;
  const iv = impliedVol(premium, S0, K, T, r);
  return { K, premium, BE, pITM: pITM * 100, POP: POP * 100, expPayoff, EV, EVpct, iv: iv == null ? null : iv * 100 };
}

const HORIZONS = [
  { label: "שבועיים", years: 14 / 365 },
  { label: "חודש", years: 1 / 12 },
  { label: "חודשיים", years: 2 / 12 },
  { label: "3 חודשים", years: 3 / 12 },
  { label: "חצי שנה", years: 6 / 12 },
  { label: "9 חודשים", years: 9 / 12 },
  { label: "שנה", years: 1 },
];

const PERIODS = [
  { label: "שבוע", n: 5 },
  { label: "חודש", n: 21 },
  { label: "3 ח׳", n: 63 },
  { label: "6 ח׳", n: 126 },
  { label: "שנה", n: 252 },
  { label: "שנתיים", n: 504 },
];

// JS color tokens (mirror the CSS vars) for recharts + value-driven colors
const C = {
  ink: "#e6edf3", sub: "#c2cdd9", panel: "#0e141c", border: "#1d2632",
  accent: "#22d3ee", rn: "#8b5cf6", ph: "#f472b6", iv: "#38bdf8", fin: "#6b7a8d",
  up: "#2ee6a8", down: "#ff5470", grid: "#19212c", hist: "#8b5cf6",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Assistant:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
*{box-sizing:border-box}
:root{
  --ink:#e6edf3; --sub:#c2cdd9;
  --panel-a:rgba(255,255,255,.05); --panel-b:rgba(255,255,255,.018);
  --border:rgba(255,255,255,.08);
  --accent:#22d3ee; --rn:#8b5cf6; --ph:#f472b6; --iv:#38bdf8; --fin:#6b7a8d;
  --up:#2ee6a8; --down:#ff5470;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
}
.app{min-height:100vh;color:var(--ink);padding:24px 22px 44px;font-size:16px;
  font-family:'Assistant',system-ui,sans-serif;
  background:
    radial-gradient(1100px 520px at 88% -8%,rgba(139,92,246,.12),transparent 60%),
    radial-gradient(900px 500px at 4% 112%,rgba(34,211,238,.09),transparent 60%),
    #070b11;}
.wrap{max-width:1360px;margin:0 auto}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}

.topbar{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.eyebrow{font-family:var(--mono);font-size:13px;letter-spacing:2.5px;color:var(--accent);margin-bottom:8px;font-weight:600}
.title{margin:0;font-size:30px;font-weight:700;letter-spacing:-.3px}
.symbox{display:flex;gap:8px}
.sym-input{width:160px;text-transform:uppercase;letter-spacing:2px;font-family:var(--mono);
  background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--ink);
  border-radius:10px;padding:11px 13px;font-size:17px;outline:none}
.sym-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(34,211,238,.15)}
.load-btn{border:none;cursor:pointer;border-radius:10px;padding:0 22px;font-weight:700;font-size:15px;
  font-family:inherit;color:#06121c;background:linear-gradient(135deg,#22d3ee,#8b5cf6);
  display:flex;align-items:center;gap:8px;box-shadow:0 4px 20px rgba(124,92,246,.3);transition:box-shadow .2s,transform .1s}
.load-btn:hover{box-shadow:0 6px 28px rgba(124,92,246,.45)}
.load-btn:active{transform:translateY(1px)}
.load-btn:disabled{opacity:.6;cursor:default}

.errbar{background:rgba(255,84,112,.1);border:1px solid rgba(255,84,112,.5);color:#ffb3c0;
  border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:15px;font-weight:600}

.card{position:relative;background:linear-gradient(180deg,var(--panel-a),var(--panel-b));
  border:1px solid var(--border);border-radius:14px;padding:17px;overflow:hidden;backdrop-filter:blur(6px)}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(139,92,246,.55),rgba(34,211,238,.55),transparent)}
.card-title{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:var(--ink);margin-bottom:14px;font-weight:700}

.grid-main{display:grid;grid-template-columns:1.45fr 1fr;gap:14px;margin-bottom:14px}
.grid-lower{display:grid;grid-template-columns:1.25fr 1fr;gap:14px;margin-bottom:14px}
@media(max-width:1000px){.grid-main,.grid-lower{grid-template-columns:1fr}}

.price-head{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.price-id{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sym{font-size:23px;font-weight:700}
.px{font-family:var(--mono);font-size:21px;color:var(--accent);font-weight:600}
.nm{font-size:14px;color:var(--sub);font-weight:600}
.periods{display:flex;gap:3px;background:rgba(255,255,255,.03);padding:3px;border-radius:10px;border:1px solid var(--border)}
.pbtn{border:none;background:transparent;color:var(--ink);font-family:var(--mono);font-size:14px;font-weight:600;
  padding:7px 11px;border-radius:7px;cursor:pointer;transition:all .15s}
.pbtn:hover{color:var(--accent)}
.pbtn.on{background:rgba(34,211,238,.16);color:var(--accent);box-shadow:inset 0 0 0 1px rgba(34,211,238,.45)}

.returns{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-top:13px}
.chip{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:9px;padding:9px 5px;text-align:center}
.chip .l{font-size:12px;color:var(--ink);margin-bottom:4px;font-weight:600}
.chip .v{font-family:var(--mono);font-size:16px;font-weight:600}

.inputs{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:13px}
.field label{display:block;font-size:13px;color:var(--ink);margin-bottom:6px;letter-spacing:.2px;font-weight:600}
.field input{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--ink);
  border-radius:9px;padding:10px 12px;font-size:16px;font-family:var(--mono);outline:none}
.field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(34,211,238,.13)}

.movebar{display:flex;gap:16px;flex-wrap:wrap;align-items:center;background:rgba(255,255,255,.03);
  border:1px solid var(--border);border-radius:10px;padding:11px 14px;font-size:15px;color:var(--ink);margin-bottom:13px;font-weight:600}
.movebar b{font-family:var(--mono)}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.stat{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:10px 13px}
.stat .h{font-size:12px;color:var(--ink);margin-bottom:6px;font-weight:600}
.stat .row{display:flex;gap:16px;font-size:15px;font-family:var(--mono);font-weight:600}

.tbl-scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:15px;min-width:480px}
thead th{font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink);text-align:right;
  padding:9px 9px;border-bottom:1px solid var(--border);font-weight:700;white-space:nowrap}
tbody td{padding:10px 9px;border-bottom:1px solid rgba(255,255,255,.04);font-family:var(--mono);white-space:nowrap;font-weight:500;direction:ltr;unicode-bidi:isolate}
tbody tr:hover{background:rgba(255,255,255,.03)}
tbody td:first-child{font-family:'Assistant',sans-serif;color:var(--ink);font-weight:600;direction:rtl}

.dstat{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:15px}
.dstat:last-child{border-bottom:none}
.dstat .k{color:var(--ink);font-weight:600}
.dstat .val{font-family:var(--mono);font-weight:600}

.notes{font-size:14px;color:var(--sub);line-height:1.8;font-weight:500}
.notes b,.notes strong{color:var(--ink);font-weight:700}
.spin{width:14px;height:14px;border:2px solid #06121c;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.num,.px,.chip .v,.stat .row b,.dstat .val,.movebar b.n{direction:ltr;unicode-bidi:isolate}

/* ---- options ranker ---- */
.opt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:11px;margin-bottom:14px}
@media(max-width:560px){.opt-grid{grid-template-columns:1fr}}
.opt-tbl{width:100%;border-collapse:collapse;font-size:15px;min-width:300px}
.opt-tbl th{font-size:12px;text-transform:uppercase;letter-spacing:.4px;color:var(--ink);text-align:right;padding:7px 9px;border-bottom:1px solid var(--border);font-weight:700}
.opt-tbl td{padding:6px 9px}
.opt-tbl input{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--border);color:var(--ink);border-radius:8px;padding:8px 10px;font-size:15px;font-family:var(--mono);outline:none}
.opt-tbl input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(34,211,238,.13)}
.minibtn{background:rgba(255,255,255,.04);border:1px solid var(--border);color:var(--ink);border-radius:8px;cursor:pointer;padding:8px 15px;font-size:14px;font-family:inherit;font-weight:600;transition:all .15s}
.minibtn:hover{border-color:var(--accent);color:var(--accent)}
.delbtn{background:none;border:1px solid var(--border);color:var(--down);border-radius:7px;cursor:pointer;padding:6px 10px;font-size:13px;line-height:1}
.delbtn:hover{border-color:var(--down)}
.implied-btn{width:100%;text-align:right;cursor:pointer;background:rgba(34,211,238,.07);border:1px solid var(--border);color:var(--accent);border-radius:9px;padding:10px 12px;font-size:15px;font-family:var(--mono);font-weight:600;transition:all .15s}
.implied-btn:hover{border-color:var(--accent);box-shadow:0 0 0 3px rgba(34,211,238,.12)}
.musrc{flex-wrap:wrap;gap:4px}
.musrc .pbtn{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.musrc .n{direction:ltr;unicode-bidi:isolate;font-family:var(--mono);font-size:13px}
.rank-row1 td{background:rgba(34,211,238,.07)}
.warnbox{background:rgba(244,114,182,.07);border:1px solid rgba(244,114,182,.35);color:var(--ph);border-radius:10px;padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:16px}
.warnbox b{color:var(--ink)}
`;

export default function App() {
  const [snap, setSnap] = useState(FALLBACK);
  const [symbolInput, setSymbolInput] = useState("ADBE");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [periodIdx, setPeriodIdx] = useState(4); // default: שנה

  const [S0, setS0] = useState(FALLBACK.lastClose);
  const [ST, setST] = useState(350);
  const [sigmaPct, setSigmaPct] = useState(FALLBACK.vol12);
  const [muHistPct, setMuHistPct] = useState(FALLBACK.mu12);
  const [rPct, setRPct] = useState(FALLBACK.rate);
  const [ivStr, setIvStr] = useState("");
  const [touched, setTouched] = useState(false);

  // ----- Options-ranking module state -----
  const [optDays, setOptDays] = useState(182);   // tenor in calendar days (~6m)
  const [targetPx, setTargetPx] = useState(320);  // thesis price target (for implied-drift helper)
  const [rankBy, setRankBy] = useState("EVpct");
  const [options, setOptions] = useState([        // PLACEHOLDER quotes — replace with real broker mid/ask
    { id: 1, K: 280, premium: 18 },
    { id: 2, K: 300, premium: 11 },
    { id: 3, K: 320, premium: 6.5 },
  ]);

  const fetchSymbol = useCallback(async (sym) => {
    const s = (sym || "").trim().toUpperCase();
    if (!s) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/stock?symbol=${encodeURIComponent(s)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
      setSnap(data);
      setS0(data.lastClose);
      setSigmaPct(data.vol12);
      setMuHistPct(data.mu12);
      if (typeof data.rate === "number") setRPct(data.rate);
      setTouched(false);
    } catch (e) {
      setErr(e.message || "כשל בטעינת הנתונים");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSymbol("ADBE"); }, [fetchSymbol]);

  const sigma = sigmaPct / 100;
  const muHist = muHistPct / 100;
  const r = rPct / 100;
  const ivNum = parseFloat(ivStr);
  const hasIV = Number.isFinite(ivNum) && ivNum > 0;
  const ivSigma = hasIV ? ivNum / 100 : null;
  const b = Math.log(ST / S0);
  const isUp = ST > S0;

  const fullSeries = useMemo(() => (snap.series || []).map(p => ({ date: p.d, close: p.c })), [snap]);
  const chartData = useMemo(() => {
    const n = PERIODS[periodIdx].n;
    return fullSeries.slice(-n);
  }, [fullSeries, periodIdx]);
  const shortRange = PERIODS[periodIdx].n <= 63;
  const xFmt = (d) => shortRange ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : `${d.slice(5, 7)}/${d.slice(2, 4)}`;

  const table = useMemo(() => {
    const nuRN = r - 0.5 * sigma * sigma;
    const nuPh = muHist - 0.5 * sigma * sigma;
    const nuIV = hasIV ? r - 0.5 * ivSigma * ivSigma : 0;
    return HORIZONS.map(h => ({
      label: h.label,
      touchRN: touchProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, h.years) * 100,
      touchPh: touchProb(Math.abs(b), isUp ? nuPh : -nuPh, sigma, h.years) * 100,
      finishRN: finishProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, h.years) * 100,
      finishPh: finishProb(Math.abs(b), isUp ? nuPh : -nuPh, sigma, h.years) * 100,
      touchIV: hasIV ? touchProb(Math.abs(b), isUp ? nuIV : -nuIV, ivSigma, h.years) * 100 : null,
      finishIV: hasIV ? finishProb(Math.abs(b), isUp ? nuIV : -nuIV, ivSigma, h.years) * 100 : null,
    }));
  }, [b, sigma, muHist, r, isUp, hasIV, ivSigma]);

  const curve = useMemo(() => {
    const nuRN = r - 0.5 * sigma * sigma;
    const nuPh = muHist - 0.5 * sigma * sigma;
    const nuIV = hasIV ? r - 0.5 * ivSigma * ivSigma : 0;
    const pts = [];
    for (let m = 0.25; m <= 12.01; m += 0.25) {
      const t = m / 12;
      const row = {
        month: m,
        "Touch · RN": +(touchProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, t) * 100).toFixed(1),
        "Touch · Physical": +(touchProb(Math.abs(b), isUp ? nuPh : -nuPh, sigma, t) * 100).toFixed(1),
        "Finish · RN": +(finishProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, t) * 100).toFixed(1),
      };
      if (hasIV) row["Touch · IV"] = +(touchProb(Math.abs(b), isUp ? nuIV : -nuIV, ivSigma, t) * 100).toFixed(1);
      pts.push(row);
    }
    return pts;
  }, [b, sigma, muHist, r, isUp, hasIV, ivSigma]);

  // ----- Options ranking: physical-measure EV per strike (held to expiry) -----
  const optT = optDays / 365;
  const impliedMuPct = optT > 0 ? (Math.log(targetPx / S0) / optT) * 100 : 0; // drift whose MEAN path lands on target

  const rankedOptions = useMemo(() => {
    const rows = options
      .filter(o => o.K > 0 && o.premium > 0)
      .map(o => ({ id: o.id, ...callEconomics(S0, o.K, o.premium, sigma, muHist, r, optT) }));
    const higherBetter = rankBy !== "iv"; // for IV, cheaper (lower) ranks first
    const fb = higherBetter ? -Infinity : Infinity;
    const sorted = [...rows].sort((x, y) => {
      const xv = x[rankBy] == null ? fb : x[rankBy];
      const yv = y[rankBy] == null ? fb : y[rankBy];
      return higherBetter ? yv - xv : xv - yv;
    });
    return sorted.map((row, i) => ({ ...row, rank: i + 1 }));
  }, [options, S0, sigma, muHist, r, optT, rankBy]);

  // Historical daily log-return distribution + moments + normal overlay
  const dist = useMemo(() => {
    const closes = (snap.series || []).map(p => p.c);
    if (closes.length < 20) return null;
    const lr = [];
    for (let i = 1; i < closes.length; i++) lr.push(Math.log(closes[i] / closes[i - 1]) * 100); // daily %
    const n = lr.length;
    const m = lr.reduce((s, x) => s + x, 0) / n;
    const variance = lr.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
    const sd = Math.sqrt(variance);
    const skew = lr.reduce((s, x) => s + Math.pow((x - m) / sd, 3), 0) / n;
    const kurt = lr.reduce((s, x) => s + Math.pow((x - m) / sd, 4), 0) / n - 3;
    const lo = m - 4 * sd, hi = m + 4 * sd, bins = 27, w = (hi - lo) / bins;
    const counts = new Array(bins).fill(0);
    lr.forEach(x => { let idx = Math.floor((x - lo) / w); if (idx < 0) idx = 0; if (idx >= bins) idx = bins - 1; counts[idx]++; });
    const data = counts.map((c, i) => {
      const center = lo + (i + 0.5) * w;
      const density = (1 / (sd * Math.sqrt(2 * Math.PI))) * Math.exp(-((center - m) * (center - m)) / (2 * variance));
      return { x: +center.toFixed(2), count: c, normal: +(density * n * w).toFixed(2) };
    });
    return { data, m, sd, skew, kurt, worst: Math.min(...lr), best: Math.max(...lr), n, annSd: sd * Math.sqrt(252) };
  }, [snap]);

  const pct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const pctColor = (v) => v == null ? C.sub : v >= 0 ? C.up : C.down;

  const updateOpt = (id, field, val) => setOptions(os => os.map(o => o.id === id ? { ...o, [field]: val === "" ? "" : +val } : o));
  const addOpt = () => setOptions(os => [...os, { id: os.reduce((m, o) => Math.max(m, o.id), 0) + 1, K: 0, premium: 0 }]);
  const removeOpt = (id) => setOptions(os => os.filter(o => o.id !== id));
  const RANK_LABELS = { EVpct: "תוחלת תשואה %", EV: "תוחלת רווח $", POP: "Prob. of Profit", iv: "IV · זול→יקר" };

  // μ source selector helpers (writes into the shared μ field)
  const muFmt = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
  const muMatch = (v) => v != null && Math.abs(muHistPct - v) < 0.06;
  const applyMu = (v) => { if (v == null) return; setMuHistPct(+v.toFixed(1)); setTouched(true); };
  const onModel = (setter) => (e) => { setter(+e.target.value); setTouched(true); };

  const chips = [
    ["יומי", snap.returns.daily], ["חודש", snap.returns.m1], ["3 ח׳", snap.returns.m3],
    ["6 ח׳", snap.returns.m6], ["YTD", snap.returns.ytd], ["שנה", snap.returns.y1],
  ];

  return (
    <div className="app" dir="rtl">
      <style>{CSS}</style>
      <div className="wrap">

        {/* Top bar */}
        <div className="topbar">
          <div>
            <div className="eyebrow">FIRST PASSAGE TIME · GBM · LIVE FMP</div>
            <h1 className="title">הסתברות הגעה למחיר יעד</h1>
          </div>
          <div className="symbox">
            <input className="sym-input" value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchSymbol(symbolInput)}
              placeholder="ADBE" />
            <button className="load-btn" onClick={() => fetchSymbol(symbolInput)} disabled={loading}>
              {loading && <span className="spin" />}{loading ? "טוען" : "טען"}
            </button>
          </div>
        </div>

        {err && <div className="errbar">⚠ {err}</div>}

        {/* Main grid: price + parameters */}
        <div className="grid-main">

          {/* PRICE */}
          <div className="card" style={{ opacity: loading ? 0.6 : 1, transition: "opacity .2s" }}>
            <div className="price-head">
              <div className="price-id">
                <span className="sym">{snap.symbol}</span>
                <span className="px">${snap.lastClose}</span>
                {snap.name && snap.name !== snap.symbol && <span className="nm">{snap.name}</span>}
              </div>
              <div className="periods">
                {PERIODS.map((p, i) => (
                  <button key={i} className={"pbtn" + (i === periodIdx ? " on" : "")} onClick={() => setPeriodIdx(i)}>{p.label}</button>
                ))}
              </div>
            </div>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={196}>
                <AreaChart data={chartData} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="px" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.accent} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="date" stroke={C.sub} tick={{ fontSize: 10 }} minTickGap={42} tickFormatter={xFmt} />
                  <YAxis stroke={C.sub} tick={{ fontSize: 10 }} domain={["auto", "auto"]} width={46} />
                  <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 12 }} />
                  <Area type="monotone" dataKey="close" stroke={C.accent} strokeWidth={2} fill="url(#px)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <div style={{ height: 196, display: "flex", alignItems: "center", justifyContent: "center", color: C.sub, fontSize: 13 }}>טוען נתונים…</div>}
            <div className="returns">
              {chips.map(([l, v], i) => (
                <div className="chip" key={i}><div className="l">{l}</div><div className="v" style={{ color: pctColor(v) }}>{pct(v)}</div></div>
              ))}
            </div>
          </div>

          {/* PARAMETERS */}
          <div className="card">
            <div className="card-title">פרמטרים</div>
            <div className="inputs">
              <div className="field"><label>מחיר נוכחי ($)</label><input type="number" value={S0} onChange={onModel(setS0)} /></div>
              <div className="field"><label>מחיר יעד ($)</label><input type="number" value={ST} onChange={onModel(setST)} /></div>
              <div className="field"><label>σ שנתי (%)</label><input type="number" value={sigmaPct} onChange={onModel(setSigmaPct)} /></div>
              <div className="field"><label>μ ארית׳ שנתי (%)</label><input type="number" value={muHistPct} onChange={onModel(setMuHistPct)} /></div>
              <div className="field"><label style={{ color: C.accent }}>ריבית r (%) · חי · 10Y</label><input type="number" value={rPct} readOnly tabIndex={-1} style={{ color: C.accent, cursor: "default" }} /></div>
              <div className="field"><label style={{ color: C.iv }}>IV גלום (%) · רשות</label><input type="number" value={ivStr} placeholder="מהברוקר" style={hasIV ? { borderColor: C.iv } : undefined} onChange={(e) => { setIvStr(e.target.value); setTouched(true); }} /></div>
            </div>
            <div className="movebar">
              <span>תנועה: <b className="n" style={{ color: isUp ? C.up : C.down }}>{((ST / S0 - 1) * 100).toFixed(1)}%</b></span>
              <span>b = <b className="n" style={{ color: C.ink }}>{b.toFixed(4)}</b></span>
              <span>כיוון: <b style={{ color: isUp ? C.up : C.down }}>{isUp ? "עלייה ↑" : "ירידה ↓"}</b></span>
            </div>
            <div className="stats">
              <div className="stat">
                <div className="h">חצי שנה · ≈126 ימים</div>
                <div className="row"><span>σ <b style={{ color: C.rn }}>{snap.vol6?.toFixed(1)}%</b></span><span>μ <b style={{ color: pctColor(snap.mu6) }}>{pct(snap.mu6)}</b></span></div>
              </div>
              <div className="stat">
                <div className="h">שנה · ≈252 ימים</div>
                <div className="row"><span>σ <b style={{ color: C.rn }}>{snap.vol12?.toFixed(1)}%</b></span><span>μ <b style={{ color: pctColor(snap.mu12) }}>{pct(snap.mu12)}</b></span></div>
              </div>
            </div>
            <div style={{ fontSize: 13, color: C.sub, marginTop: 10, lineHeight: 1.5, fontWeight: 500 }}>
              מאותחל ב-σ/μ של שנה. ריבית r = תשואת אג״ח ממשלתי 10Y חיה{snap.rateDate ? ` (${snap.rateDate})` : ""}, לקריאה בלבד.{touched && <span style={{ color: C.ph }}> ערכים נערכו ידנית.</span>}
            </div>
          </div>
        </div>

        {/* Lower grid: table + curve */}
        <div className="grid-lower">
          <div className="card">
            <div className="card-title">הסתברויות לפי אופק זמן</div>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>אופק</th>
                    <th style={{ color: C.rn }}>Touch·RN</th>
                    <th style={{ color: C.ph }}>Touch·Phys</th>
                    <th>Finish·RN</th>
                    <th>Finish·Phys</th>
                    {hasIV && <th style={{ color: C.iv }}>Touch·IV</th>}
                    {hasIV && <th style={{ color: C.iv }}>Finish·IV</th>}
                  </tr>
                </thead>
                <tbody>
                  {table.map((row, i) => (
                    <tr key={i}>
                      <td>{row.label}</td>
                      <td style={{ color: C.rn, fontWeight: 600 }}>{row.touchRN.toFixed(1)}%</td>
                      <td style={{ color: C.ph, fontWeight: 600 }}>{row.touchPh.toFixed(1)}%</td>
                      <td style={{ color: C.sub }}>{row.finishRN.toFixed(1)}%</td>
                      <td style={{ color: C.sub }}>{row.finishPh.toFixed(1)}%</td>
                      {hasIV && <td style={{ color: C.iv, fontWeight: 600 }}>{row.touchIV.toFixed(1)}%</td>}
                      {hasIV && <td style={{ color: C.iv }}>{row.finishIV.toFixed(1)}%</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title">עקומת הסתברות · לפי חודשים</div>
            <ResponsiveContainer width="100%" height={284}>
              <LineChart data={curve} margin={{ top: 4, right: 14, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                <XAxis dataKey="month" stroke={C.sub} tick={{ fontSize: 11 }} />
                <YAxis stroke={C.sub} tick={{ fontSize: 11 }} domain={[0, 100]} width={32} />
                <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="Touch · RN" stroke={C.rn} strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="Touch · Physical" stroke={C.ph} strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="Finish · RN" stroke={C.fin} strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
                {hasIV && <Line type="monotone" dataKey="Touch · IV" stroke={C.iv} strokeWidth={2.5} dot={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Return distribution row */}
        {dist && (
          <div className="grid-lower">
            <div className="card">
              <div className="card-title">התפלגות תשואות יומיות · מול נורמל</div>
              <ResponsiveContainer width="100%" height={262}>
                <ComposedChart data={dist.data} margin={{ top: 4, right: 14, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="x" stroke={C.sub} tick={{ fontSize: 11 }} tickFormatter={(v) => `${v}%`} minTickGap={28} />
                  <YAxis stroke={C.sub} tick={{ fontSize: 11 }} width={32} />
                  <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 13 }}
                    formatter={(val, name) => [val, name === "count" ? "ימים בפועל" : "נורמל צפוי"]} labelFormatter={(l) => `תשואה ${l}%`} />
                  <Bar dataKey="count" fill={C.hist} fillOpacity={0.55} radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="normal" stroke={C.accent} strokeWidth={2.5} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-title">מומנטים של ההתפלגות</div>
              <div className="dstat"><span className="k">ימי מסחר במדגם</span><span className="val" style={{ color: C.ink }}>{dist.n}</span></div>
              <div className="dstat"><span className="k">σ יומי</span><span className="val" style={{ color: C.rn }}>{dist.sd.toFixed(2)}%</span></div>
              <div className="dstat"><span className="k">σ מנותח שנתי</span><span className="val" style={{ color: C.rn }}>{dist.annSd.toFixed(1)}%</span></div>
              <div className="dstat"><span className="k">Skew (אסימטריה)</span><span className="val" style={{ color: dist.skew < -0.2 ? C.down : dist.skew > 0.2 ? C.up : C.ink }}>{dist.skew.toFixed(2)}</span></div>
              <div className="dstat"><span className="k">Excess Kurtosis</span><span className="val" style={{ color: dist.kurt > 1 ? C.ph : C.ink }}>{dist.kurt.toFixed(2)}</span></div>
              <div className="dstat"><span className="k">היום הגרוע ביותר</span><span className="val" style={{ color: C.down }}>{dist.worst.toFixed(1)}%</span></div>
              <div className="dstat"><span className="k">היום הטוב ביותר</span><span className="val" style={{ color: C.up }}>{dist.best.toFixed(1)}%</span></div>
              <div style={{ marginTop: 12, fontSize: 13.5, color: C.sub, lineHeight: 1.7, fontWeight: 500 }}>
                {dist.kurt > 1
                  ? <><b style={{ color: C.ph }}>Fat tails:</b> קורטוזיס עודף חיובי משמעותי — קפיצות קיצוניות שכיחות יותר ממה ש-GBM (נורמלי) מניח. ההסתברויות למהלכים גדולים <b>מוערכות בחסר</b> במודל.</>
                  : <>קורטוזיס עודף נמוך — ההתפלגות קרובה יחסית לנורמלית, והנחת ה-GBM סבירה כאן.</>}
                {dist.skew < -0.2 && <> {" "}<b style={{ color: C.down }}>Skew שלילי</b> — נטייה לזנב ירידות חד.</>}
              </div>
            </div>
          </div>
        )}

        {/* ===== Options ranking module ===== */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>CALL OPTION RANKER · EXPECTED VALUE · HELD TO EXPIRY</div>
          <div className="card-title" style={{ marginBottom: 6 }}>דירוג אופציות CALL לפי תוחלת רווח</div>
          <div style={{ color: C.sub, fontSize: 14, lineHeight: 1.7, marginBottom: 16, fontWeight: 500, maxWidth: 760 }}>
            הזן עבור כל סטרייק את הפרמיה האמיתית מהברוקר. הכלי מחשב תוחלת רווח תחת ה-<b style={{ color: C.ink }}>μ</b> וה-<b style={{ color: C.rn }}>σ</b> שמוגדרים למעלה,
            מחלץ את ה-<b style={{ color: C.iv }}>IV</b> הגלום בכל פרמיה, ומדרג מהכדאי ביותר לפחות. ההנחה: אחזקה עד פקיעה (finish), לא נגיעה (touch).
          </div>

          {/* tenor + thesis-implied drift */}
          <div className="opt-grid">
            <div className="field"><label>ימים לפקיעה</label><input type="number" value={optDays} onChange={(e) => setOptDays(+e.target.value)} /></div>
            <div className="field"><label>מחיר יעד (לחישוב μ)</label><input type="number" value={targetPx} onChange={(e) => setTargetPx(+e.target.value)} /></div>
            <div className="field">
              <label style={{ color: C.accent }}>מקור μ (שנתי)</label>
              <div className="periods musrc">
                <button className={"pbtn" + (muMatch(snap.mu12) ? " on" : "")} onClick={() => applyMu(snap.mu12)} title="μ ארית׳ היסטורי · שנה">
                  היסטורי <span className="n">{muFmt(snap.mu12)}</span>
                </button>
                <button className={"pbtn" + (muMatch(impliedMuPct) ? " on" : "")} onClick={() => applyMu(impliedMuPct)} title="μ שהמסלול הממוצע שלו נוחת על מחיר היעד">
                  תזה <span className="n">{muFmt(impliedMuPct)}</span>
                </button>
                <button className={"pbtn" + (muMatch(rPct) ? " on" : "")} onClick={() => applyMu(rPct)} title="ריסק-נייטרלי · μ=r · benchmark השוק">
                  RN <span className="n">{muFmt(rPct)}</span>
                </button>
              </div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 6, fontWeight: 500 }}>
                {muMatch(snap.mu12) ? "מופעל: μ היסטורי." : muMatch(impliedMuPct) ? "מופעל: μ של התזה." : muMatch(rPct) ? "מופעל: ריסק-נייטרלי." : "מופעל: ערך ידני."}
              </div>
            </div>
          </div>

          <div className="warnbox">
            ⚠ <b>מלכודת ה-μ:</b> בחירת "תזה" מזינה דריפט שהמסלול הממוצע שלו נוחת בדיוק על היעד — כלומר הזנת המסקנה לתוך המודל.
            המספרים שיתקבלו מותנים בכך שהתזה נכונה, ואינם אישוש בלתי-תלוי שלה. השווה תמיד מול "RN" (μ=r) — אם תחת ריסק-נייטרלי ה-EV שלילי, כל ה-edge מגיע מהדריפט בלבד.
            כעת μ = <b>{muHistPct}%</b> · σ = <b>{sigmaPct}%</b> · r = <b>{rPct}%</b>.
          </div>

          {/* editable option rows */}
          <div className="tbl-scroll" style={{ marginBottom: 12 }}>
            <table className="opt-tbl">
              <thead>
                <tr><th>Strike ($)</th><th>פרמיה ($ למניה)</th><th style={{ width: 44 }}></th></tr>
              </thead>
              <tbody>
                {options.map((o) => (
                  <tr key={o.id}>
                    <td><input type="number" value={o.K} onChange={(e) => updateOpt(o.id, "K", e.target.value)} /></td>
                    <td><input type="number" step="0.05" value={o.premium} onChange={(e) => updateOpt(o.id, "premium", e.target.value)} /></td>
                    <td style={{ textAlign: "center" }}><button className="delbtn" title="מחק" onClick={() => removeOpt(o.id)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
            <button className="minibtn" onClick={addOpt}>+ הוסף סטרייק</button>
            <span style={{ fontSize: 13, color: C.sub, fontWeight: 500 }}>הפרמיות כאן הן דוגמה — החלף בציטוט אמיתי מהברוקר.</span>
          </div>

          {/* rank metric selector */}
          <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
            <span style={{ fontSize: 13, color: C.ink, fontWeight: 600 }}>דרג לפי:</span>
            <div className="periods">
              {Object.keys(RANK_LABELS).map((k) => (
                <button key={k} className={"pbtn" + (rankBy === k ? " on" : "")} onClick={() => setRankBy(k)}>{RANK_LABELS[k]}</button>
              ))}
            </div>
          </div>
        </div>

        {/* ranked results + EV chart */}
        <div className="grid-lower">
          <div className="card">
            <div className="card-title">דירוג כדאיות · תחת μ הנוכחי</div>
            <div className="tbl-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Strike</th>
                    <th>פרמיה</th>
                    <th style={{ color: C.iv }}>IV</th>
                    <th>Breakeven</th>
                    <th>POP</th>
                    <th>E[payoff]</th>
                    <th style={{ color: C.accent }}>EV $</th>
                    <th style={{ color: C.accent }}>EV %</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedOptions.map((row) => (
                    <tr key={row.id} className={row.rank === 1 ? "rank-row1" : undefined}>
                      <td style={{ color: row.rank === 1 ? C.accent : C.sub, fontWeight: 700 }}>{row.rank}</td>
                      <td style={{ color: C.ink, fontWeight: 600 }}>{row.K}</td>
                      <td style={{ color: C.sub }}>${row.premium.toFixed(2)}</td>
                      <td style={{ color: C.iv, fontWeight: 600 }}>{row.iv == null ? "—" : row.iv.toFixed(1) + "%"}</td>
                      <td style={{ color: C.sub }}>${row.BE.toFixed(1)}</td>
                      <td>{row.POP.toFixed(1)}%</td>
                      <td style={{ color: C.sub }}>${row.expPayoff.toFixed(2)}</td>
                      <td style={{ color: pctColor(row.EV), fontWeight: 600 }}>{row.EV >= 0 ? "+" : ""}${row.EV.toFixed(2)}</td>
                      <td style={{ color: pctColor(row.EVpct), fontWeight: 700 }}>{row.EVpct >= 0 ? "+" : ""}{row.EVpct.toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title">תוחלת תשואה לפי סטרייק</div>
            {rankedOptions.length > 0 ? (
              <ResponsiveContainer width="100%" height={284}>
                <BarChart data={rankedOptions.map((o) => ({ name: String(o.K), "EV %": +o.EVpct.toFixed(0) }))} margin={{ top: 8, right: 14, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.grid} vertical={false} />
                  <XAxis dataKey="name" stroke={C.sub} tick={{ fontSize: 12 }} />
                  <YAxis stroke={C.sub} tick={{ fontSize: 11 }} width={36} />
                  <ReferenceLine y={0} stroke={C.sub} />
                  <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 12 }} formatter={(v) => [`${v}%`, "תוחלת תשואה"]} labelFormatter={(l) => `Strike ${l}`} />
                  <Bar dataKey="EV %" radius={[4, 4, 0, 0]}>
                    {rankedOptions.map((o) => <Cell key={o.id} fill={o.EVpct >= 0 ? C.up : C.down} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <div style={{ height: 284, display: "flex", alignItems: "center", justifyContent: "center", color: C.sub, fontSize: 13 }}>הזן סטרייק ופרמיה…</div>}
          </div>
        </div>

        {/* Notes */}
        <div className="card notes">
          <strong style={{ color: C.rn }}>Touch</strong> — הסתברות שהמניה תיגע ביעד לפחות פעם אחת (רלוונטי לאחזקת אופציות). תמיד ≥ Finish.{"  ·  "}
          <strong style={{ color: C.fin }}>Finish</strong> — הסתברות לסגירה מעל היעד בסוף התקופה.<br />
          <strong style={{ color: C.ph }}>RN (μ=r)</strong> benchmark הוגן{"  ·  "}<strong style={{ color: C.ph }}>Physical (μ היסטורי)</strong> תזת העבר — ה-edge הוא הפער ביניהן; היזהר מ-μ אופטימי מדי.
          {hasIV && <><br /><strong style={{ color: C.iv }}>IV (שוק)</strong> — אותה הסתברות תחת drift ריסק-נייטרלי אך עם σ=IV שהזנת; זו ההסתברות המשתמעת ממחיר האופציה. הפער מול RN הוא אפקט ה-σ הטהור.</>}
          {hasIV && (() => {
            const gap = ivNum - sigmaPct;
            const col = gap > 3 ? C.down : gap < -3 ? C.up : C.sub;
            return <div style={{ marginTop: 6, color: col }}>פער IV−HV: <b>{gap >= 0 ? "+" : ""}{gap.toFixed(1)} נק׳ σ</b> · {gap > 3 ? "השוק מתמחר תנודתיות גבוהה מההיסטורית — touch מבוסס-HV אופטימי מול הפרמיה." : gap < -3 ? "IV נמוך מההיסטורי — האופציה אולי זולה יחסית." : "IV ו-HV קרובים — בסיס סביר להשוואה."}</div>;
          })()}
          <div style={{ marginTop: 6, fontSize: 13 }}>drift: μ הוא הדריפט הארית׳ (μ = log-drift + σ²/2), כך ש-ν = μ − σ²/2 משחזר את הדריפט הלוגריתמי האמפירי. כל מודל הוא הפשטה; אין כאן ייעוץ השקעות.</div>
        </div>

      </div>
    </div>
  );
}
