"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatCompact, formatPrice } from "@/lib/utils";

interface Point {
  time: string | null;
  price: number;
}

interface P {
  t: number;
  price: number;
  time: string;
}

const PAD_L = 58;
const PAD_R = 14;
const PAD_T = 18;
const PAD_B = 26;
const MAX_DRAWN = 1400;

/** «Красивые» шаги сетки, покрывающие [lo, hi]. В лог-режиме — показатели степени. */
function niceTicks(lo: number, hi: number, count: number, log: boolean): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo, hi];
  if (log) {
    const e0 = Math.log10(Math.max(1, lo));
    const e1 = Math.log10(hi);
    const ticks: number[] = [];
    const step = Math.max(1, Math.round((e1 - e0) / Math.max(1, count)));
    for (let e = Math.floor(e0); e <= e1 + 0.01; e += step) {
      const v = Math.pow(10, e);
      if (v >= lo * 0.9 && v <= hi * 1.1) ticks.push(v);
    }
    return ticks.length ? ticks : [lo, hi];
  }
  const span = hi - lo;
  const step0 = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const prec = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (
    let v = Math.ceil(lo / step - 1e-9) * step;
    v <= hi + step * 0.51;
    v += step
  ) {
    ticks.push(Number(v.toFixed(prec)));
    if (ticks.length > 14) break;
  }
  return ticks.length ? ticks : [lo, hi];
}

