"use client";

import {
  Gavel, Package, Crosshair, Send, ArrowRight,
  Zap, BellRing, BarChart3, ShieldCheck,
} from "lucide-react";

export default function HomeView({
  onNavigate,
}: {
  onNavigate: (v: "auction" | "catalog") => void;
}) {
  const features = [
    {
      icon: BarChart3,
      title: "Живые цены аукциона",
      text: "Минимум, среднее, максимум, история продаж и графики по каждому предмету.",
    },
    {
      icon: Crosshair,
      title: "Трекер лотов",
      text: "Следите за заточкой, редкостью и ценой. Уведомления в Telegram — даже когда сайт закрыт.",
    },
    {
      icon: Send,
      title: "Уведомления",
      text: "Сервер следит за отмеченными предметами 24/7 и присылает новости в Telegram.",
    },
    {
      icon: BellRing,
      title: "Просто и быстро",
      text: "Найдите предмет, включите слежку — остальное сделает сервер.",
    },
  ];

  return (
    <div className="anim-fade-up">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-zinc-800/80 bg-gradient-to-b from-[#12121a] to-[#0a0a0c] px-6 py-12 sm:px-12 sm:py-16">
        <div className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[560px] -translate-x-1/2 rounded-full bg-[#34d399]/10 blur-[120px]" />
        <div className="relative">
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-widest text-[#34d399]">
            <Zap className="h-3.5 w-3.5" /> Мониторинг аукциона STALCRAFT
          </div>
          <h1 className="mt-4 text-4xl font-extrabold tracking-tight text-white sm:text-5xl">
            Auc<span className="text-[#34d399]">Tracker</span>
          </h1>
          <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-zinc-400">
            Цены, история продаж, трекинг предметов и калькулятор сборок — в одном
            месте. Уведомления о нужных лотах приходят прямо в Telegram, даже если
            вы не открываете сайт.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={() => onNavigate("auction")}
              className="flex items-center gap-2 rounded-xl bg-[#34d399] px-5 py-3 text-[14px] font-bold text-black transition hover:brightness-110"
            >
              <Gavel className="h-4 w-4" /> Открыть аукцион <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={() => onNavigate("catalog")}
              className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-800/60 px-5 py-3 text-[14px] font-semibold text-zinc-100 transition hover:bg-zinc-700"
            >
              <Package className="h-4 w-4" /> Каталог предметов
            </button>
          </div>
        </div>
      </section>

      {/* Фичи */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((f) => (
          <div
            key={f.title}
            className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-5 transition hover:border-zinc-700"
          >
            <f.icon className="h-5 w-5 text-[#34d399]" />
            <h3 className="mt-3 text-[15px] font-bold text-white">{f.title}</h3>
            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">{f.text}</p>
          </div>
        ))}
      </section>

      {/* Как это работает */}
      <section className="mt-6 grid gap-4 rounded-2xl border border-zinc-800/80 bg-[#101013] p-6 lg:grid-cols-3">
        <div className="flex gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#34d399]/15 text-[#34d399]"><Searchlike /></span>
          <div>
            <h3 className="text-[14px] font-bold text-white">1. Найдите предмет</h3>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">Через поиск или каталог — цены и лоты появятся сразу.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#34d399]/15 text-[#34d399]"><Crosshair className="h-4 w-4" /></span>
          <div>
            <h3 className="text-[14px] font-bold text-white">2. Включите слежку</h3>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">Задайте заточку, редкость и цену — укажите свой Telegram.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#34d399]/15 text-[#34d399]"><Send className="h-4 w-4" /></span>
          <div>
            <h3 className="text-[14px] font-bold text-white">3. Получайте новости</h3>
            <p className="mt-0.5 text-[12.5px] text-zinc-500">Серверу не важен ваш компьютер — уведомления приходят сами.</p>
          </div>
        </div>
      </section>

      {/* Статус */}
      <section className="mt-6 flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800/80 bg-[#101013] p-6">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-emerald-300">
          <span className="h-2 w-2 rounded-full bg-emerald-400 live-dot" /> Сервер работает
        </span>
        <p className="min-w-0 flex-1 text-[13px] text-zinc-500">
          Планировщик проверяет отмеченные предметы по расписанию и шлёт уведомления
          в Telegram — сайт можно держать закрытым.
        </p>
        <span className="flex items-center gap-2 text-[13px] text-zinc-400">
          <ShieldCheck className="h-4 w-4 text-[#34d399]" /> данные: EXBO EAPI
        </span>
      </section>
    </div>
  );
}

// Мини-иконка для шага 1
function Searchlike() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
