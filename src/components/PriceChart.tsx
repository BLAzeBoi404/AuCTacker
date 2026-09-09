"use client";

import { useMemo, useRef, useState } from "react";
import { formatCompact, formatPrice } from "@/lib/utils";

interface Point {
  time: string | null;
  price: number;
}

interface Props {
  data: Point[];
  /** Точная текущая максимальная цена активного лота (не из истории) — если
   *  она выше пика на графике, показываем отдельной пунктирной линией,
   *  чтобы не создавалось впечатление, будто график "теряет" высокие цены. */
  referenceMax?: number;
}

const VBW = 1000;
const VBH = 320;
const PAD_L = 64;
const PAD_R = 16;
const PAD_T = 26;
const PAD_B = 34;

// Округление шкалы до "красивых" чисел (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 × 10^n),
// чтобы верхняя подпись графика ВСЕГДА была не меньше реального пика данных.
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const fraction = value / base;
  const step = NICE_STEPS.find((s) => s >= fraction - 1e-9) ?? 10;
  return Math.round(step * base * 100) / 100;
}

function niceFloor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const fraction = value / base;
  const steps = [...NICE_STEPS].reverse();
  const step = steps.find((s) => s <= fraction + 1e-9) ?? 1;
  return Math.round(step * base * 100) / 100;
}

