import React, { useState, useMemo, useEffect, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area, AreaChart } from "recharts";

// ===== Fallback snapshot (ADBE) shown before the first live fetch / if offline =====
const FALLBACK = {
  symbol: "ADBE", name: "Adobe Inc.", asOf: "2026-06-02",
  range: "2025-05-22 → 2026-06-02", lastClose: 262.11,
  returns: { daily: -4.3, m1: 4.5, m3: -3.3, m6: -18.1, ytd: -21.4, y1: -36.9 },
  vol6: 39.7, vol12: 33.6, mu6: -32.2, mu12: -40.2,
  series: [], // populated live; chart hidden until data arrives
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

const HORIZONS = [
  { label: "שבועיים", years: 14 / 365 },
  { label: "חודש", years: 1 / 12 },
  { label: "חודשיים", years: 2 / 12 },
  { label: "3 חודשים", years: 3 / 12 },
  { label: "חצי שנה", years: 6 / 12 },
  { label: "9 חודשים", years: 9 / 12 },
  { label: "שנה", years: 1 },
];

const C = {
  bg: "#0e1116", panel: "#161b22", panel2: "#1c232d", border: "#2a3441",
  ink: "#e8edf2", sub: "#8b97a5", gold: "#e3b341", rn: "#4ea6ff", ph: "#e3b341", fin: "#6f7d8c",
  iv: "#a78bfa",
  green: "#3fb950", red: "#f85149",
};

export default function App() {
  // ----- data state -----
  const [snap, setSnap] = useState(FALLBACK);
  const [symbolInput, setSymbolInput] = useState("ADBE");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  // ----- model inputs -----
  const [S0, setS0] = useState(FALLBACK.lastClose);
  const [ST, setST] = useState(350);
  const [sigmaPct, setSigmaPct] = useState(FALLBACK.vol12);
  const [muHistPct, setMuHistPct] = useState(FALLBACK.mu12);
  const [rPct, setRPct] = useState(4.3);
  const [ivStr, setIvStr] = useState(""); // optional implied vol, manual from broker
  const [touched, setTouched] = useState(false); // did the user override inputs?

  const fetchSymbol = useCallback(async (sym) => {
    const s = (sym || "").trim().toUpperCase();
    if (!s) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/stock?symbol=${encodeURIComponent(s)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
      setSnap(data);
      // re-seed model inputs from fresh data (12m σ/μ; current price)
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

  // load ADBE live on first mount
  useEffect(() => { fetchSymbol("ADBE"); }, [fetchSymbol]);

  const sigma = sigmaPct / 100;
  const muHist = muHistPct / 100;
  const r = rPct / 100;
  const ivNum = parseFloat(ivStr);
  const hasIV = Number.isFinite(ivNum) && ivNum > 0;
  const ivSigma = hasIV ? ivNum / 100 : null;
  const b = Math.log(ST / S0);
  const isUp = ST > S0;

  const series = useMemo(() => (snap.series || []).map(p => ({ date: p.d, close: p.c })), [snap]);

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
        "Touch · Risk-Neutral": +(touchProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, t) * 100).toFixed(1),
        "Touch · Physical": +(touchProb(Math.abs(b), isUp ? nuPh : -nuPh, sigma, t) * 100).toFixed(1),
        "Finish · Risk-Neutral": +(finishProb(Math.abs(b), isUp ? nuRN : -nuRN, sigma, t) * 100).toFixed(1),
      };
      if (hasIV) row["Touch · IV (שוק)"] = +(touchProb(Math.abs(b), isUp ? nuIV : -nuIV, ivSigma, t) * 100).toFixed(1);
      pts.push(row);
    }
    return pts;
  }, [b, sigma, muHist, r, isUp, hasIV, ivSigma]);

  const inputStyle = { background: C.panel2, border: `1px solid ${C.border}`, color: C.ink, borderRadius: 8, padding: "9px 12px", width: "100%", fontSize: 15, fontFamily: "inherit", boxSizing: "border-box" };
  const labelStyle = { color: C.sub, fontSize: 12, marginBottom: 6, display: "block", letterSpacing: 0.3 };
  const pct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const pctColor = (v) => v == null ? C.sub : v >= 0 ? C.green : C.red;

  const onModel = (setter) => (e) => { setter(+e.target.value); setTouched(true); };

  const ReturnCell = ({ label, v }) => (
    <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 8px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: C.sub, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: pctColor(v) }}>{pct(v)}</div>
    </div>
  );

  return (
    <div dir="rtl" style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'IBM Plex Sans Hebrew', 'Heebo', system-ui, sans-serif", padding: "28px 18px" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700&family=IBM+Plex+Sans+Hebrew:wght@400;500;600&display=swap');
        input[type=number]::-webkit-outer-spin-button, input[type=number]::-webkit-inner-spin-button { opacity: 0.5; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
      <div style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ marginBottom: 6, fontSize: 13, color: C.gold, letterSpacing: 1.5, fontWeight: 600 }}>FIRST PASSAGE TIME · GBM · LIVE (FMP)</div>
        <h1 style={{ margin: "0 0 6px", fontSize: 28, fontWeight: 700 }}>הסתברות הגעה למחיר יעד</h1>
        <p style={{ color: C.sub, margin: "0 0 20px", fontSize: 14, lineHeight: 1.6, maxWidth: 680 }}>
          חישוב ההסתברות שמניה תיגע במחיר יעד (touch) או תסגור מעליו (finish) לפי אופקי זמן, על בסיס תנועה בראונית גאומטרית, עם שתי הנחות דריפט במקביל. הנתונים נמשכים חיים מ-FMP.
        </p>

        {/* === Symbol selector === */}
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 18 }}>
          <div style={{ flex: "1 1 220px" }}>
            <label style={labelStyle}>סימבול מניה</label>
            <input
              style={{ ...inputStyle, textTransform: "uppercase", letterSpacing: 1 }}
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchSymbol(symbolInput)}
              placeholder="ADBE, AAPL, NVDA…"
            />
          </div>
          <button
            onClick={() => fetchSymbol(symbolInput)}
            disabled={loading}
            style={{ background: C.gold, color: "#0e1116", border: "none", borderRadius: 8, padding: "10px 22px", fontSize: 15, fontWeight: 700, cursor: loading ? "default" : "pointer", fontFamily: "inherit", opacity: loading ? 0.6 : 1, display: "flex", alignItems: "center", gap: 8 }}
          >
            {loading && <span style={{ width: 14, height: 14, border: "2px solid #0e1116", borderTopColor: "transparent", borderRadius: "50%", display: "inline-block", animation: "spin 0.7s linear infinite" }} />}
            {loading ? "טוען…" : "טען נתונים"}
          </button>
        </div>

        {err && (
          <div style={{ background: "#2a1416", border: `1px solid ${C.red}`, color: "#ffb4ad", borderRadius: 10, padding: "12px 16px", marginBottom: 18, fontSize: 14 }}>
            ⚠ {err}
          </div>
        )}

        {/* === Stock overview === */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, marginBottom: 20, opacity: loading ? 0.55 : 1, transition: "opacity .2s" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {snap.symbol} <span style={{ fontSize: 18, color: C.sub, fontWeight: 500 }}>${snap.lastClose}</span>
              {snap.name && snap.name !== snap.symbol && <span style={{ fontSize: 13, color: C.sub, fontWeight: 400, marginInlineStart: 10 }}>{snap.name}</span>}
            </div>
            <div style={{ fontSize: 12, color: C.sub }}>{snap.range} · {series.length} ימי מסחר</div>
          </div>
          {series.length > 0 && (
            <ResponsiveContainer width="100%" height={210}>
              <AreaChart data={series} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="px" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.gold} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={C.gold} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                <XAxis dataKey="date" stroke={C.sub} tick={{ fontSize: 10 }} minTickGap={50} tickFormatter={(d) => d.slice(2, 7)} />
                <YAxis stroke={C.sub} tick={{ fontSize: 10 }} domain={["auto", "auto"]} width={48} />
                <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink, fontSize: 12 }} />
                <Area type="monotone" dataKey="close" stroke={C.gold} strokeWidth={2} fill="url(#px)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 7, marginTop: 14 }}>
            <ReturnCell label="יומי" v={snap.returns.daily} />
            <ReturnCell label="חודש" v={snap.returns.m1} />
            <ReturnCell label="3 חודשים" v={snap.returns.m3} />
            <ReturnCell label="חצי שנה" v={snap.returns.m6} />
            <ReturnCell label="YTD" v={snap.returns.ytd} />
            <ReturnCell label="שנה" v={snap.returns.y1} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>חצי שנה (≈126 ימים)</div>
              <div style={{ display: "flex", gap: 18 }}>
                <span style={{ fontSize: 13 }}>σ <b style={{ color: C.rn }}>{snap.vol6?.toFixed(1)}%</b></span>
                <span style={{ fontSize: 13 }}>μ <b style={{ color: pctColor(snap.mu6) }}>{pct(snap.mu6)}</b></span>
              </div>
            </div>
            <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: C.sub, marginBottom: 6 }}>שנה (≈252 ימים)</div>
              <div style={{ display: "flex", gap: 18 }}>
                <span style={{ fontSize: 13 }}>σ <b style={{ color: C.rn }}>{snap.vol12?.toFixed(1)}%</b></span>
                <span style={{ fontSize: 13 }}>μ <b style={{ color: pctColor(snap.mu12) }}>{pct(snap.mu12)}</b></span>
              </div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>
            נתונים חיים מ-FMP נכון ל-{snap.asOf}. המחשבון מאותחל ב-σ ו-μ של שנה — אפשר להחליף ל-σ של חצי שנה ידנית למטה לבדיקת רגישות.
            {touched && <span style={{ color: C.gold }}> · ערכי המודל נערכו ידנית (לא תואמים בהכרח את הנתונים החיים).</span>}
          </div>
        </div>

        {/* Inputs */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 20 }}>
          <div><label style={labelStyle}>מחיר נוכחי ($)</label><input type="number" style={inputStyle} value={S0} onChange={onModel(setS0)} /></div>
          <div><label style={labelStyle}>מחיר יעד ($)</label><input type="number" style={inputStyle} value={ST} onChange={onModel(setST)} /></div>
          <div><label style={labelStyle}>תנודתיות σ שנתית (%)</label><input type="number" style={inputStyle} value={sigmaPct} onChange={onModel(setSigmaPct)} /></div>
          <div><label style={labelStyle}>μ ארית' שנתי (%)</label><input type="number" style={inputStyle} value={muHistPct} onChange={onModel(setMuHistPct)} /></div>
          <div><label style={labelStyle}>ריבית חסרת סיכון r (%)</label><input type="number" style={inputStyle} value={rPct} onChange={onModel(setRPct)} /></div>
          <div><label style={{ ...labelStyle, color: C.iv }}>IV גלום (%) · אופציונלי</label><input type="number" style={{ ...inputStyle, borderColor: hasIV ? C.iv : C.border }} value={ivStr} placeholder="מהברוקר" onChange={(e) => { setIvStr(e.target.value); setTouched(true); }} /></div>
        </div>

        {/* Move summary */}
        <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", marginBottom: 20, fontSize: 14, color: C.sub }}>
          תנועה נדרשת: <span style={{ color: isUp ? C.green : C.red, fontWeight: 600 }}>{((ST / S0 - 1) * 100).toFixed(1)}%</span>
          {"  ·  "}b = ln(יעד/נוכחי) = <span style={{ color: C.ink, fontWeight: 600 }}>{b.toFixed(4)}</span>
          {"  ·  "}כיוון: {isUp ? "עלייה ↑" : "ירידה ↓"}
        </div>

        {/* Probability table */}
        <div style={{ overflowX: "auto", marginBottom: 26 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 560 }}>
            <thead>
              <tr style={{ color: C.sub, textAlign: "right" }}>
                <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}` }}>אופק זמן</th>
                <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}`, color: C.rn }}>Touch · RN</th>
                <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}`, color: C.ph }}>Touch · Physical</th>
                <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}` }}>Finish · RN</th>
                <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}` }}>Finish · Physical</th>
                {hasIV && <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}`, color: C.iv }}>Touch · IV</th>}
                {hasIV && <th style={{ padding: "10px 12px", borderBottom: `2px solid ${C.border}`, color: C.iv }}>Finish · IV</th>}
              </tr>
            </thead>
            <tbody>
              {table.map((row, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "11px 12px", fontWeight: 500 }}>{row.label}</td>
                  <td style={{ padding: "11px 12px", color: C.rn, fontWeight: 600 }}>{row.touchRN.toFixed(1)}%</td>
                  <td style={{ padding: "11px 12px", color: C.ph, fontWeight: 600 }}>{row.touchPh.toFixed(1)}%</td>
                  <td style={{ padding: "11px 12px", color: C.sub }}>{row.finishRN.toFixed(1)}%</td>
                  <td style={{ padding: "11px 12px", color: C.sub }}>{row.finishPh.toFixed(1)}%</td>
                  {hasIV && <td style={{ padding: "11px 12px", color: C.iv, fontWeight: 600 }}>{row.touchIV.toFixed(1)}%</td>}
                  {hasIV && <td style={{ padding: "11px 12px", color: C.iv }}>{row.finishIV.toFixed(1)}%</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Probability chart */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 12px 12px", marginBottom: 22 }}>
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={curve} margin={{ top: 6, right: 18, left: 0, bottom: 6 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="month" stroke={C.sub} tick={{ fontSize: 12 }} label={{ value: "חודשים", position: "insideBottom", offset: -2, fill: C.sub, fontSize: 12 }} />
              <YAxis stroke={C.sub} tick={{ fontSize: 12 }} domain={[0, 100]} />
              <Tooltip contentStyle={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.ink }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="Touch · Risk-Neutral" stroke={C.rn} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="Touch · Physical" stroke={C.ph} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="Finish · Risk-Neutral" stroke={C.fin} strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
              {hasIV && <Line type="monotone" dataKey="Touch · IV (שוק)" stroke={C.iv} strokeWidth={2.5} dot={false} />}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Notes */}
        <div style={{ background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 18px", fontSize: 13, color: C.sub, lineHeight: 1.7 }}>
          <div style={{ color: C.ink, fontWeight: 600, marginBottom: 8, fontSize: 14 }}>איך לקרוא את זה</div>
          <strong style={{ color: C.rn }}>Touch</strong> — ההסתברות שהמניה תיגע ביעד לפחות פעם אחת בתקופה (רלוונטי לאחזקת אופציות — אפשר למכור כשהיעד נפגע). תמיד גבוה מ-Finish.<br />
          <strong style={{ color: C.fin }}>Finish</strong> — ההסתברות שהמניה תסגור מעל היעד בסוף התקופה (אופציה עד פקיעה).<br />
          <strong style={{ color: C.ph }}>Risk-Neutral (μ=r)</strong> — benchmark הוגן שהשוק מתמחר.{"  "}
          <strong style={{ color: C.ph }}>Physical (μ היסטורי)</strong> — לפי תשואת העבר. ה-edge שלך הוא הפער ביניהן; היזהר מ-μ אופטימי מדי.<br />
          {hasIV && <><strong style={{ color: C.iv }}>IV (שוק)</strong> — אותה הסתברות תחת drift ריסק-נייטרלי אבל עם σ = ה-IV שהזנת. זו ההסתברות שמשתמעת מ<b>מחיר האופציה בפועל</b>. הפער מול עמודת RN (שמשתמשת ב-σ היסטורי) הוא אפקט ה-σ הטהור.<br /></>}
          <span style={{ color: C.gold }}>σ דומיננטי:</span> למינוף אופציות השווה את σ ההיסטורי ל-IV הגלום — אם IV גבוה משמעותית, ההסתברויות מבוססות-HV אופטימיות ביחס לפרמיה.
          {hasIV && (() => {
            const gap = ivNum - sigmaPct;
            const col = gap > 3 ? C.red : gap < -3 ? C.green : C.sub;
            return <div style={{ marginTop: 8, color: col }}>פער IV−HV נוכחי: <b>{gap >= 0 ? "+" : ""}{gap.toFixed(1)} נק' σ</b> · {gap > 3 ? "השוק מתמחר תנודתיות גבוהה מההיסטורית — touch מבוסס-HV אופטימי מול הפרמיה." : gap < -3 ? "ה-IV נמוך מההיסטורי — האופציה עשויה להיות זולה יחסית לתנודתיות שמומשה." : "IV ו-HV קרובים — בסיס סביר להשוואה."}</div>;
          })()}
          <div style={{ marginTop: 8, color: C.sub, fontSize: 12 }}>
            הערת drift: μ כאן הוא ה<b>דריפט הארית'</b> (μ = log-drift + σ²/2), כך ש-ν = μ − σ²/2 משחזר במדויק את הדריפט הלוגריתמי האמפירי — בלי הורדה כפולה של σ²/2.
          </div>
        </div>
      </div>
    </div>
  );
}
