export function formatPrice(price: number | null | undefined): string {
  if (!price || price <= 0) return "0";
  return price.toLocaleString("ru-RU");
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(Math.round(n));
  const fmt = (v: number, maxDec: number) =>
    sign +
    v
      .toFixed(maxDec)
      .replace(/\.?0+$/, "")
      .replace(".", ",");
  if (a >= 1_000_000) return `${fmt(a / 1_000_000, 2)} млн`;
  if (a >= 1_000) return `${fmt(a / 1_000, 1)} тыс`;
  return `${sign}${a}`;
}

export function getTimeLeft(endTime: string | null | undefined): string {
  if (!endTime) return "—";
  const diff = new Date(endTime).getTime() - Date.now();
  if (diff <= 0) return "Истёк";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff / 60000) % 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function formatFullDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function timeAgo(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return "";
  const d = typeof dateStr === "string" ? new Date(dateStr) : dateStr;
  const diff = Date.now() - d.getTime();
  if (diff < 0) return "только что";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} мин назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} д назад`;
  return formatDate(d.toISOString());
}

export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function playBeep(freq = 880, duration = 180) {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {
    // ignore
  }
}

export function playNotifySound() {
  playBeep(880, 150);
  setTimeout(() => playBeep(1174, 200), 160);
}

export const FALLBACK_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
  );