export default function PriceChart({ data, referenceMax }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const valid = useMemo(
    () =>
      data
        .filter((d) => d.price > 0 && d.time)
        .map((d) => ({ price: d.price, t: new Date(d.time as string).getTime() }))
        .filter((d) => Number.isFinite(d.t))
        .sort((a, b) => a.t - b.t),
    [data]
  );

  const { yMin, yMax, tMin, tMax, peak, trough } = useMemo(() => {
    if (valid.length === 0) {
      return { yMin: 0, yMax: 1, tMin: 0, tMax: 1, peak: null as typeof valid[number] | null, trough: null as typeof valid[number] | null };
    }
    let peakP = valid[0];
    let troughP = valid[0];
    let tMinV = valid[0].t;
    let tMaxV = valid[0].t;
    for (const p of valid) {
      if (p.price > peakP.price) peakP = p;
      if (p.price < troughP.price) troughP = p;
      if (p.t < tMinV) tMinV = p.t;
      if (p.t > tMaxV) tMaxV = p.t;
    }
    const domainMax = Math.max(peakP.price, referenceMax || 0);
    const domainMin = troughP.price;
    const span = Math.max(domainMax - domainMin, domainMax * 0.06, 1);
    const paddedMax = domainMax + span * 0.14;
    const paddedMin = Math.max(0, domainMin - span * 0.14);
    return {
      yMin: domainMin > 0 ? niceFloor(paddedMin) : 0,
      yMax: niceCeil(paddedMax),
      tMin: tMinV,
      tMax: Math.max(tMaxV, tMinV + 60000),
      peak: peakP,
      trough: troughP,
    };
  }, [valid, referenceMax]);

  const xOf = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin || 1)) * (VBW - PAD_L - PAD_R);
  const yOf = (p: number) => PAD_T + (1 - (p - yMin) / (yMax - yMin || 1)) * (VBH - PAD_T - PAD_B);

  const points = useMemo(() => valid.map((d) => ({ ...d, x: xOf(d.t), y: yOf(d.price) })), [valid, tMin, tMax, yMin, yMax]);

  const linePath = useMemo(() => {
    if (points.length === 0) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  }, [points]);

  const areaPath = useMemo(() => {
    if (points.length === 0) return "";
    const base = VBH - PAD_B;
    return (
      `M${points[0].x.toFixed(1)},${base} ` +
      points.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
      ` L${points[points.length - 1].x.toFixed(1)},${base} Z`
    );
  }, [points]);

  const gridLines = useMemo(() => {
    const n = 5;
    return Array.from({ length: n + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / n);
  }, [yMin, yMax]);

  const timeLabels = useMemo(() => {
    const n = 5;
    return Array.from({ length: n + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / n);
  }, [tMin, tMax]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * VBW;
    let bestIdx = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(p.x - relX);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    setHoverIdx(bestIdx);
  };

  const hoverPoint = hoverIdx !== null ? points[hoverIdx] : null;
  const refY = referenceMax && referenceMax > 0 ? yOf(referenceMax) : null;
  const showRefLine = refY !== null && peak && referenceMax! > peak.price * 1.02;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <svg
        viewBox={`0 0 ${VBW} ${VBH}`}
        preserveAspectRatio="none"
        className="h-[240px] w-full overflow-visible"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d4ff3f" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#d4ff3f" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* сетка + подписи оси Y */}
        {gridLines.map((v, i) => {
          const y = yOf(v);
          return (
            <g key={i}>
              <line x1={PAD_L} x2={VBW - PAD_R} y1={y} y2={y} stroke="rgba(255,255,255,0.07)" strokeWidth={1} strokeDasharray="3,4" />
              <text x={PAD_L - 10} y={y + 4} textAnchor="end" fontSize="12" fill="#71717a">
                {formatCompact(Math.round(v))}
              </text>
            </g>
          );
        })}

        {valid.length === 0 ? (
          <text x={VBW / 2} y={VBH / 2} textAnchor="middle" fontSize="15" fill="#52525b">
            Нет данных за выбранный период
          </text>
        ) : (
          <>
            {/* пунктир текущей максимальной цены активного лота, если она выше пика продаж */}
            {showRefLine && refY !== null && (
              <g>
                <line x1={PAD_L} x2={VBW - PAD_R} y1={refY} y2={refY} stroke="#f87171" strokeWidth={1.4} strokeDasharray="6,4" opacity={0.75} />
                <text x={VBW - PAD_R} y={refY - 6} textAnchor="end" fontSize="11.5" fill="#f87171">
                  сейчас на аукционе: {formatPrice(referenceMax)} ₽
                </text>
              </g>
            )}

            <path d={areaPath} fill="url(#chartFill)" />
            <path d={linePath} fill="none" stroke="#d4ff3f" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />

            {points.length <= 150 &&
              points.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={2.6} fill="#d4ff3f" opacity={0.85} />
              ))}

            {/* пик — всегда подписан явно, чтобы не терялся визуально */}
            {peak && (
              <g>
                <circle cx={xOf(peak.t)} cy={yOf(peak.price)} r={4.5} fill="#0a0a0c" stroke="#d4ff3f" strokeWidth={2.5} />
                <text
                  x={Math.min(Math.max(xOf(peak.t), PAD_L + 40), VBW - PAD_R - 40)}
                  y={Math.max(yOf(peak.price) - 12, 14)}
                  textAnchor="middle"
                  fontSize="12"
                  fontWeight={700}
                  fill="#d4ff3f"
                >
                  ▲ {formatPrice(peak.price)} ₽
                </text>
              </g>
            )}
            {trough && trough.price !== peak?.price && (
              <g>
                <circle cx={xOf(trough.t)} cy={yOf(trough.price)} r={4} fill="#0a0a0c" stroke="#f87171" strokeWidth={2} />
                <text
                  x={Math.min(Math.max(xOf(trough.t), PAD_L + 40), VBW - PAD_R - 40)}
                  y={Math.min(yOf(trough.price) + 20, VBH - PAD_B - 6)}
                  textAnchor="middle"
                  fontSize="11.5"
                  fontWeight={600}
                  fill="#f87171"
                >
                  ▼ {formatPrice(trough.price)} ₽
                </text>
              </g>
            )}

            {/* курсор наведения */}
            {hoverPoint && (
              <g>
                <line x1={hoverPoint.x} x2={hoverPoint.x} y1={PAD_T} y2={VBH - PAD_B} stroke="rgba(255,255,255,0.18)" strokeWidth={1} />
                <circle cx={hoverPoint.x} cy={hoverPoint.y} r={5} fill="#d4ff3f" stroke="#0a0a0c" strokeWidth={2} />
              </g>
            )}
          </>
        )}

        {/* подписи оси времени */}
        {valid.length > 0 &&
          timeLabels.map((t, i) => (
            <text key={i} x={xOf(t)} y={VBH - 10} textAnchor="middle" fontSize="11" fill="#63636b">
              {new Date(t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </text>
          ))}
      </svg>

      {hoverPoint && (
        <div
          className="chart-tip"
          style={{
            left: `${(hoverPoint.x / VBW) * 100}%`,
            top: `${(hoverPoint.y / VBH) * 100}%`,
          }}
        >
          <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-1.5 shadow-xl">
            <div className="mono text-[13px] font-bold text-[#d4ff3f]">{formatPrice(hoverPoint.price)} ₽</div>
            <div className="text-[11px] text-zinc-400">
              {new Date(hoverPoint.t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-5 bg-[#d4ff3f]" /> Цена за шт.
          </span>
          {showRefLine && (
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-[2px] w-5 border-t border-dashed border-red-400" /> Макс. лот сейчас
            </span>
          )}
        </span>
        <span>{valid.length} сделок в выборке · наведите на график для деталей</span>
      </div>
    </div>
  );
}
