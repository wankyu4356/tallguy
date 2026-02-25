import { useState, useMemo, useRef } from "react";

const MAIN_TABS = ["가입", "이용", "해지"];

/* ═══════════════════════════════════════════════════
   DATA HELPERS — compute deltas & format values
   ═══════════════════════════════════════════════════ */

function computeDelta(today, compare) {
  if (compare === 0) return { change: 0, rate: 0, dir: "up" };
  const change = today - compare;
  const rate = (change / Math.abs(compare)) * 100;
  return { change, rate, dir: change >= 0 ? "up" : "down" };
}

function fmtValue(value, format) {
  switch (format) {
    case "money_cho": return value.toFixed(2);
    case "money": return `₩${Math.round(value).toLocaleString()}`;
    default: return Math.round(value).toLocaleString();
  }
}

function fmtAbsChange(absChange, format) {
  switch (format) {
    case "money_cho":
      if (absChange >= 1) return `₩${absChange.toFixed(2)}조`;
      return `₩${Math.round(absChange * 10000).toLocaleString()}억`;
    case "money":
      return `₩${Math.round(absChange).toLocaleString()}`;
    default:
      if (absChange >= 1000000) return `${(absChange / 1000000).toFixed(2)}M`;
      return Math.round(absChange).toLocaleString();
  }
}

function fmtSignedChange(change, format) {
  const sign = change >= 0 ? "+" : "-";
  const abs = Math.abs(change);
  switch (format) {
    case "money_cho":
      if (abs >= 1) return `${sign}₩${abs.toFixed(2)}조`;
      return `${sign}₩${Math.round(abs * 10000).toLocaleString()}억`;
    case "money":
      return `${sign}₩${Math.round(abs).toLocaleString()}`;
    default:
      if (abs >= 1000000) return `${sign}${(abs / 1000000).toFixed(2)}M`;
      return `${sign}${Math.round(abs).toLocaleString()}`;
  }
}