export default function PriceChart({
  data,
  height = 240,
}: {
  data: Point[];
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    const pts: P[] = [];
    for (const d of data) {
      if (!Number.isFinite(d.price) || d.price <= 0 || !d.time) continue;
      const t = new Date(d.time).getTime();
      if (Number.isNaN(t)) continue;
      pts.push({ t, price: d.price, time: d.time });
    }
    pts.sort((a, b) => a.t - b.t || a.price - b.price);
    if (pts.length === 0) return null;

    // Прореживание (сохраняем экстремумы)
    let arr = pts;
    if (pts.length > MAX_DRAWN) {
      const bucket = Math.ceil(pts.length / MAX_DRAWN);
      const out: P[] = [];
      for (let i = 0; i < pts.length; i += bucket) {
        const slice = pts.slice(i, i + bucket);
        const sum = slice.reduce((a, p) => a + p.price, 0);
        const mid = slice[Math.floor(slice.length / 2)];
        out.push({ t: mid.t, price: Math.round(sum / slice.length), time: mid.time });
      }
      let mn = pts[0], mx = pts[0];
      for (const p of pts) {
        if (p.price < mn.price) mn = p;
        if (p.price >= mx.price) mx = p;
      }
      out.push(mn, mx);
      out.sort((a, b) => a.t - b.t || a.price - b.price);
      arr = out;
    }

    let min = Infinity, max = -Infinity, minIdx = 0, maxIdx = 0;
    arr.forEach((p, i) => {
      if (p.price < min) { min = p.price; minIdx = i; }
      if (p.price >= max) { max = p.price; maxIdx = i; }
    });

    // Лог-шкала, если разброс огромный (иначе мелкие продажи сплющиваются в прямую у нуля)
    const log = max / Math.max(1, min) > 40;

    let lo = min, hi = max;
    if (log) {
      const e0 = Math.log10(Math.max(1, min));
      const e1 = Math.log10(max);
      const pad = (e1 - e0) * 0.06;
      lo = Math.pow(10, e0 - pad);
      hi = Math.pow(10, e1 + pad);
    } else if (hi - lo <= 0) {
      lo = Math.max(0, min * 0.9);
      hi = max * 1.1 || 1;
    } else {
      const pad = (hi - lo) * 0.18;
      lo = Math.max(0, lo - pad);
      hi = hi + pad;
    }

    const t0 = arr[0].t;
    const t1 = arr[arr.length - 1].t > t0 ? arr[arr.length - 1].t : t0 + 60000;
    return { arr, min, max, minIdx, maxIdx, lo, hi, t0, t1, log };
  }, [data]);

  const innerW = Math.max(10, width - PAD_L - PAD_R);
  const innerH = Math.max(10, height - PAD_T - PAD_B);

  // Преобразование цены -> y (лог или линейное)
  const priceY = (p: number): number => {
    if (!model) return 0;
    if (model.log) {
      const e = Math.log10(Math.max(1, p));
      const e0 = Math.log10(Math.max(1, model.lo));
      const e1 = Math.log10(model.hi);
      const f = (e - e0) / (e1 - e0);
      return PAD_T + (1 - f) * innerH;
    }
    const f = (p - model.lo) / (model.hi - model.lo);
    return PAD_T + (1 - f) * innerH;
  };

  const xOf = (t: number) => {
    if (!model) return 0;
    return PAD_L + ((t - model.t0) / (model.t1 - model.t0)) * innerW;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width < 10 || !model) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { arr, lo, hi, log } = model;

    ctx.font = "10px Inter, sans-serif";
    ctx.lineWidth = 1;
    for (const v of niceTicks(lo, hi, 5, log)) {
      const y = priceY(v);
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.07)";
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(width - PAD_R, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#71717a";
      ctx.textAlign = "right";
      ctx.fillText(formatCompact(v), PAD_L - 8, y + 3);
    }

    // Подписи времени
    ctx.fillStyle = "#5b5b63";
    ctx.textAlign = "center";
    for (let i = 0; i <= 4; i++) {
      const t = model.t0 + ((model.t1 - model.t0) * i) / 4;
      const dt = new Date(t);
      const sameDay = new Date(model.t0).toDateString() === new Date(model.t1).toDateString();
      const label = sameDay
        ? dt.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : dt.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const cx = Math.min(Math.max(xOf(t), PAD_L + 24), width - PAD_R - 24);
      ctx.fillText(label, cx, height - 8);
    }

    // Заливка
    const grad = ctx.createLinearGradient(0, PAD_T, 0, height - PAD_B);
    grad.addColorStop(0, "rgba(52,211,153,0.20)");
    grad.addColorStop(1, "rgba(52,211,153,0)");
    ctx.beginPath();
    ctx.moveTo(xOf(arr[0].t), height - PAD_B);
    for (const p of arr) ctx.lineTo(xOf(p.t), priceY(p.price));
    ctx.lineTo(xOf(arr[arr.length - 1].t), height - PAD_B);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Линия
    ctx.beginPath();
    arr.forEach((p, i) => {
      if (i === 0) ctx.moveTo(xOf(p.t), priceY(p.price));
      else ctx.lineTo(xOf(p.t), priceY(p.price));
    });
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    if (arr.length <= 120) {
      ctx.fillStyle = "#34d399";
      for (const p of arr) {
        ctx.beginPath();
        ctx.arc(xOf(p.t), priceY(p.price), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Маркеры минимума/максимума
    const mn = arr[model.minIdx];
    ctx.beginPath();
    ctx.arc(xOf(mn.t), priceY(mn.price), 3, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0a0c";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#71717a";
    ctx.stroke();

    const mx = arr[model.maxIdx];
    ctx.beginPath();
    ctx.arc(xOf(mx.t), priceY(mx.price), 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(52,211,153,0.25)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xOf(mx.t), priceY(mx.price), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#34d399";
    ctx.fill();
  }, [width, height, model, innerW, innerH]);

  // Выбор точки по 2D-расстоянию до курсора (X и Y) — крестик показывает ту вершину, где курсор
  const pick = (clientX: number, clientY: number): number | null => {
    if (!model) return null;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best = 0, bestDist = Infinity;
    const { arr } = model;
    for (let i = 0; i < arr.length; i++) {
      const dx = xOf(arr[i].t) - mx;
      const dy = priceY(arr[i].price) - my;
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  };

  const hover = hoverIdx !== null && model ? model.arr[hoverIdx] : null;
  const maxPt = model ? model.arr[model.maxIdx] : null;
  const maxLabelBelow = maxPt !== null && model ? priceY(maxPt.price) < PAD_T + 30 : false;

  if (!model) {
    return (
      <div className="grid h-[240px] place-items-center text-center">
        <div>
          <p className="text-[13.5px] font-medium text-zinc-400">Нет данных за выбранный период</p>
          <p className="mt-1 text-[12px] text-zinc-600">Попробуйте другой период или регион</p>
        </div>
      </div>
    );
  }

  const fmtFull = (v: number) => `${formatPrice(v)} ₽`;
  const tipLeft = hover && model
    ? Math.min(Math.max(xOf(hover.t), 90), Math.max(90, width - 90))
    : 0;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height, display: "block", cursor: "crosshair" }}
        onMouseMove={(e) => setHoverIdx(pick(e.clientX, e.clientY))}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={(e) => { if (e.touches[0]) setHoverIdx(pick(e.touches[0].clientX, e.touches[0].clientY)); }}
        onTouchMove={(e) => { if (e.touches[0]) setHoverIdx(pick(e.touches[0].clientX, e.touches[0].clientY)); }}
        onTouchEnd={() => setHoverIdx(null)}
      />

      {maxPt && model && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: Math.min(Math.max(xOf(maxPt.t), 74), Math.max(74, width - 74)),
            top: priceY(maxPt.price),
            transform: maxLabelBelow ? "translate(-50%, 12px)" : "translate(-50%, -100%) translateY(-10px)",
          }}
        >
          <div className="mono whitespace-nowrap rounded-lg border border-emerald-400/40 bg-zinc-950/95 px-2 py-0.5 text-[11.5px] font-bold text-emerald-300 shadow-lg">
            ▲ {fmtFull(model.max)}
          </div>
        </div>
      )}

      {hover && model && hoverIdx !== null && (
        <>
          <div className="pointer-events-none absolute top-0 bottom-6 w-px bg-white/25" style={{ left: xOf(hover.t) }} />
          <div
            className="pointer-events-none absolute z-20 h-2.5 w-2.5 rounded-full border-2 border-emerald-400 bg-zinc-950"
            style={{ left: xOf(hover.t) - 5, top: priceY(hover.price) - 5 }}
          />
          <div className="chart-tip" style={{ left: tipLeft, top: priceY(hover.price) - 6 }}>
            <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-1.5 shadow-xl">
              <div className="mono text-[13px] font-bold whitespace-nowrap text-emerald-300">{fmtFull(hover.price)}</div>
              <div className="text-[11px] whitespace-nowrap text-zinc-400">
                {new Date(hover.t).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-2">
          <span className="inline-block h-[2px] w-5 bg-emerald-400" /> Цена за шт.
        </span>
        <span className="mono">мин {fmtFull(model.min)} · макс {fmtFull(model.max)}</span>
        {model.log && <span className="text-zinc-600">лог. шкала</span>}
        <span className="ml-auto">{model.arr.length} сделок</span>
      </div>
    </div>
  );
}
