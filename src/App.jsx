import React, { useState, useMemo, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart, ComposedChart, Bar, ReferenceLine } from "recharts";

// ===== Fallback snapshot (ADBE) shown before the first live fetch =====
const FALLBACK = {
  symbol: "ADBE", name: "Adobe Inc.", asOf: "2026-06-02",
  range: "2025-05-22 → 2026-06-02", lastClose: 262.11,
  returns: { daily: -4.3, m1: 4.5, m3: -3.3, m6: -18.1, ytd: -21.4, y1: -36.9 },
  vol6: 39.7, vol12: 33.6, mu6: -32.2, mu12: -40.2,
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

// ---- Option pricing & decision-support math ----
function bsCall(S, K, r, sig, T) {
  if (T <= 0 || sig <= 0) return Math.max(S - K, 0);
  const s = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / s, d2 = d1 - s;
  return S * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
}
function bsPut(S, K, r, sig, T) {
  if (T <= 0 || sig <= 0) return Math.max(K - S, 0);
  const s = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / s, d2 = d1 - s;
  return K * Math.exp(-r * T) * Phi(-d2) - S * Phi(-d1);
}
// P(S_T > L) under GBM with arithmetic drift `drift`
function probAbove(S, L, drift, sig, T) {
  if (T <= 0 || sig <= 0) return S > L ? 1 : 0;
  return Phi((Math.log(S / L) + (drift - 0.5 * sig * sig) * T) / (sig * Math.sqrt(T)));
}
// Undiscounted expected payoff under arithmetic drift `drift`
function expCallPayoff(S, K, drift, sig, T) {
  if (T <= 0 || sig <= 0) return Math.max(S - K, 0);
  const s = sig * Math.sqrt(T);
  const D1 = (Math.log(S / K) + (drift + 0.5 * sig * sig) * T) / s, D2 = D1 - s;
  return S * Math.exp(drift * T) * Phi(D1) - K * Phi(D2);
}
function expPutPayoff(S, K, drift, sig, T) {
  if (T <= 0 || sig <= 0) return Math.max(K - S, 0);
  const s = sig * Math.sqrt(T);
  const D1 = (Math.log(S / K) + (drift + 0.5 * sig * sig) * T) / s, D2 = D1 - s;
  return K * Phi(-D2) - S * Math.exp(drift * T) * Phi(-D1);
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
.seg{display:inline-flex;gap:3px;background:rgba(255,255,255,.03);padding:3px;border-radius:9px;border:1px solid var(--border)}
.seg button{border:none;background:transparent;color:var(--ink);font-family:inherit;font-weight:700;font-size:15px;padding:9px 18px;border-radius:7px;cursor:pointer;transition:all .15s}
.seg button.on{background:rgba(34,211,238,.16);color:var(--accent);box-shadow:inset 0 0 0 1px rgba(34,211,238,.45)}
.opt-inputs{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:15px}
.opt-inputs .field{min-width:118px}
.opt-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:14px}
@media(max-width:1000px){.opt-grid{grid-template-columns:1fr}}
.verdict{display:flex;align-items:center;gap:12px;border-radius:11px;padding:14px 16px;margin-bottom:15px;font-weight:700;font-size:18px}
.verdict .dot{width:12px;height:12px;border-radius:50%;flex:none}
.ometrics{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:4px}
.ometric{background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:11px 12px}
.ometric .l{font-size:12px;color:var(--ink);font-weight:600;margin-bottom:6px}
.ometric .v{font-family:var(--mono);font-size:18px;font-weight:600;direction:ltr;unicode-bidi:isolate}
.flags{list-style:none;padding:0;margin:14px 0 0}
.flags li{position:relative;padding:7px 19px 7px 0;font-size:14px;color:var(--sub);font-weight:500;line-height:1.65}
.flags li::before{content:'▸';position:absolute;right:0;top:7px;color:var(--accent)}
.flags li b{color:var(--ink);font-weight:700}
.opt-hint{color:var(--sub);font-size:15px;font-weight:500;padding:8px 0}
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
  const [rPct, setRPct] = useState(4.3);
  const [ivStr, setIvStr] = useState("");
  const [touched, setTouched] = useState(false);

  // option decision-support inputs
  const [optType, setOptType] = useState("call");
  const [strikeStr, setStrikeStr] = useState("");
  const [premStr, setPremStr] = useState("");
  const [expStr, setExpStr] = useState("3"); // months

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

  // ----- Option viability (decision support) -----
  const opt = useMemo(() => {
    const K = parseFloat(strikeStr), prem = parseFloat(premStr), Tm = parseFloat(expStr);
    if (!(K > 0 && prem > 0 && Tm > 0 && S0 > 0)) return null;
    const T = Tm / 12;
    const isCall = optType === "call";
    const physSig = sigma;                 // HV (your σ input)
    const physDrift = muHist;              // arithmetic physical drift
    const mktSig = hasIV ? ivSigma : sigma; // implied σ if provided, else HV
    const be = isCall ? K + prem : K - prem;
    const fair = isCall ? bsCall(S0, K, r, mktSig, T) : bsPut(S0, K, r, mktSig, T);
    const pProfitPhys = (isCall ? probAbove(S0, be, physDrift, physSig, T) : 1 - probAbove(S0, be, physDrift, physSig, T)) * 100;
    const pProfitImpl = (isCall ? probAbove(S0, be, r, mktSig, T) : 1 - probAbove(S0, be, r, mktSig, T)) * 100;
    const pITM = (isCall ? probAbove(S0, K, physDrift, physSig, T) : 1 - probAbove(S0, K, physDrift, physSig, T)) * 100;
    const edge = pProfitPhys - pProfitImpl;
    const expPay = isCall ? expCallPayoff(S0, K, physDrift, physSig, T) : expPutPayoff(S0, K, physDrift, physSig, T);
    const expPnL = expPay - prem;
    const expRet = (expPnL / prem) * 100;
    const moveBE = (be / S0 - 1) * 100;
    const cheapRich = prem / fair - 1; // >0 premium above model fair value
    const lo = S0 * 0.6, hi = S0 * 1.45, steps = 64, pts = [];
    for (let i = 0; i <= steps; i++) {
      const Sx = lo + (hi - lo) * i / steps;
      const pay = isCall ? Math.max(Sx - K, 0) : Math.max(K - Sx, 0);
      pts.push({ s: +Sx.toFixed(2), pnl: +(pay - prem).toFixed(2) });
    }
    return { K, prem, T, Tm, isCall, be, fair, pProfitPhys, pProfitImpl, pITM, edge, expPnL, expRet, moveBE, cheapRich, pts };
  }, [strikeStr, premStr, expStr, optType, S0, sigma, muHist, r, hasIV, ivSigma]);

  const verdict = useMemo(() => {
    if (!opt) return null;
    if (opt.edge > 5 && opt.expRet > 0) return { tone: C.up, label: "edge חיובי לפי ההנחות שלך" };
    if (opt.edge < -5 || opt.expRet < 0) return { tone: C.down, label: "אין edge חיובי לפי הנתונים" };
    return { tone: C.ph, label: "edge גבולי — בדוק רגישות" };
  }, [opt]);

  const pct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const pctColor = (v) => v == null ? C.sub : v >= 0 ? C.up : C.down;
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
              <div className="field"><label>ריבית r (%)</label><input type="number" value={rPct} onChange={onModel(setRPct)} /></div>
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
              מאותחל ב-σ/μ של שנה.{touched && <span style={{ color: C.ph }}> ערכים נערכו ידנית.</span>}
            </div>
          </div>
        </div>

        {/* Decision support: option viability */}
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-title">תומך החלטה · כדאיות אופציה</div>
          <div className="opt-inputs">
            <div className="seg">
              <button className={optType === "call" ? "on" : ""} onClick={() => setOptType("call")}>Call</button>
              <button className={optType === "put" ? "on" : ""} onClick={() => setOptType("put")}>Put</button>
            </div>
            <div className="field"><label>Strike ($)</label><input type="number" value={strikeStr} placeholder="יעד מימוש" onChange={(e) => setStrikeStr(e.target.value)} /></div>
            <div className="field"><label>פרמיה ($)</label><input type="number" value={premStr} placeholder="עלות למניה" onChange={(e) => setPremStr(e.target.value)} /></div>
            <div className="field"><label>פקיעה (חודשים)</label><input type="number" value={expStr} onChange={(e) => setExpStr(e.target.value)} /></div>
          </div>

          {!opt ? (
            <div className="opt-hint">מלא Strike, פרמיה ופקיעה כדי לקבל הערכת כדאיות מבוססת-מודל. {hasIV ? "(שווי הוגן וההסתברות המגולמת מחושבים לפי ה-IV שהזנת.)" : "(ללא IV — החישוב מבוסס σ היסטורי; הזן IV לקבלת ההסתברות המגולמת בפרמיה.)"}</div>
          ) : (
            <>
              <div className="verdict" style={{ background: `${verdict.tone}1a`, border: `1px solid ${verdict.tone}66`, color: verdict.tone }}>
                <span className="dot" style={{ background: verdict.tone }} />
                {verdict.label}
              </div>

              <div className="opt-grid">
                {/* Payoff diagram */}
                <div>
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={opt.pts} margin={{ top: 8, right: 14, left: 0, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.grid} />
                      <XAxis dataKey="s" stroke={C.sub} tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(v)}`} minTickGap={32} />
                      <YAxis stroke={C.sub} tick={{ fontSize: 11 }} width={40} tickFormatter={(v) => `${v}`} />
                      <Tooltip contentStyle={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 13 }}
                        formatter={(v) => [`$${v}`, "רווח/הפסד"]} labelFormatter={(l) => `מחיר $${l}`} />
                      <ReferenceLine y={0} stroke={C.sub} strokeDasharray="4 4" />
                      <ReferenceLine x={opt.pts.reduce((a, p) => Math.abs(p.s - S0) < Math.abs(a - S0) ? p.s : a, opt.pts[0].s)} stroke={C.accent} strokeDasharray="3 3" label={{ value: "נוכחי", fill: C.accent, fontSize: 11, position: "top" }} />
                      <ReferenceLine x={opt.pts.reduce((a, p) => Math.abs(p.s - opt.be) < Math.abs(a - opt.be) ? p.s : a, opt.pts[0].s)} stroke={C.ph} strokeDasharray="3 3" label={{ value: "BE", fill: C.ph, fontSize: 11, position: "top" }} />
                      <Line type="monotone" dataKey="pnl" stroke={verdict.tone} strokeWidth={2.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Metrics */}
                <div>
                  <div className="ometrics">
                    <div className="ometric"><div className="l">break-even</div><div className="v">${opt.be.toFixed(2)}</div></div>
                    <div className="ometric"><div className="l">תנועה ל-BE</div><div className="v" style={{ color: opt.moveBE >= 0 ? C.up : C.down }}>{opt.moveBE >= 0 ? "+" : ""}{opt.moveBE.toFixed(1)}%</div></div>
                    <div className="ometric"><div className="l">P(רווח) · פיזי</div><div className="v" style={{ color: C.ph }}>{opt.pProfitPhys.toFixed(1)}%</div></div>
                    <div className="ometric"><div className="l">P(רווח) · מגולם</div><div className="v" style={{ color: C.iv }}>{opt.pProfitImpl.toFixed(1)}%</div></div>
                    <div className="ometric"><div className="l">Edge</div><div className="v" style={{ color: opt.edge >= 0 ? C.up : C.down }}>{opt.edge >= 0 ? "+" : ""}{opt.edge.toFixed(1)} נק׳</div></div>
                    <div className="ometric"><div className="l">תוחלת תשואה</div><div className="v" style={{ color: opt.expRet >= 0 ? C.up : C.down }}>{opt.expRet >= 0 ? "+" : ""}{opt.expRet.toFixed(0)}%</div></div>
                    <div className="ometric"><div className="l">שווי הוגן (BS)</div><div className="v">${opt.fair.toFixed(2)}</div></div>
                    <div className="ometric"><div className="l">הפסד מקסימלי</div><div className="v" style={{ color: C.down }}>-100%</div></div>
                  </div>
                </div>
              </div>

              <ul className="flags">
                <li><b>סיכון מוחלט:</b> אם האופציה פוקעת מחוץ לכסף — הפסד של 100% מהפרמיה (${opt.prem.toFixed(2)} למניה). מינוף גבוה לשני הכיוונים.</li>
                {opt.edge > 5
                  ? <li><b>edge חיובי (+{opt.edge.toFixed(1)} נק׳):</b> המודל הפיזי שלך נותן P(רווח) גבוה מזה שהפרמיה מגלמת. <b>זהירות:</b> התוצאה רגישה מאוד ל-μ — μ אופטימי מדי יוצר edge מדומה (overfitting).</li>
                  : opt.edge < -5
                    ? <li><b>אין edge:</b> הפרמיה מגלמת P(רווח) של {opt.pProfitImpl.toFixed(0)}%, גבוה מ-{opt.pProfitPhys.toFixed(0)}% שהמודל הפיזי נותן — אתה משלם יותר ממה שהתזה שלך מצדיקה.</li>
                    : <li><b>edge גבולי:</b> הפער בין הפיזי למגולם קטן ({opt.edge >= 0 ? "+" : ""}{opt.edge.toFixed(1)} נק׳) — בתוך תחום אי-הוודאות של ההנחות.</li>}
                {hasIV
                  ? (ivNum - sigmaPct > 3
                    ? <li><b>IV &gt; HV ב-{(ivNum - sigmaPct).toFixed(1)} נק׳:</b> אתה משלם תנודתיות יקרה ביחס למה שהמניה מימשה — פרמיה "מנופחת".</li>
                    : ivNum - sigmaPct < -3
                      ? <li><b>IV &lt; HV:</b> התנודתיות הגלומה נמוכה מההיסטורית — האופציה זולה יחסית לתנודתיות שמומשה.</li>
                      : <li>IV ו-HV קרובים — הפרמיה מתומחרת בקירוב לפי התנודתיות ההיסטורית.</li>)
                  : <li>לא הוזן IV — השווי ההוגן וה-P(מגולם) חושבו לפי σ היסטורי. הזן את ה-IV מהברוקר לקבלת ההשוואה המדויקת מול הפרמיה בפועל.</li>}
                {opt.Tm <= 1 && <li><b>theta:</b> פקיעה קצרה ({opt.Tm} ח׳) — שחיקת ערך זמן מהירה. שקול tenor ארוך יותר, או אחזקה ליעד touch מוקדם במקום עד פקיעה.</li>}
                <li style={{ color: C.sub, opacity: 0.85 }}>ניתוח כמותי המותנה כולו בהנחות שהזנת — לא ייעוץ השקעות. ההחלטה בידך.</li>
              </ul>
            </>
          )}
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