function fmtRate(rate) {
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${rate.toFixed(1)}%`;
}

function fmtCompareValue(value, format, unit) {
  switch (format) {
    case "money_cho": return `₩${value}조`;
    case "money": return `₩${Math.round(value).toLocaleString()}`;
    default: return `${Math.round(value).toLocaleString()}${unit}`;
  }
}

function buildComparison(metric, periodKey) {
  const compare = metric[periodKey];
  const delta = computeDelta(metric.today, compare);
  return {
    value: fmtCompareValue(compare, metric.displayFormat, metric.unit),
    change: fmtSignedChange(delta.change, metric.displayFormat),
    rate: fmtRate(delta.rate),
    dir: delta.dir,
  };
}

function buildCardProps(metric) {
  if (!metric) return null;
  const daily = computeDelta(metric.today, metric.yesterday);
  const f = metric.displayFormat;
  return {
    label: metric.label,
    value: fmtValue(metric.today, f),
    unit: f === "money" ? "" : (f === "money_cho" ? "" : metric.unit),
    dailyChange: fmtAbsChange(Math.abs(daily.change), f),
    dailyRate: fmtRate(daily.rate),
    dailyDir: daily.dir,
    subLabel: metric.subLabel,
    subValue: metric.subValue,
    comparisons: [
      { period: "전주 동일", ...buildComparison(metric, "lastWeek") },
      { period: "전월 동일", ...buildComparison(metric, "lastMonth") },
      { period: "전년 동일", ...buildComparison(metric, "lastYear") },
    ],
  };
}

/* ═══ DELTA BADGE ═══ */
function Badge({ val, rate, dir }) {
  const up = dir === "up";
  const c = up ? "#16a34a" : "#dc2626";
  const bg = up ? "rgba(22,163,106,0.08)" : "rgba(220,38,38,0.08)";
  const bd = up ? "rgba(22,163,106,0.2)" : "rgba(220,38,38,0.2)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 12, fontWeight: 600, color: c,
      background: bg, border: `1px solid ${bd}`,
      borderRadius: 6, padding: "3px 10px", whiteSpace: "nowrap",
    }}>
      {up ? "△" : "▽"} {val} ({rate})
    </span>
  );
}

/* ═══ SECTION HEADER ═══ */
function SH({ title, tagColor = "#FFDC3C" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, marginTop: 6 }}>
      <div style={{ width: 3.5, height: 20, background: tagColor, borderRadius: 2 }} />
      <span style={{ fontSize: 17, fontWeight: 700, color: "#fff", letterSpacing: -0.3 }}>{title}</span>
    </div>
  );
}

/* ═══ DUAL CARD ═══ */
function DualCard({ label, value, unit, dailyChange, dailyRate, dailyDir, subLabel, subValue, comparisons }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1.1fr 1fr",
      borderRadius: 16, overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(20,20,28,0.95)",
    }}>
      <div style={{ padding: "28px 30px 24px", borderRight: "1px solid rgba(255,255,255,0.05)" }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", fontWeight: 500, marginBottom: 20 }}>{label}</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 42, fontWeight: 800, color: "#fff", letterSpacing: -2, lineHeight: 1 }}>{value}</span>
          <span style={{ fontSize: 18, color: "rgba(255,255,255,0.4)", fontWeight: 500 }}>{unit}</span>
        </div>
        {dailyChange && (
          <div style={{ marginBottom: 20 }}>
            <Badge val={dailyChange} rate={dailyRate} dir={dailyDir} />
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginLeft: 8 }}>전일대비</span>
          </div>
        )}
        <div style={{ height: 1, background: "rgba(255,255,255,0.06)", marginBottom: 16 }} />
        {subLabel && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: "rgba(255,255,255,0.35)" }}>{subLabel}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: "rgba(255,255,255,0.75)" }}>{subValue}</span>
          </div>
        )}
      </div>
      <div style={{ padding: "28px 30px 24px", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: 500, marginBottom: 24 }}>비교</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: 1, justifyContent: "center" }}>
          {comparisons.map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 14, color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{c.period}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>{c.value}</span>
              </div>
              <Badge val={c.change} rate={c.rate} dir={c.dir} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══ MONEY DUAL ═══ */
function MoneyDual({ label, value, sub, comparisons, accent = "#60a5fa" }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1.1fr 1fr",
      borderRadius: 16, overflow: "hidden",
      border: "1px solid rgba(255,255,255,0.06)",
      background: "rgba(20,20,28,0.95)",
    }}>
      <div style={{
        padding: "28px 30px 24px", borderRight: "1px solid rgba(255,255,255,0.05)",
        position: "relative", background: `linear-gradient(160deg, ${accent}06 0%, transparent 40%)`,
      }}>
        <div style={{ position: "absolute", top: 0, left: 0, width: 3, height: "100%", background: `linear-gradient(180deg, ${accent}, ${accent}66)`, borderRadius: "16px 0 0 16px" }} />
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", marginBottom: 18 }}>{label}</div>
        <div style={{ fontSize: 42, fontWeight: 800, color: "#fff", letterSpacing: -2, lineHeight: 1 }}>{value}</div>
        {sub && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.22)", marginTop: 14 }}>{sub}</div>}
      </div>
      <div style={{ padding: "28px 30px 24px", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", fontWeight: 500, marginBottom: 24 }}>비교</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18, flex: 1, justifyContent: "center" }}>
          {comparisons.map((c, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 14, color: "rgba(255,255,255,0.65)", fontWeight: 600 }}>{c.period}</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: "rgba(255,255,255,0.85)" }}>{c.value}</span>
              </div>
              <Badge val={c.change} rate={c.rate} dir={c.dir} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════
   MOVING AVERAGE Z-SCORE BAND CALCULATION
   ═══════════════════════════════════════════════════ */
function calcMovingBands(data, window = 7) {
  const n = data.length;
  const result = [];
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - Math.floor(window / 2));
    const end = Math.min(n, i + Math.ceil(window / 2));
    const slice = data.slice(start, end);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length);
    result.push({ mean, std, s1u: mean + std, s1d: mean - std, s2u: mean + 2 * std, s2d: mean - 2 * std });
  }
  return result;
}

/* ═══════════════════════════════════════════════════
   MULTI-LINE CHART WITH MOVING AVERAGE Z-SCORE BANDS
   — Now reads data from trendData prop (Excel)
   ═══════════════════════════════════════════════════ */
const AGE_GROUPS = ["10대", "20대", "30대", "40대", "50대+"];
const AGE_COLORS = ["#f87171", "#fb923c", "#FFDC3C", "#4ade80", "#60a5fa"];
const GENDER_GROUPS = ["남성", "여성"];
const GENDER_COLORS = ["#60a5fa", "#f472b6"];

function MultiLineChart({ lineColor = "#FFDC3C", chartHeight = 280, showZBand = true, trendData }) {
  const [filter, setFilter] = useState("전체");
  const [hoverSeries, setHoverSeries] = useState(null);
  const [hoverIdx, setHoverIdx] = useState(null);

  const labels = trendData?.dates || [];
  const n = labels.length;

  const series = useMemo(() => {
    if (!trendData || !trendData.series) return [{ name: "전체", color: lineColor, data: [] }];
    if (filter === "전체") return [{ name: "전체", color: lineColor, data: trendData.series["전체"] || [] }];
    if (filter === "연령별") return AGE_GROUPS.map((name, gi) => ({
      name, color: AGE_COLORS[gi], data: trendData.series[name] || [],
    }));
    return GENDER_GROUPS.map((name, gi) => ({
      name, color: GENDER_COLORS[gi], data: trendData.series[name] || [],
    }));
  }, [filter, lineColor, trendData]);

  const bands = useMemo(() => {
    const d = series[0]?.data;
    if (!d || d.length === 0) return [];
    return calcMovingBands(d, 7);
  }, [series]);

  if (n === 0) return <div style={{ color: "rgba(255,255,255,0.3)", padding: 40, textAlign: "center" }}>추이 데이터 없음</div>;

  const W = 960, H = 330;
  const pad = { t: 28, b: 48, l: 62, r: 42 };
  const iW = W - pad.l - pad.r;
  const iH = H - pad.t - pad.b;

  const allVals = series.flatMap(s => s.data);
  const bandMaxes = bands.map(b => b.s2u);
  const bandMins = bands.map(b => b.s2d);
  const yMax = Math.max(...allVals, ...bandMaxes) * 1.04;
  const yMin = Math.min(...allVals, ...bandMins) * 0.96;
  const range = yMax - yMin || 1;

  const toY = (v) => pad.t + iH - ((v - yMin) / range) * iH;
  const toX = (i) => pad.l + (i / (n - 1)) * iW;

  const bandPolygon = (upper, lower) => {
    const top = bands.map((b, i) => `${toX(i)},${toY(b[upper])}`).join(" ");
    const bot = [...bands].reverse().map((b, i) => `${toX(n - 1 - i)},${toY(b[lower])}`).join(" ");
    return `${top} ${bot}`;
  };

  const maLine = bands.map((b, i) => `${toX(i)},${toY(b.mean)}`).join(" ");

  const gridN = 5;
  const gridVals = Array.from({ length: gridN + 1 }, (_, i) => yMin + (range / gridN) * i);

  return (
    <div style={{
      background: "rgba(20,20,28,0.95)", border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 16, padding: "22px 26px 14px",
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          {series.map((s, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 6, fontSize: 12,
              color: hoverSeries !== null && hoverSeries !== i ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.45)",
              transition: "color 0.2s", cursor: series.length > 1 ? "pointer" : "default",
            }} onMouseEnter={() => series.length > 1 && setHoverSeries(i)} onMouseLeave={() => setHoverSeries(null)}>
              <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color }} /> {s.name}
            </div>
          ))}
          {showZBand && (<>
            <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.08)", margin: "0 2px" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
              <span style={{ width: 14, height: 2, borderRadius: 1, background: "rgba(255,255,255,0.2)", borderTop: "1px dashed rgba(255,255,255,0.3)" }} /> 7일 MA
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
              <span style={{ width: 14, height: 6, borderRadius: 2, background: "rgba(255,255,255,0.06)" }} /> ±1σ
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "rgba(255,255,255,0.25)" }}>
              <span style={{ width: 14, height: 6, borderRadius: 2, background: "rgba(255,255,255,0.025)" }} /> ±2σ
            </div>
          </>)}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["전체", "연령별", "성별"].map(f => (
            <button key={f} onClick={() => { setFilter(f); setHoverSeries(null); setHoverIdx(null); }} style={{
              padding: "6px 18px", fontSize: 12.5, fontWeight: filter === f ? 700 : 400,
              border: `1px solid ${filter === f ? "rgba(255,220,60,0.4)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 8,
              background: filter === f ? "rgba(255,220,60,0.1)" : "transparent",
              color: filter === f ? "#FFDC3C" : "rgba(255,255,255,0.35)",
              cursor: "pointer", transition: "all 0.15s",
            }}>{f}</button>
          ))}
        </div>
      </div>

      {/* SVG Chart */}
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: chartHeight, display: "block" }}
        onMouseLeave={() => { setHoverSeries(null); setHoverIdx(null); }}>
        <defs>
          <linearGradient id="aFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={series[0].color} stopOpacity="0.1" />
            <stop offset="100%" stopColor={series[0].color} stopOpacity="0" />
          </linearGradient>
          <filter id="glow"><feGaussianBlur stdDeviation="1.5" result="g" /><feMerge><feMergeNode in="g" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>

        {/* Z-Score Moving Average Bands */}
        {showZBand && bands.length > 0 && (<>
          <polygon points={bandPolygon("s2u", "s2d")} fill="rgba(255,255,255,0.018)" stroke="none" />
          <polygon points={bandPolygon("s1u", "s1d")} fill="rgba(255,255,255,0.04)" stroke="none" />
          <polyline points={bands.map((b, i) => `${toX(i)},${toY(b.s2u)}`).join(" ")}
            fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.7" strokeDasharray="3,4" />
          <polyline points={bands.map((b, i) => `${toX(i)},${toY(b.s2d)}`).join(" ")}
            fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="0.7" strokeDasharray="3,4" />
          <polyline points={bands.map((b, i) => `${toX(i)},${toY(b.s1u)}`).join(" ")}
            fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.7" strokeDasharray="2,3" />
          <polyline points={bands.map((b, i) => `${toX(i)},${toY(b.s1d)}`).join(" ")}
            fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.7" strokeDasharray="2,3" />
          <polyline points={maLine}
            fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.2" strokeDasharray="6,4" />
          <text x={W - pad.r + 6} y={toY(bands[n - 1].mean) + 3} fill="rgba(255,255,255,0.22)" fontSize="9" fontWeight="500">MA</text>
          <text x={W - pad.r + 6} y={toY(bands[n - 1].s1u) + 3} fill="rgba(255,255,255,0.14)" fontSize="8">+1σ</text>
          <text x={W - pad.r + 6} y={toY(bands[n - 1].s1d) + 3} fill="rgba(255,255,255,0.14)" fontSize="8">-1σ</text>
          <text x={W - pad.r + 6} y={toY(bands[n - 1].s2u) + 3} fill="rgba(255,255,255,0.09)" fontSize="8">+2σ</text>
          <text x={W - pad.r + 6} y={toY(bands[n - 1].s2d) + 3} fill="rgba(255,255,255,0.09)" fontSize="8">-2σ</text>
        </>)}

        {/* Grid */}
        {gridVals.map((v, i) => {
          const y = toY(v);
          return (<g key={i}>
            <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke="rgba(255,255,255,0.03)" />
            <text x={pad.l - 10} y={y + 4} fill="rgba(255,255,255,0.18)" fontSize="10" textAnchor="end">
              {Math.round(v).toLocaleString()}
            </text>
          </g>);
        })}

        {/* X labels */}
        {labels.map((l, i) => (
          i % Math.max(1, Math.floor(n / 10)) === 0 && (
            <text key={i} x={toX(i)} y={H - 10} fill="rgba(255,255,255,0.18)" fontSize="10" textAnchor="middle">{l}</text>
          )
        ))}

        {/* Axis labels */}
        <text x={pad.l - 10} y={16} fill="rgba(255,255,255,0.12)" fontSize="9" textAnchor="end">고객수</text>
        <text x={(pad.l + W - pad.r) / 2} y={H - 0} fill="rgba(255,255,255,0.12)" fontSize="9" textAnchor="middle">날짜</text>

        {/* Data lines */}
        {series.map((s, si) => {
          if (!s.data || s.data.length === 0) return null;
          const pts = s.data.map((v, i) => ({ x: toX(i), y: toY(v) }));
          const lineStr = pts.map(p => `${p.x},${p.y}`).join(" ");
          const isSingle = series.length === 1;
          const dim = hoverSeries !== null && hoverSeries !== si;
          return (
            <g key={si}>
              {isSingle && <polygon points={`${pad.l},${pad.t + iH} ${lineStr} ${pad.l + iW},${pad.t + iH}`} fill="url(#aFill)" />}
              <polyline points={lineStr} fill="none" stroke={s.color}
                strokeWidth={isSingle ? 2.5 : 2}
                strokeLinecap="round" strokeLinejoin="round"
                filter={isSingle ? "url(#glow)" : undefined}
                opacity={dim ? 0.15 : 1} style={{ transition: "opacity 0.2s" }}
              />
              {pts.map((p, i) => {
                const outsideBand = showZBand && isSingle && bands[i] && (s.data[i] > bands[i].s2u || s.data[i] < bands[i].s2d);
                return (
                  <g key={i}>
                    <circle cx={p.x} cy={p.y}
                      r={hoverIdx === i && (hoverSeries === si || isSingle) ? 6 : isSingle ? 3.5 : 2.5}
                      fill={hoverIdx === i ? s.color : "#0c0c14"} stroke={s.color}
                      strokeWidth={hoverIdx === i ? 2.5 : 1.5}
                      opacity={dim ? 0.1 : 0.8} style={{ transition: "all 0.12s" }}
                    />
                    {outsideBand && (
                      <circle cx={p.x} cy={p.y} r={7} fill="none" stroke="#f87171" strokeWidth={1.5} opacity={0.5}>
                        <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" />
                        <animate attributeName="opacity" values="0.5;0.15;0.5" dur="2s" repeatCount="indefinite" />
                      </circle>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Hover columns */}
        {Array.from({ length: n }, (_, i) => (
          <rect key={`hc${i}`} x={toX(i) - iW / n / 2} y={pad.t} width={iW / n} height={iH}
            fill="transparent"
            onMouseEnter={() => setHoverIdx(i)}
            style={{ cursor: "crosshair" }}
          />
        ))}

        {/* Tooltip */}
        {hoverIdx !== null && (<>
          <line x1={toX(hoverIdx)} y1={pad.t} x2={toX(hoverIdx)} y2={pad.t + iH}
            stroke="rgba(255,255,255,0.12)" strokeWidth="1" strokeDasharray="3,3" />
          {series.map((s, si) => {
            const dim = hoverSeries !== null && hoverSeries !== si;
            if (dim || !s.data || !s.data[hoverIdx]) return null;
            const v = s.data[hoverIdx];
            const y = toY(v);
            const boxW = series.length > 1 ? 120 : 108;
            return (
              <g key={si}>
                <rect x={toX(hoverIdx) - boxW / 2} y={y - 36 - si * 28} width={boxW} height={24}
                  rx={7} fill="rgba(0,0,0,0.9)" stroke={`${s.color}55`} strokeWidth="1" />
                <text x={toX(hoverIdx)} y={y - 20 - si * 28} fill="#fff"
                  fontSize="11.5" fontWeight="700" textAnchor="middle">
                  {series.length > 1 ? `${s.name} ` : ""}{labels[hoverIdx]} · {v.toLocaleString()}
                </text>
              </g>
            );
          })}
          {showZBand && series.length === 1 && bands[hoverIdx] && (
            <g>
              <rect x={toX(hoverIdx) - 46} y={toY(bands[hoverIdx].mean) + 6} width={92} height={20}
                rx={5} fill="rgba(255,255,255,0.06)" />
              <text x={toX(hoverIdx)} y={toY(bands[hoverIdx].mean) + 19} fill="rgba(255,255,255,0.35)"
                fontSize="10" fontWeight="500" textAnchor="middle">
                MA: {Math.round(bands[hoverIdx].mean).toLocaleString()}
              </text>
            </g>
          )}
        </>)}
      </svg>
    </div>
  );
}

/* ═══════════════ MAIN DASHBOARD ═══════════════ */
export default function Dashboard({ data, fileName, onReload, onFileSelect }) {
  const [tab, setTab] = useState(0);
  const tabColors = ["#FFDC3C", "#60a5fa", "#f87171"];
  const fileInputRef = useRef(null);

  if (!data) {
    return (
      <div style={{
        minHeight: "100vh", background: "#0c0c14", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'Pretendard', -apple-system, sans-serif",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
          <div style={{ fontSize: 16, color: "rgba(255,255,255,0.5)" }}>데이터 로딩 중...</div>
        </div>
      </div>
    );
  }

  const getMetric = (category, label) => data[category]?.find(m => m.label === label);
  const card = (category, label) => {
    const m = getMetric(category, label);
    return m ? buildCardProps(m) : null;
  };

  const baseDate = data.settings?.['기준일'] || '2026. 02. 25.';

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file && onFileSelect) onFileSelect(file);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#0c0c14", color: "#fff", fontFamily: "'Pretendard', -apple-system, sans-serif" }}>
      <header style={{
        padding: "16px 40px", background: "rgba(12,12,20,0.97)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        backdropFilter: "blur(20px)", position: "sticky", top: 0, zIndex: 100,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: "linear-gradient(135deg, #FFDC3C, #FFB300)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 900, fontSize: 19, color: "#111",
            boxShadow: "0 2px 16px rgba(255,220,60,0.15)",
          }}>K</div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: -0.5 }}>입출금통장 데일리 대시보드</div>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", marginTop: 2 }}>가입 · 이용 · 해지 일별 지표 트래킹</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* File upload controls */}
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ display: "none" }} />
          <button onClick={() => fileInputRef.current?.click()} style={{
            padding: "7px 14px", fontSize: 12, fontWeight: 600,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, color: "rgba(255,255,255,0.5)", cursor: "pointer",
            transition: "all 0.15s",
          }}>
            📂 엑셀 업로드
          </button>
          <button onClick={onReload} style={{
            padding: "7px 14px", fontSize: 12, fontWeight: 600,
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 8, color: "rgba(255,255,255,0.5)", cursor: "pointer",
            transition: "all 0.15s",
          }}>
            🔄 새로고침
          </button>
          <div style={{
            display: "flex", alignItems: "center", gap: 10,
            background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "8px 18px",
            border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <span style={{ fontSize: 12, color: "rgba(255,255,255,0.35)" }}>기준일</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#FFDC3C" }}>{baseDate}</span>
          </div>
        </div>
      </header>

      <nav style={{ padding: "0 40px", background: "rgba(12,12,20,0.5)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <div style={{ display: "flex" }}>
          {MAIN_TABS.map((t, i) => (
            <button key={t} onClick={() => setTab(i)} style={{
              padding: "14px 30px", fontSize: 14, fontWeight: tab === i ? 700 : 400,
              color: tab === i ? "#fff" : "rgba(255,255,255,0.3)", background: "transparent",
              border: "none", cursor: "pointer",
              borderBottom: tab === i ? `2.5px solid ${tabColors[i]}` : "2.5px solid transparent",
              transition: "all 0.2s",
            }}>{t} 지표</button>
          ))}
        </div>
      </nav>

      {/* File name indicator */}
      {fileName && (
        <div style={{ padding: "8px 40px", background: "rgba(255,220,60,0.03)", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>📄 데이터 소스: {fileName}</span>
        </div>
      )}

      <main style={{ padding: "32px 40px 48px", maxWidth: 1100, margin: "0 auto" }}>

        {/* ━━━ 가입 ━━━ */}
        {tab === 0 && (<div>
          <SH title="가입자 현황" />
          {card('가입', '신규 가입자 수') && <DualCard {...card('가입', '신규 가입자 수')} />}
          <div style={{ height: 24 }} />
          <SH title="계좌 현황" />
          {card('가입', '신규 가입 좌수') && <DualCard {...card('가입', '신규 가입 좌수')} />}
          <div style={{ height: 28 }} />
          <SH title="가입자 추이" />
          <MultiLineChart lineColor="#FFDC3C" chartHeight={280} showZBand={true} trendData={data.가입_추이} />
        </div>)}

        {/* ━━━ 이용 ━━━ */}
        {tab === 1 && (<div>
          <SH title="이용자 현황" tagColor="#60a5fa" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {card('이용', '전체 고객 수') && <DualCard {...card('이용', '전체 고객 수')} />}
            {card('이용', '활성 고객 수') && <DualCard {...card('이용', '활성 고객 수')} />}
          </div>
          {card('이용', '0원 고객 수') && <DualCard {...card('이용', '0원 고객 수')} />}

          <div style={{ height: 28 }} />
          <SH title="계좌 현황" tagColor="#60a5fa" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            {card('이용', '전체 계좌 수') && <DualCard {...card('이용', '전체 계좌 수')} />}
            {card('이용', '활성 계좌 수') && <DualCard {...card('이용', '활성 계좌 수')} />}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {card('이용', '0원 계좌 수') && <DualCard {...card('이용', '0원 계좌 수')} />}
            {card('이용', '한도계좌 수') && <DualCard {...card('이용', '한도계좌 수')} />}
          </div>

          <div style={{ height: 28 }} />
          <SH title="수신고 현황" tagColor="#60a5fa" />
          {(() => {
            const bal = getMetric('이용', '수신고 잔액');
            if (!bal) return null;
            return (
              <MoneyDual
                label={bal.subLabel || "입출금통장 수신고 전체 잔액"}
                value={<>₩{bal.today}<span style={{ fontSize: 22, color: "rgba(255,255,255,0.4)" }}>조</span></>}
                sub={bal.subValue}
                accent="#60a5fa"
                comparisons={[
                  { period: "전주 동일", ...buildComparison(bal, "lastWeek") },
                  { period: "전월 동일", ...buildComparison(bal, "lastMonth") },
                  { period: "전년 동일", ...buildComparison(bal, "lastYear") },
                ]}
              />
            );
          })()}
          <div style={{ height: 14 }} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {card('이용', '고객 당 평잔') && <DualCard {...card('이용', '고객 당 평잔')} />}
            {card('이용', '계좌 당 평잔') && <DualCard {...card('이용', '계좌 당 평잔')} />}
          </div>
        </div>)}

        {/* ━━━ 해지 ━━━ */}
        {tab === 2 && (<div>
          <SH title="해지 고객 현황" tagColor="#f87171" />
          {card('해지', '해지 고객 수') && <DualCard {...card('해지', '해지 고객 수')} />}
          <div style={{ height: 24 }} />
          <SH title="해지 계좌 현황" tagColor="#f87171" />
          {card('해지', '해지 계좌 수') && <DualCard {...card('해지', '해지 계좌 수')} />}
          <div style={{ height: 28 }} />
          <SH title="해지 추이 분석" tagColor="#f87171" />
          <MultiLineChart lineColor="#f87171" chartHeight={260} showZBand={true} trendData={data.해지_추이} />
        </div>)}
      </main>

      <footer style={{ padding: "20px 40px", borderTop: "1px solid rgba(255,255,255,0.03)", fontSize: 11, color: "rgba(255,255,255,0.12)", textAlign: "center" }}>
        입출금통장 데일리 대시보드 · 기준일 {baseDate} · Excel-Driven Dashboard
      </footer>
    </div>
  );
}
