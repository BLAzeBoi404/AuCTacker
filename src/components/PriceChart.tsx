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
const MAX_DRAWN = 1200;

/** «Красивые» шаги сетки, гарантированно покрывающие [lo, hi] */
function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo, hi];
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
    // Точки без времени ломают ось X (уходили в 1970-й и сплющивали весь график) — их отбрасываем
    const pts: P[] = [];
    for (const d of data) {
      if (!Number.isFinite(d.price) || d.price <= 0 || !d.time) continue;
      const t = new Date(d.time).getTime();
      if (Number.isNaN(t)) continue;
      pts.push({ t, price: d.price, time: d.time });
    }
    pts.sort((a, b) => a.t - b.t || a.price - b.price);
    if (pts.length === 0) return null;

    // Прореживание для скорости: среднее по корзинам, min/max всегда сохраняем
    let arr = pts;
    if (pts.length > MAX_DRAWN) {
      const bucket = Math.ceil(pts.length / MAX_DRAWN);
      const out: P[] = [];
      for (let i = 0; i < pts.length; i += bucket) {
        const slice = pts.slice(i, i + bucket);
        const sum = slice.reduce((a, p) => a + p.price, 0);
        const mid = slice[Math.floor(slice.length / 2)];
        out.push({
          t: mid.t,
          price: Math.round(sum / slice.length),
          time: mid.time,
        });
      }
      // Возвращаем реальные экстремумы, чтобы вершины не терялись
      let mn = pts[0];
      let mx = pts[0];
      for (const p of pts) {
        if (p.price < mn.price) mn = p;
        if (p.price >= mx.price) mx = p;
      }
      out.push(mn, mx);
      out.sort((a, b) => a.t - b.t || a.price - b.price);
      arr = out;
    }

    let min = Infinity;
    let max = -Infinity;
    let minIdx = 0;
    let maxIdx = 0;
    arr.forEach((p, i) => {
      if (p.price < min) {
        min = p.price;
        minIdx = i;
      }
      if (p.price >= max) {
        max = p.price;
        maxIdx = i;
      }
    });

    let lo = min;
    let hi = max;
    if (hi - lo <= 0) {
      lo = Math.max(0, min * 0.9);
      hi = max * 1.1 || 1;
    } else {
      const pad = (hi - lo) * 0.18;
      lo = Math.max(0, lo - pad);
      hi = hi + pad;
    }
    const t0 = arr[0].t;
    const t1 = arr[arr.length - 1].t > t0 ? arr[arr.length - 1].t : t0 + 60000;
    return { arr, min, max, minIdx, maxIdx, lo, hi, t0, t1 };
  }, [data]);

  const innerW = Math.max(10, width - PAD_L - PAD_R);
  const innerH = Math.max(10, height - PAD_T - PAD_B);

  const xOf = (t: number) =>
    !model ? 0 : PAD_L + ((t - model.t0) / (model.t1 - model.t0)) * innerW;
  const yOf = (p: number) =>
    !model ? 0 : PAD_T + (1 - (p - model.lo) / (model.hi - model.lo)) * innerH;

  // ---------- Рисование ----------
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

    const { arr, lo, hi } = model;
    const lx = (t: number) =>
      PAD_L + ((t - model.t0) / (model.t1 - model.t0)) * innerW;
    const ly = (p: number) =>
      PAD_T + (1 - (p - lo) / (hi - lo)) * innerH;

    // Сетка + подписи оси Y (верхняя линия всегда >= максимума)
    ctx.font = "10px Inter, sans-serif";
    ctx.lineWidth = 1;
    for (const v of niceTicks(lo, hi, 5)) {
      const y = ly(v);
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
      const x = lx(t);
      const dt = new Date(t);
      const sameDay =
        new Date(model.t0).toDateString() === new Date(model.t1).toDateString();
      const label = sameDay
        ? dt.toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit" })
        : dt.toLocaleString("ru-RU", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
      const cx = Math.min(Math.max(x, PAD_L + 20), width - PAD_R - 20);
      ctx.fillText(label, cx, height - 8);
    }

    // Заливка
    const grad = ctx.createLinearGradient(0, PAD_T, 0, height - PAD_B);
    grad.addColorStop(0, "rgba(212,255,63,0.20)");
    grad.addColorStop(1, "rgba(212,255,63,0)");
    ctx.beginPath();
    ctx.moveTo(lx(arr[0].t), height - PAD_B);
    for (const p of arr) ctx.lineTo(lx(p.t), ly(p.price));
    ctx.lineTo(lx(arr[arr.length - 1].t), height - PAD_B);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Линия
    ctx.beginPath();
    arr.forEach((p, i) => {
      if (i === 0) ctx.moveTo(lx(p.t), ly(p.price));
      else ctx.lineTo(lx(p.t), ly(p.price));
    });
    ctx.strokeStyle = "#d4ff3f";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();

    // Точки при малом количестве сделок
    if (arr.length <= 120) {
      ctx.fillStyle = "#d4ff3f";
      for (const p of arr) {
        ctx.beginPath();
        ctx.arc(lx(p.t), ly(p.price), 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Маркер минимума
    const mn = arr[model.minIdx];
    ctx.beginPath();
    ctx.arc(lx(mn.t), ly(mn.price), 3, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0a0c";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#71717a";
    ctx.stroke();

    // Маркер максимума — вершина всегда видна
    const mx = arr[model.maxIdx];
    ctx.beginPath();
    ctx.arc(lx(mx.t), ly(mx.price), 6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(212,255,63,0.25)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lx(mx.t), ly(mx.price), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#d4ff3f";
    ctx.fill();
  }, [width, height, model, innerW, innerH]);

  const pick = (clientX: number): number | null => {
    if (!model) return null;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const mx = clientX - rect.left;
    let best = 0;
    let bestDist = Infinity;
    const { arr } = model;
    for (let i = 0; i < arr.length; i++) {
      const dist = Math.abs(xOf(arr[i].t) - mx);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  };

  const hover = hoverIdx !== null && model ? model.arr[hoverIdx] : null;
  const maxPt = model ? model.arr[model.maxIdx] : null;
  // Подпись пика: над точкой, но если вершина у самого верха — под ней
  const maxLabelBelow =
    maxPt !== null && model ? yOf(maxPt.price) < PAD_T + 30 : false;

  if (!model) {
    return (
      <div className="grid h-[240px] place-items-center text-center">
        <div>
          <p className="text-[13.5px] font-medium text-zinc-400">
            Нет данных за выбранный период
          </p>
          <p className="mt-1 text-[12px] text-zinc-600">
            Попробуйте другой период или регион
          </p>
        </div>
      </div>
    );
  }

  const fmtFull = (v: number) => `${formatPrice(v)} ₽`;
  const tipLeft =
    hover && model
      ? Math.min(Math.max(xOf(hover.t), 86), Math.max(86, width - 86))
      : 0;

  return (
    <div ref={wrapRef} className="relative w-full select-none">
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height, display: "block", cursor: "crosshair" }}
        onMouseMove={(e) => setHoverIdx(pick(e.clientX))}
        onMouseLeave={() => setHoverIdx(null)}
        onTouchStart={(e) => {
          if (e.touches[0]) setHoverIdx(pick(e.touches[0].clientX));
        }}
        onTouchMove={(e) => {
          if (e.touches[0]) setHoverIdx(pick(e.touches[0].clientX));
        }}
        onTouchEnd={() => setHoverIdx(null)}
      />

      {/* Подпись пика с точной ценой */}
      {maxPt && model && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: Math.min(
              Math.max(xOf(maxPt.t), 70),
              Math.max(70, width - 70)
            ),
            top: yOf(maxPt.price),
            transform: maxLabelBelow
              ? "translate(-50%, 12px)"
              : "translate(-50%, -100%) translateY(-10px)",
          }}
        >
          <div className="mono whitespace-nowrap rounded-lg border border-[#d4ff3f]/40 bg-zinc-950/95 px-2 py-0.5 text-[11.5px] font-bold text-[#d4ff3f] shadow-lg">
            ▲ {fmtFull(model.max)}
          </div>
        </div>
      )}

      {/* Перекрестие + тултип */}
      {hover && model && hoverIdx !== null && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-6 w-px bg-white/25"
            style={{ left: xOf(hover.t) }}
          />
          <div
            className="pointer-events-none absolute z-20 h-2.5 w-2.5 rounded-full border-2 border-[#d4ff3f] bg-zinc-950"
            style={{
              left: xOf(hover.t) - 5,
              top: yOf(hover.price) - 5,
            }}
          />
          <div
            className="chart-tip"
            style={{ left: tipLeft, top: yOf(hover.price) - 6 }}
          >
            <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-1.5 shadow-xl">
              <div className="mono text-[13px] font-bold whitespace-nowrap text-[#d4ff3f]">
                {fmtFull(hover.price)}
              </div>
              <div className="text-[11px] whitespace-nowrap text-zinc-400">
                {new Date(hover.t).toLocaleString("ru-RU", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
        <span className="flex items-center gap-2">
          <span className="inline-block h-[2px] w-5 bg-[#d4ff3f]" /> Цена за шт.
        </span>
        <span className="mono">
          мин {fmtFull(model.min)} · макс {fmtFull(model.max)}
        </span>
        <span className="ml-auto">{model.arr.length} сделок</span>
      </div>
    </div>
  );
}
