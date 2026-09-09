"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Bell, BellRing, Plus, RefreshCw, Trash2, X, ChevronLeft,
  ChevronRight, ChevronDown, Star, TrendingUp, TrendingDown, Minus,
  Package, Gavel, History as HistoryIcon, Settings2, Volume2, VolumeX,
  Check, Eye, EyeOff, Zap, Shield, Crosshair, Clock, Database, Swords,
  FlaskConical, Backpack, Menu, CircleDot, ExternalLink,
  Info, Settings as SettingsIcon, Send, Copy, Link2, Server, Globe,
  KeyRound, MessageCircle, BarChart3, ArrowDown, ArrowUp, ShoppingBag,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import PriceChart from "./PriceChart";
import {
  formatPrice, getTimeLeft, formatDate, timeAgo, playNotifySound,
  FALLBACK_ICON,
} from "@/lib/utils";
import {
  QUALITY_NAMES, QUALITY_COLORS, REGIONS, categoryLabel,
} from "@/lib/constants";

// ---------- Types ----------
interface Item {
  id: string;
  nameRu?: string;
  name?: string;
  nameEn?: string;
  category?: string;
  iconUrl?: string;
  icon?: string;
  color?: string;
}
interface Lot {
  id: string;
  startPrice: number;
  buyoutPrice: number;
  amount: number;
  endTime: string | null;
  upgrade: number;
  quality: number;
  qualityName: string;
  pricePerUnit?: number;
}
interface HistEntry {
  id: string;
  price: number;
  time: string | null;
  upgrade: number;
  quality: number;
  qualityName: string;
}
interface Tracker {
  id: number;
  itemId: string;
  itemName: string;
  itemIcon: string | null;
  region: string;
  upgradeMode: string;
  targetUpgrade: number;
  targetQuality: number;
  maxPrice: number;
  minPrice: number;
  enabled: boolean;
  enableSound: boolean;
  enableBrowser: boolean;
  notifyChatIds: string[] | null;
  matchCount: number;
  lastCheckedAt: string | null;
  lastMatchedAt: string | null;
  createdAt: string;
}
interface TgChat {
  chatId: string;
  name: string | null;
  username: string | null;
  isActive: boolean;
  linkedAt: string;
  lastMessageAt: string | null;
}
interface SchedulerInfo {
  started: boolean;
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  lastSummary: string | null;
  interval: number;
  nextRunAt: string | null;
}
interface SettingsState {
  scheduler_enabled: string;
  scheduler_interval: string;
  site_url: string;
  telegram_enabled: string;
  telegram_has_token: string;
  telegram_bot_username: string;
  cron_secret: string;
}
interface Notif {
  id: number;
  trackerId: number | null;
  itemId: string;
  itemName: string;
  itemIcon: string | null;
  region: string;
  price: number;
  upgrade: number;
  quality: number;
  qualityName: string | null;
  message: string | null;
  isRead: boolean;
  createdAt: string;
}
interface Toast {
  id: number;
  title: string;
  message: string;
  icon?: string | null;
}

const itemName = (it: Item | null | undefined) =>
  it?.nameRu || it?.name || it?.id || "—";
const itemIcon = (it: Item | null | undefined) =>
  it?.iconUrl || it?.icon || FALLBACK_ICON;

async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const UPGRADE_CHIPS: (number | null)[] = [null, 0, 5, 10, 12, 13, 15];

export default function AuctionApp() {
  // ---------- Global state ----------
  const [view, setView] = useState<"auction" | "catalog" | "trackers" | "settings">("auction");
  const [region, setRegion] = useState("RU");
  const [regionOpen, setRegionOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const AUTO_REFRESH_MS = 30000;
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // ---------- Item + search ----------
  const [selectedItem, setSelectedItem] = useState<Item>({
    id: "kqgy", nameRu: "Браслет",
    iconUrl: "https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global/icons/artefact/kqgy.png",
    category: "artefact",
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Item[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const catalogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------- Lots / history ----------
  const [lots, setLots] = useState<Lot[]>([]);
  const [lotsTotal, setLotsTotal] = useState(0);
  const [lotsLoading, setLotsLoading] = useState(false);
  const [history, setHistory] = useState<HistEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<"lots" | "history">("lots");
  const [timeframe, setTimeframe] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // ---------- Filters ----------
  const [filterUpgrade, setFilterUpgrade] = useState<number | null>(null);
  const [filterQuality, setFilterQuality] = useState<number | null>(null);
  const [sortOrder, setSortOrder] = useState<string>("price_asc");
  const [maxPriceFilter, setMaxPriceFilter] = useState("");
  const [page, setPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const perPage = 15;

  // ---------- Trackers ----------
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [showTrackerModal, setShowTrackerModal] = useState(false);
  const [trackerForm, setTrackerForm] = useState({
    upgradeMode: "exact", targetUpgrade: 0, targetQuality: -1,
    maxPrice: 0, minPrice: 0, enableSound: true, enableBrowser: true,
  });
  const [checkInterval, setCheckInterval] = useState(60);
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<Date | null>(null);

  // ---------- Notifications ----------
  const [notifications, setNotifications] = useState<Notif[]>([]);
  const [unread, setUnread] = useState(0);
  const [showNotifs, setShowNotifs] = useState(false);
  const [notifPermission, setNotifPermission] = useState<string>(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );

  // ---------- Toasts ----------
  const [toasts, setToasts] = useState<Toast[]>([]);

  // ---------- Catalog ----------
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogCategory, setCatalogCategory] = useState("all");
  const [catalogItems, setCatalogItems] = useState<Item[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const catalogPerPage = 24;

  // ---------- Init ----------
  useEffect(() => {
    try {
      const r = localStorage.getItem("staltrack_region");
      if (r) setRegion(r);
      const s = localStorage.getItem("staltrack_sound");
      if (s !== null) setSoundOn(s === "1");
      const it = localStorage.getItem("staltrack_item");
      const params = new URLSearchParams(window.location.search);
      const urlItem = params.get("item");
      if (urlItem) {
        fetchJson<{ success: boolean; item: Item }>(`/api/items/${urlItem.toLowerCase()}`)
          .then((d) => { if (d.success && d.item) { setSelectedItem(d.item); setSearchQuery(itemName(d.item)); } })
          .catch(() => {});
      } else if (it) {
        try {
          const parsed = JSON.parse(it) as Item;
          setSelectedItem(parsed);
          setSearchQuery(itemName(parsed));
        } catch { /* ignore */ }
      }
      const ci = localStorage.getItem("staltrack_check_interval");
      if (ci) setCheckInterval(Number(ci) || 30);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setShowDropdown(false); setShowTrackerModal(false); setShowNotifs(false); }
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, []);

  const pushToast = useCallback((title: string, message: string, icon?: string | null) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-4), { id, title, message, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 7000);
  }, []);

  // ---------- Fetchers ----------
  const fetchLots = useCallback(async (itemId: string, reg: string) => {
    setLotsLoading(true);
    setApiError(null);
    try {
      const d = await fetchJson<{ success: boolean; lots: Lot[]; total: number }>(
        `/api/lots?itemId=${encodeURIComponent(itemId)}&region=${reg}&limit=500`
      );
      setLots(d.lots || []);
      setLotsTotal(d.total || (d.lots || []).length);
      setLastUpdate(new Date());
    } catch {
      setLots([]);
      setLotsTotal(0);
      setApiError("Не удалось загрузить лоты. API EXBO может быть недоступно — попробуйте обновить.");
    } finally {
      setLotsLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async (itemId: string, reg: string) => {
    setHistoryLoading(true);
    try {
      const d = await fetchJson<{ success: boolean; history: HistEntry[] }>(
        `/api/history?itemId=${encodeURIComponent(itemId)}&region=${reg}&limit=600`
      );
      setHistory(d.history || []);
      setHistoryLoaded(true);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadTrackers = useCallback(async () => {
    try {
      const d = await fetchJson<{ success: boolean; trackers: Tracker[] }>("/api/trackers");
      setTrackers(d.trackers || []);
    } catch { /* ignore */ }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const d = await fetchJson<{ success: boolean; notifications: Notif[]; unread: number }>(
        "/api/notifications?limit=50"
      );
      setNotifications(d.notifications || []);
      setUnread(d.unread || 0);
    } catch { /* ignore */ }
  }, []);

  // ---------- Настройки / Telegram ----------
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerInfo | null>(null);
  const [tgChats, setTgChats] = useState<TgChat[]>([]);
  const [tgBotUsername, setTgBotUsername] = useState<string | null>(null);
  const [tgTokenInput, setTgTokenInput] = useState("");
  const [tgBusy, setTgBusy] = useState(false);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [linkDeep, setLinkDeep] = useState<string | null>(null);
  const [siteUrlInput, setSiteUrlInput] = useState("");
  const [tgSelected, setTgSelected] = useState<string[] | null>(null); // null = всем привязанным

  const cronUrl =
    settings?.cron_secret && typeof window !== "undefined"
      ? `${window.location.origin}/api/cron/check?secret=${settings.cron_secret}`
      : "";

  const copyText = useCallback((s: string, label = "Скопировано") => {
    try {
      const done = () => pushToast(label, s.length > 70 ? s.slice(0, 70) + "…" : s);
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(s).then(done, () => pushToast("Ошибка", "Скопируйте вручную."));
      } else {
        pushToast("Ошибка", "Скопируйте вручную.");
      }
    } catch {
      pushToast("Ошибка", "Скопируйте вручную.");
    }
  }, [pushToast]);

  const loadSettings = useCallback(async () => {
    try {
      const d = await fetchJson<{ success: boolean; settings: SettingsState; scheduler: SchedulerInfo }>("/api/settings");
      if (d.success) {
        setSettings(d.settings);
        setScheduler(d.scheduler);
        setSiteUrlInput(d.settings.site_url || "");
      }
    } catch { /* ignore */ }
    try {
      const t = await fetchJson<{ success: boolean; chats: TgChat[]; botUsername: string | null }>("/api/telegram");
      setTgChats(t.chats || []);
      setTgBotUsername(t.botUsername);
    } catch { /* ignore */ }
  }, []);

  const saveSettings = useCallback(async (values: Record<string, string>, msg = "Настройки сохранены") => {
    try {
      await fetchJson("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      await loadSettings();
      pushToast("Готово", msg);
    } catch {
      pushToast("Ошибка", "Не удалось сохранить настройки.");
    }
  }, [loadSettings, pushToast]);

  const saveTgToken = useCallback(async () => {
    if (!tgTokenInput.trim()) return;
    setTgBusy(true);
    try {
      const d = await fetchJson<{ success: boolean; botUsername?: string; error?: string }>("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-token", token: tgTokenInput.trim() }),
      });
      if (d.success) {
        setTgTokenInput("");
        await loadSettings();
        pushToast("Бот подключён", `@${d.botUsername} готов к работе.`);
      } else {
        pushToast("Ошибка", d.error === "invalid_token" ? "Токен неверный — проверьте у @BotFather." : "Не удалось сохранить токен.");
      }
    } catch {
      pushToast("Ошибка", "Не удалось сохранить токен.");
    } finally {
      setTgBusy(false);
    }
  }, [tgTokenInput, loadSettings, pushToast]);

  const deleteTgToken = useCallback(async () => {
    try {
      await fetchJson("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-token" }),
      });
      setLinkCode(null);
      setLinkDeep(null);
      await loadSettings();
      pushToast("Готово", "Токен бота удалён.");
    } catch {
      pushToast("Ошибка", "Не удалось удалить токен.");
    }
  }, [loadSettings, pushToast]);

  const genLinkCode = useCallback(async () => {
    setTgBusy(true);
    try {
      const d = await fetchJson<{ success: boolean; code?: string; deepLink?: string | null }>("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "link-code" }),
      });
      if (d.success && d.code) {
        setLinkCode(d.code);
        setLinkDeep(d.deepLink || null);
      } else {
        pushToast("Ошибка", "Сначала сохраните токен бота.");
      }
    } catch {
      pushToast("Ошибка", "Не удалось создать код.");
    } finally {
      setTgBusy(false);
    }
  }, [pushToast]);

  const pollTgNow = useCallback(async () => {
    setTgBusy(true);
    try {
      const d = await fetchJson<{ success: boolean; linked?: string[] }>("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "poll" }),
      });
      await loadSettings();
      if (d.linked && d.linked.length > 0) pushToast("Привязано!", `Новых чатов: ${d.linked.length}.`);
      else pushToast("Проверка выполнена", "Новых привязок нет — отправьте /start с кодом боту.");
    } catch {
      pushToast("Ошибка", "Не удалось опросить Telegram.");
    } finally {
      setTgBusy(false);
    }
  }, [loadSettings, pushToast]);

  const testTg = useCallback(async (chatId: string | null) => {
    try {
      await fetchJson("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", chatId }),
      });
      pushToast("Отправлено", "Проверьте Telegram.");
    } catch {
      pushToast("Ошибка", "Не удалось отправить тест.");
    }
  }, [pushToast]);

  const unlinkTg = useCallback(async (chatId: string) => {
    try {
      await fetchJson("/api/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unlink", chatId }),
      });
      loadSettings();
    } catch { /* ignore */ }
  }, [loadSettings]);

  const regenCron = useCallback(async () => {
    try {
      await fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regen-cron" }),
      });
      await loadSettings();
      pushToast("Готово", "Новый секрет создан — обновите URL в cron-сервисе!");
    } catch {
      pushToast("Ошибка", "Не удалось обновить секрет.");
    }
  }, [loadSettings, pushToast]);

  const syncItems = useCallback(async () => {
    pushToast("Синхронизация", "Обновляю базу предметов…");
    try {
      const d = await fetchJson<{ success: boolean; count?: number }>("/api/items/sync", { method: "POST" });
      if (d.success) {
        pushToast("Готово", `Предметов в базе: ${d.count}`);
        if (view === "catalog") loadCatalog(catalogQuery, catalogCategory, 1);
      } else {
        pushToast("Ошибка", "Не удалось обновить базу.");
      }
    } catch {
      pushToast("Ошибка", "Не удалось обновить базу.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushToast, view, catalogQuery, catalogCategory]);

  useEffect(() => {
    if (view === "settings") loadSettings();
  }, [view, loadSettings]);

  // Держим статус фонового планировщика свежим для живого счётчика в футере.
  // Важно: НЕ опрашиваем сервер каждые несколько секунд — на бесплатном
  // Neon это не даёт базе "заснуть" и сжигает лимит CU-часов. Вместо этого
  // локальный счётчик просто тикает (см. nowTick), а сервер спрашиваем один
  // раз, когда обратный отсчёт истёк (плюс небольшая пауза, чтобы сервер
  // успел завершить проверку), и при возврате на вкладку.
  const settingsRefetchLock = useRef(false);
  useEffect(() => {
    if (!scheduler?.nextRunAt) return;
    const msLeft = new Date(scheduler.nextRunAt).getTime() - nowTick;
    if (msLeft > -2000 || settingsRefetchLock.current) return;
    settingsRefetchLock.current = true;
    loadSettings().finally(() => {
      setTimeout(() => { settingsRefetchLock.current = false; }, 3000);
    });
  }, [nowTick, scheduler?.nextRunAt, loadSettings]);

  useEffect(() => {
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden && view === "settings") loadSettings();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [view, loadSettings]);

  useEffect(() => {
    if (showTrackerModal) loadSettings();
  }, [showTrackerModal, loadSettings]);

  const onCatalogQuery = (v: string) => {
    setCatalogQuery(v);
    if (catalogTimer.current) clearTimeout(catalogTimer.current);
    if (catalogPage !== 1) {
      setCatalogPage(1); // useEffect ниже подхватит загрузку с новым запросом
    } else {
      catalogTimer.current = setTimeout(() => loadCatalog(v, catalogCategory, 1), 350);
    }
  };

  const loadCatalog = useCallback(async (q: string, cat: string, pg: number) => {
    setCatalogLoading(true);
    try {
      const off = (pg - 1) * catalogPerPage;
      const d = await fetchJson<{ success: boolean; items: Item[]; total: number; categories: { category: string; count: number }[] }>(
        `/api/items?q=${encodeURIComponent(q)}&category=${encodeURIComponent(cat)}&limit=${catalogPerPage}&offset=${off}`
      );
      setCatalogItems(d.items || []);
      setCatalogTotal(d.total || 0);
      if (d.categories?.length) setCategories(d.categories);
    } catch {
      setCatalogItems([]);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  // Первичная загрузка
  useEffect(() => {
    if (selectedItem?.id && region) {
      setPage(1);
      setHistoryPage(1);
      setHistoryLoaded(false);
      fetchLots(selectedItem.id, region);
      fetchHistory(selectedItem.id, region);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItem?.id, region]);

  // Тикающие часы для живого счётчика в футере ("обновление через Xс")
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    loadTrackers();
    loadNotifications();
    loadCatalog("", "all", 1);
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view === "catalog") loadCatalog(catalogQuery, catalogCategory, catalogPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, catalogCategory, catalogPage]);

  // Авторефреш лотов: тикает каждые 30 сек, пока вкладка открыта и видна.
  // Пока вкладка свёрнута — обновление ставится на паузу (экономим запросы),
  // а как только пользователь возвращается — сайт сразу подтягивает свежие данные.
  useEffect(() => {
    if (!autoRefresh || view !== "auction" || !selectedItem?.id) {
      setNextRefreshAt(null);
      return;
    }
    let cancelled = false;
    const itemId = selectedItem.id;
    const doRefresh = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      await fetchLots(itemId, region);
      if (historyLoaded) await fetchHistory(itemId, region);
      if (!cancelled) setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
    };
    setNextRefreshAt(Date.now() + AUTO_REFRESH_MS);
    const t = setInterval(doRefresh, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) doRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefresh, view, selectedItem?.id, region, historyLoaded, fetchLots, fetchHistory]);

  // ---------- Поиск ----------
  const doSearch = useCallback(async (q: string) => {
    setSearchLoading(true);
    try {
      const d = await fetchJson<{ success: boolean; items: Item[]; total: number }>(
        `/api/items?q=${encodeURIComponent(q)}&limit=12`
      );
      setSearchResults(d.items || []);
      setSearchTotal(d.total || 0);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const onSearchInput = (v: string) => {
    setSearchQuery(v);
    setShowDropdown(true);
    setActiveIdx(-1);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(v), 250);
  };

  const selectItem = (item: Item) => {
    setSelectedItem(item);
    setSearchQuery(itemName(item));
    setShowDropdown(false);
    setFilterUpgrade(null);
    setFilterQuality(null);
    setMaxPriceFilter("");
    setPage(1);
    setHistoryPage(1);
    setView("auction");
    try {
      localStorage.setItem("staltrack_item", JSON.stringify(item));
      const url = new URL(window.location.href);
      url.searchParams.set("item", item.id);
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (!showDropdown || searchResults.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, searchResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); selectItem(searchResults[activeIdx]); }
  };

  // ---------- Проверка трекеров ----------
  const checkTrackers = useCallback(async (silent = false) => {
    if (checking) return;
    setChecking(true);
    try {
      const d = await fetchJson<{
        success: boolean; checked: number; totalMatches: number; initialized: number; telegramSent: number;
        matches: { trackerId: number; itemId: string; itemName: string; itemIcon: string | null; price: number; upgrade: number; quality: number; qualityName: string; region: string }[];
      }>("/api/trackers/check", { method: "POST" });
      setLastCheck(new Date());
      loadTrackers();
      loadNotifications();
      if (d.matches?.length > 0) {
        for (const m of d.matches.slice(0, 5)) {
          const tr = trackers.find((t) => t.id === m.trackerId);
          pushToast(
            `🎯 ${m.itemName}`,
            `+${m.upgrade} • ${m.qualityName} • ${formatPrice(m.price)} ₽ (${m.region})`,
            m.itemIcon
          );
          if (soundOn && (tr?.enableSound ?? true)) playNotifySound();
          if ((tr?.enableBrowser ?? true) && typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(`🎯 ${m.itemName}`, {
                body: `+${m.upgrade} • ${m.qualityName} • ${formatPrice(m.price)} ₽`,
                icon: m.itemIcon || undefined,
              });
            } catch { /* ignore */ }
          }
        }
        // если совпавший предмет открыт — обновить лоты
        if (selectedItem && d.matches.some((m) => m.itemId === selectedItem.id && m.region === region)) {
          fetchLots(selectedItem.id, region);
        }
      }
      if ((d.initialized || 0) > 0) {
        pushToast("Трекеры инициализированы", `Сейчас подходит лотов: ${d.totalMatches || 0}. Уведомления будут приходить только по новым лотам.`);
      } else if (!silent && (d.matches?.length || 0) === 0) {
        pushToast("Проверка завершена", `Проверено трекеров: ${d.checked}, новых совпадений нет.`);
      }
    } catch {
      if (!silent) pushToast("Ошибка проверки", "Не удалось проверить трекеры.");
    } finally {
      setChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking, trackers, soundOn, selectedItem?.id, region]);

  useEffect(() => {
    if (trackers.filter((t) => t.enabled).length === 0) return;
    const t = setInterval(() => {
      // В свёрнутой вкладке не дёргаем API — фоновый планировщик сервера
      // и так продолжает проверять трекеры и слать уведомления в Telegram.
      if (typeof document !== "undefined" && document.hidden) return;
      checkTrackers(true);
    }, checkInterval * 1000);
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) checkTrackers(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkInterval, trackers.length]);

  const requestNotifPermission = async () => {
    if (typeof Notification === "undefined") {
      pushToast("Не поддерживается", "Ваш браузер не поддерживает уведомления.");
      return;
    }
    const p = await Notification.requestPermission();
    setNotifPermission(p);
    if (p === "granted") pushToast("Уведомления включены", "Теперь вы будете получать пуши о найденных лотах.");
    else pushToast("Уведомления отклонены", "Разрешите уведомления в настройках браузера.");
  };

  // ---------- Tracker CRUD ----------
  const saveTracker = async () => {
    if (!selectedItem) return;
    try {
      await fetchJson("/api/trackers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: selectedItem.id,
          itemName: itemName(selectedItem),
          itemIcon: itemIcon(selectedItem),
          region,
          ...trackerForm,
          notifyChatIds: tgSelected || [],
        }),
      });
      setShowTrackerModal(false);
      loadTrackers();
      pushToast("Трекер создан", `${itemName(selectedItem)} — слежка запущена.`);
      setTrackerForm({ upgradeMode: "exact", targetUpgrade: 0, targetQuality: -1, maxPrice: 0, minPrice: 0, enableSound: true, enableBrowser: true });
      setTgSelected(null);
    } catch {
      pushToast("Ошибка", "Не удалось создать трекер.");
    }
  };

  const deleteTracker = async (id: number) => {
    try {
      await fetch(`/api/trackers/${id}`, { method: "DELETE" });
      loadTrackers();
    } catch { /* ignore */ }
  };

  const toggleTracker = async (t: Tracker) => {
    try {
      await fetch(`/api/trackers/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      loadTrackers();
    } catch { /* ignore */ }
  };

  // ---------- Derived ----------
  const stats = useMemo(() => {
    const prices = lots.map((l) => l.buyoutPrice || l.startPrice).filter((p) => p > 0);
    if (!prices.length) return { min: 0, max: 0, avg: 0 };
    return {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    };
  }, [lots]);

  const histStats = useMemo(() => {
    const prices = history.map((h) => h.price).filter((p) => p > 0);
    const last = history.find((h) => h.price > 0)?.price || 0;
    if (!prices.length) return { last, min: 0, max: 0, avg: 0, count: history.length, change: 0 };
    const now = Date.now();
    const last24 = history.filter((h) => h.time && now - new Date(h.time).getTime() < 86400000).map((h) => h.price).filter((p) => p > 0);
    const prev24 = history.filter((h) => {
      if (!h.time) return false;
      const d = now - new Date(h.time).getTime();
      return d >= 86400000 && d < 172800000;
    }).map((h) => h.price).filter((p) => p > 0);
    const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const a24 = avg(last24), ap = avg(prev24);
    const change = ap > 0 ? ((a24 - ap) / ap) * 100 : 0;
    return {
      last,
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(avg(prices)),
      count: history.length,
      change: Math.round(change * 10) / 10,
    };
  }, [history]);

  const chartData = useMemo(() => {
    const now = Date.now();
    const ms = timeframe === "24h" ? 86400000 : timeframe === "7d" ? 7 * 86400000 : timeframe === "30d" ? 30 * 86400000 : Infinity;
    return history
      .filter((h) => h.price > 0 && (!h.time || now - new Date(h.time).getTime() < ms))
      .map((h) => ({ time: h.time, price: h.price }))
      .sort((a, b) => (a.time ? new Date(a.time).getTime() : 0) - (b.time ? new Date(b.time).getTime() : 0));
  }, [history, timeframe]);

  const processedLots = useMemo(() => {
    let r = [...lots];
    if (filterUpgrade !== null) r = r.filter((l) => l.upgrade === filterUpgrade);
    if (filterQuality !== null) r = r.filter((l) => l.quality === filterQuality);
    const mp = Number(maxPriceFilter);
    if (maxPriceFilter && Number.isFinite(mp) && mp > 0) {
      r = r.filter((l) => (l.buyoutPrice || l.startPrice) <= mp);
    }
    r.sort((a, b) => {
      const pa = a.buyoutPrice || a.startPrice || Infinity;
      const pb = b.buyoutPrice || b.startPrice || Infinity;
      if (sortOrder === "price_asc") return pa - pb;
      if (sortOrder === "price_desc") return pb - pa;
      if (sortOrder === "upgrade_desc") return b.upgrade - a.upgrade || pa - pb;
      if (sortOrder === "time_asc") {
        const ta = a.endTime ? new Date(a.endTime).getTime() : Infinity;
        const tb = b.endTime ? new Date(b.endTime).getTime() : Infinity;
        return ta - tb;
      }
      return pa - pb;
    });
    return r;
  }, [lots, filterUpgrade, filterQuality, maxPriceFilter, sortOrder]);

  const totalPages = Math.max(1, Math.ceil(processedLots.length / perPage));
  const paginatedLots = processedLots.slice((page - 1) * perPage, page * perPage);
  const totalHistoryPages = Math.max(1, Math.ceil(history.length / perPage));
  const paginatedHistory = history.slice((historyPage - 1) * perPage, historyPage * perPage);
  const catalogTotalPages = Math.max(1, Math.ceil(catalogTotal / catalogPerPage));
  const enabledTrackers = trackers.filter((t) => t.enabled);

  const changeBadge = histStats.change === 0
    ? { icon: Minus, cls: "text-zinc-400 bg-zinc-800", txt: "N/A" }
    : histStats.change > 0
      ? { icon: TrendingUp, cls: "text-emerald-400 bg-emerald-500/10", txt: `+${histStats.change}%` }
      : { icon: TrendingDown, cls: "text-red-400 bg-red-500/10", txt: `${histStats.change}%` };

  const regionLabel = REGIONS.find((r) => r.id === region)?.label || region;

  // Живой обратный отсчёт для футера: приоритет — обновление лотов на
  // открытой странице аукциона, иначе — ближайшая фоновая проверка сервера.
  const footerCountdown = useMemo(() => {
    if (nextRefreshAt) {
      const secs = Math.max(0, Math.round((nextRefreshAt - nowTick) / 1000));
      return { label: "Обновление аукциона через", secs };
    }
    if (scheduler?.enabled && scheduler.nextRunAt) {
      const secs = Math.max(0, Math.round((new Date(scheduler.nextRunAt).getTime() - nowTick) / 1000));
      return { label: "Следующая фоновая проверка через", secs };
    }
    return null;
  }, [nextRefreshAt, nowTick, scheduler]);

  // ================= RENDER =================
  return (
    <div className="min-h-screen bg-[#060607]">
      {/* ===== Фоновые свечения ===== */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-48 left-1/2 h-[420px] w-[920px] -translate-x-1/2 rounded-full bg-[#d4ff3f]/[0.05] blur-[130px]" />
        <div className="absolute -left-48 top-1/3 h-96 w-96 rounded-full bg-violet-600/[0.07] blur-[110px]" />
        <div className="absolute -right-48 top-2/3 h-96 w-96 rounded-full bg-sky-500/[0.06] blur-[110px]" />
      </div>
      {/* ===== Navbar ===== */}
      <header className="sticky top-0 z-50 border-b border-zinc-800/80 bg-[#0a0a0c]/90 shadow-[0_8px_30px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-4">
          <button onClick={() => setView("auction")} className="group flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-[#e4ff70] to-[#a3cc00] text-black shadow-[0_0_18px_rgba(212,255,63,0.35)] transition group-hover:shadow-[0_0_26px_rgba(212,255,63,0.55)]">
              <Star className="h-4 w-4" fill="currentColor" />
            </span>
            <span className="text-[15px] font-extrabold tracking-wide text-white">AucTracker</span>
          </button>

          <nav className="ml-6 hidden items-center gap-1 md:flex">
            <button onClick={() => setView("auction")} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${view === "auction" ? "bg-zinc-800 text-white shadow-inner" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white"}`}>
              <Gavel className="h-3.5 w-3.5 shrink-0" />Аукцион
            </button>
            <button onClick={() => setView("catalog")} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${view === "catalog" ? "bg-zinc-800 text-white shadow-inner" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white"}`}>
              <Package className="h-3.5 w-3.5 shrink-0" />Предметы
            </button>
            <button onClick={() => setView("trackers")} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${view === "trackers" ? "bg-zinc-800 text-white shadow-inner" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white"}`}>
              <Crosshair className="h-3.5 w-3.5 shrink-0" />Трекеры
              {trackers.length > 0 && (
                <span className="rounded-full bg-[#d4ff3f] px-1.5 py-0.5 text-[10px] font-bold leading-none text-black">{trackers.length}</span>
              )}
            </button>
            <button onClick={() => setView("settings")} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${view === "settings" ? "bg-zinc-800 text-white shadow-inner" : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white"}`}>
              <SettingsIcon className="h-3.5 w-3.5 shrink-0" />Настройки
            </button>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {/* регион */}
            <div className="relative">
              <button
                onClick={() => setRegionOpen((v) => !v)}
                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-[13px] font-medium text-zinc-200 hover:border-zinc-700"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400 live-dot" />
                {regionLabel}
                <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
              </button>
              {regionOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-zinc-800 bg-[#121214] shadow-2xl anim-fade-up">
                  {REGIONS.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => {
                        setRegion(r.id);
                        try { localStorage.setItem("staltrack_region", r.id); } catch { /* ignore */ }
                        setRegionOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-zinc-800 ${region === r.id ? "text-[#d4ff3f]" : "text-zinc-300"}`}
                    >
                      <span>{r.flag}</span> {r.label}
                      {region === r.id && <Check className="ml-auto h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={() => { setSoundOn((v) => { try { localStorage.setItem("staltrack_sound", !v ? "1" : "0"); } catch { /* ignore */ } return !v; }); }}
              title={soundOn ? "Выключить звук" : "Включить звук"}
              className="hidden rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-400 hover:text-white sm:block"
            >
              {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </button>

            <button
              onClick={() => { setShowNotifs(true); }}
              className="relative rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300 hover:text-white"
              title="Уведомления"
            >
              <Bell className="h-4 w-4" />
              {unread > 0 && (
                <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>

            <button
              onClick={() => setMobileMenu((v) => !v)}
              className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2 text-zinc-300 md:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>
        </div>
        {mobileMenu && (
          <nav className="grid grid-cols-2 gap-2 border-t border-zinc-800 px-4 py-2 md:hidden">
            {([
              { v: "auction", t: "Аукцион" },
              { v: "catalog", t: "Предметы" },
              { v: "trackers", t: `Трекеры (${trackers.length})` },
              { v: "settings", t: "Настройки" },
            ] as const).map((item) => (
              <button
                key={item.v}
                onClick={() => { setView(item.v); setMobileMenu(false); }}
                className={`rounded-lg px-3 py-2 text-[13px] font-medium ${view === item.v ? "bg-zinc-800 text-white" : "text-zinc-400"}`}
              >
                {item.t}
              </button>
            ))}
          </nav>
        )}
      </header>

      <main className="relative mx-auto max-w-[1280px] px-4 pb-24 pt-5">
        {/* ===== Поиск ===== */}
        <div ref={searchRef} className="relative z-30 mx-auto max-w-3xl">
          <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500">
            <Search className="h-4 w-4" />
          </div>
          <input
            value={searchQuery}
            onChange={(e) => onSearchInput(e.target.value)}
            onFocus={() => { setShowDropdown(true); if (searchResults.length === 0) doSearch(searchQuery); }}
            onKeyDown={onSearchKey}
            placeholder="Быстрый поиск предмета… (название, ID или категория)"
            className="w-full rounded-xl border border-zinc-800 bg-[#121214] py-3 pl-11 pr-12 text-[14px] text-white placeholder-zinc-500 outline-none transition focus:border-[#d4ff3f]/60 focus:ring-2 focus:ring-[#d4ff3f]/10"
          />
          {searchLoading && (
            <div className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-zinc-700 border-t-[#d4ff3f]" />
          )}
          {showDropdown && searchResults.length > 0 && (
            <ul className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[340px] overflow-y-auto rounded-xl border border-zinc-800 bg-[#121214] shadow-2xl anim-fade-up">
              {searchResults.map((item, i) => (
                <li key={item.id}>
                  <button
                    onClick={() => selectItem(item)}
                    onMouseEnter={() => setActiveIdx(i)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${i === activeIdx ? "bg-zinc-800" : "hover:bg-zinc-800/60"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={itemIcon(item)}
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }}
                      className="h-8 w-8 rounded-md border border-zinc-800 bg-zinc-900 object-contain p-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-zinc-100">{itemName(item)}</span>
                      <span className="block text-[11px] text-zinc-500">{categoryLabel(item.category || "")}</span>
                    </span>
                    <span className="mono rounded bg-zinc-800/80 px-1.5 py-0.5 text-[11px] text-zinc-400">{item.id}</span>
                  </button>
                </li>
              ))}
              {searchTotal > searchResults.length && (
                <li className="border-t border-zinc-800 px-3 py-2 text-center text-[12px] text-zinc-500">
                  Показано {searchResults.length} из {searchTotal} — уточните запрос
                </li>
              )}
            </ul>
          )}
        </div>

        {view === "auction" && (
          <div className="anim-fade-up">
            {/* ===== Хлебные крошки ===== */}
            <div className="mt-5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-zinc-500">
              <button onClick={() => setView("catalog")} className="hover:text-zinc-200">Аукцион</button>
              <span>›</span>
              <span>{categoryLabel(selectedItem?.category || "")}</span>
              <span>›</span>
              <span className="text-zinc-300">{itemName(selectedItem)}</span>
              <span className="ml-auto flex items-center gap-2">
                {lastUpdate && <span className="text-[11px]">обновлено {timeAgo(lastUpdate)}</span>}
                <button
                  onClick={() => { if (selectedItem) { fetchLots(selectedItem.id, region); fetchHistory(selectedItem.id, region); } }}
                  className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-[12px] text-zinc-300 hover:border-zinc-700"
                >
                  <RefreshCw className={`h-3 w-3 ${lotsLoading ? "animate-spin" : ""}`} /> Обновить
                </button>
              </span>
            </div>

            <h1 className="mt-2 flex items-center gap-2 text-xl font-bold text-white sm:text-2xl">
              <button onClick={() => setView("catalog")} className="text-zinc-500 hover:text-white">
                <ChevronLeft className="h-6 w-6" />
              </button>
              {itemName(selectedItem)}
            </h1>
            <p className="mt-0.5 text-[13px] text-zinc-500">Мониторинг цен, активные лоты и история продаж.</p>

            {/* ===== Карточка предмета ===== */}
            <div className="mt-4 flex items-center gap-4 rounded-2xl border border-zinc-800/80 bg-[#101013] p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={itemIcon(selectedItem)}
                alt={itemName(selectedItem)}
                onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }}
                className="h-16 w-16 rounded-xl border border-zinc-800 bg-zinc-900 object-contain p-1.5"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[15px] font-bold text-red-400">{itemName(selectedItem)}</span>
                  <span className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                    {categoryLabel(selectedItem?.category || "")}
                  </span>
                </div>
                <div className="mono mt-1 text-[12px] text-zinc-500">ID: {selectedItem?.id}</div>
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                <span className="flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-[12px] text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" /> {region} · {lotsTotal} лотов
                </span>
                <button
                  onClick={() => setShowTrackerModal(true)}
                  className="flex items-center gap-1.5 rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black transition hover:brightness-110"
                >
                  <Crosshair className="h-4 w-4" /> Следить
                </button>
              </div>
            </div>
            <button
              onClick={() => setShowTrackerModal(true)}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl bg-[#d4ff3f] px-4 py-2.5 text-[13px] font-bold text-black sm:hidden"
            >
              <Crosshair className="h-4 w-4" /> Следить за предметом
            </button>

            {apiError && (
              <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200">
                ⚠️ {apiError}
              </div>
            )}

            {!lotsLoading && !apiError && lotsTotal === 0 && (
              <div className="mt-4 flex items-start gap-3 rounded-2xl border border-zinc-800 bg-[#101013] p-4 anim-fade-up">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-zinc-800/70 text-zinc-400">
                  <Info className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-white">На аукционе сейчас нет лотов</p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-zinc-500">
                    Возможно, этот предмет нельзя выставить на продажу, либо все лоты раскупили.
                    Попробуйте другой регион — или создайте трекер, и мы сообщим, когда лот появится.
                  </p>
                </div>
              </div>
            )}

            {/* ===== Статистика ===== */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { label: "Последняя за шт.", value: histStats.last, cls: "text-white", icon: HistoryIcon },
                { label: "Средняя за шт.", value: histStats.avg, cls: "text-sky-400", icon: BarChart3 },
                { label: "Минимум за шт.", value: stats.min || histStats.min, cls: "text-emerald-400", icon: ArrowDown },
                { label: "Максимум за шт.", value: stats.max || histStats.max, cls: "text-red-400", icon: ArrowUp },
                { label: "Продаж", value: histStats.count, cls: "text-white", raw: true, icon: ShoppingBag },
              ].map((s: { label: string; value: number; cls: string; raw?: boolean; icon: LucideIcon }) => (
                <div key={s.label} className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-4 text-center transition hover:border-zinc-700">
                  <s.icon className="mx-auto h-4 w-4 text-zinc-600" />
                  <div className="mt-1.5 text-[11.5px] text-zinc-500">{s.label}</div>
                  <div className={`mono mt-1 text-[17px] font-bold ${s.cls}`}>
                    {historyLoading ? <span className="skeleton inline-block h-5 w-20 rounded" /> : s.raw ? s.value : s.value > 0 ? formatPrice(s.value) : <span className="text-zinc-600">—</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* ===== График ===== */}
            <div className="mt-4 rounded-2xl border border-zinc-800/80 bg-[#101013] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <HistoryIcon className="h-4 w-4 text-zinc-500" />
                <span className="text-[13.5px] font-semibold text-zinc-200">История покупок</span>
                <span className="mono text-[13px] font-bold text-white">{formatPrice(histStats.last)} ₽</span>
                <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${changeBadge.cls}`}>
                  <changeBadge.icon className="h-3 w-3" /> {changeBadge.txt}
                </span>
                <span className="text-[11px] text-zinc-600">за 24ч</span>
                <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
                  {(["24h", "7d", "30d", "all"] as const).map((tf) => (
                    <button
                      key={tf}
                      onClick={() => setTimeframe(tf)}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium ${timeframe === tf ? "bg-zinc-700 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      {tf === "24h" ? "24ч" : tf === "7d" ? "7д" : tf === "30d" ? "30д" : "Всё"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3">
                {historyLoading ? (
                  <div className="skeleton h-[240px] rounded-xl" />
                ) : (
                  <PriceChart data={chartData} referenceMax={stats.max} />
                )}
              </div>
            </div>

            {/* ===== Вкладки ===== */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <div className="flex gap-1 rounded-xl border border-zinc-800 bg-[#101013] p-1">
                <button
                  onClick={() => setActiveTab("lots")}
                  className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold transition ${activeTab === "lots" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  <Gavel className="h-3.5 w-3.5" /> Активные лоты ({processedLots.length})
                </button>
                <button
                  onClick={() => { setActiveTab("history"); if (!historyLoaded) selectedItem && fetchHistory(selectedItem.id, region); }}
                  className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold transition ${activeTab === "history" ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  <HistoryIcon className="h-3.5 w-3.5" /> История продаж
                </button>
              </div>
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-[12px] text-zinc-500">
                <button
                  onClick={() => setAutoRefresh((v) => !v)}
                  className={`relative h-5 w-9 rounded-full transition ${autoRefresh ? "bg-[#d4ff3f]" : "bg-zinc-700"}`}
                >
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${autoRefresh ? "left-[18px]" : "left-0.5"}`} />
                </button>
                Автообновление 60с
              </label>
            </div>

            {/* ===== Фильтры ===== */}
            {activeTab === "lots" && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-800/80 bg-[#101013] p-3">
                <div className="flex overflow-hidden rounded-lg border border-zinc-800">
                  {UPGRADE_CHIPS.map((u) => (
                    <button
                      key={u === null ? "all" : u}
                      onClick={() => { setFilterUpgrade(u); setPage(1); }}
                      className={`border-r border-zinc-800 px-2.5 py-1.5 text-[12px] font-medium last:border-0 ${filterUpgrade === u ? "bg-zinc-700 text-white" : "bg-transparent text-zinc-500 hover:text-zinc-200"}`}
                    >
                      {u === null ? "Все" : `+${u}`}
                    </button>
                  ))}
                </div>
                <select
                  value={filterQuality === null ? "" : filterQuality}
                  onChange={(e) => { setFilterQuality(e.target.value === "" ? null : Number(e.target.value)); setPage(1); }}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none"
                >
                  <option value="">● Все редкости</option>
                  {[0, 1, 2, 3, 4, 5].map((q) => (
                    <option key={q} value={q}>{QUALITY_NAMES[q]}</option>
                  ))}
                </select>
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none"
                >
                  <option value="price_asc">Дешевле ↑</option>
                  <option value="price_desc">Дороже ↓</option>
                  <option value="upgrade_desc">Заточка ↓</option>
                  <option value="time_asc">Скоро конец</option>
                </select>
                <input
                  value={maxPriceFilter}
                  onChange={(e) => { setMaxPriceFilter(e.target.value.replace(/\D/g, "")); setPage(1); }}
                  placeholder="Макс. цена…"
                  inputMode="numeric"
                  className="w-32 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12px] text-zinc-200 outline-none placeholder-zinc-600"
                />
                {(filterUpgrade !== null || filterQuality !== null || maxPriceFilter) && (
                  <button
                    onClick={() => { setFilterUpgrade(null); setFilterQuality(null); setMaxPriceFilter(""); setPage(1); }}
                    className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-zinc-500 hover:text-white"
                  >
                    <X className="h-3.5 w-3.5" /> Сбросить
                  </button>
                )}
              </div>
            )}

            {/* ===== Таблицы ===== */}
            <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-800/80 bg-[#101013]">
              {activeTab === "lots" ? (
                lotsLoading ? (
                  <div className="space-y-2 p-4">
                    {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-lg" />)}
                  </div>
                ) : paginatedLots.length === 0 ? (
                  <div className="px-4 py-12 text-center">
                    <Gavel className="mx-auto h-8 w-8 text-zinc-700" />
                    <p className="mt-2 text-[14px] font-medium text-zinc-400">Лоты не найдены</p>
                    <p className="mt-1 text-[12px] text-zinc-600">Попробуйте другой регион или сбросьте фильтры</p>
                  </div>
                ) : (
                  <>
                    <div className="hidden grid-cols-[1.4fr_1fr_0.7fr_1fr] gap-2 border-b border-zinc-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 md:grid">
                      <span>Цена выкупа</span><span>Редкость</span><span>Заточка</span><span>Осталось</span>
                    </div>
                    {paginatedLots.map((lot) => (
                      <div key={lot.id} className="grid grid-cols-2 gap-2 border-b border-zinc-800/50 px-4 py-3 transition last:border-0 hover:bg-zinc-900/40 md:grid-cols-[1.4fr_1fr_0.7fr_1fr]">
                        <div>
                          <div className="mono text-[14px] font-bold text-white">{formatPrice(lot.buyoutPrice || lot.startPrice)} ₽</div>
                          {lot.amount > 1 && <div className="text-[11px] text-zinc-500">×{lot.amount} · {formatPrice(lot.pricePerUnit || 0)} ₽/шт</div>}
                        </div>
                        <div className="flex items-center">
                          <span
                            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px] font-medium"
                            style={{ borderColor: `${QUALITY_COLORS[lot.quality]}55`, color: QUALITY_COLORS[lot.quality], background: `${QUALITY_COLORS[lot.quality]}11` }}
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: QUALITY_COLORS[lot.quality] }} />
                            {lot.qualityName}
                          </span>
                        </div>
                        <div className="flex items-center">
                          <span className={`mono text-[13px] font-bold ${lot.upgrade > 0 ? "text-emerald-400" : "text-zinc-600"}`}>
                            {lot.upgrade > 0 ? `+${lot.upgrade}` : "—"}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[12px] text-zinc-400">
                          <Clock className="h-3.5 w-3.5 text-zinc-600" /> {getTimeLeft(lot.endTime)}
                        </div>
                      </div>
                    ))}
                  </>
                )
              ) : historyLoading && !historyLoaded ? (
                <div className="space-y-2 p-4">
                  {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-lg" />)}
                </div>
              ) : paginatedHistory.length === 0 ? (
                <div className="px-4 py-12 text-center">
                  <HistoryIcon className="mx-auto h-8 w-8 text-zinc-700" />
                  <p className="mt-2 text-[14px] font-medium text-zinc-400">История отсутствует</p>
                  <p className="mt-1 text-[12px] text-zinc-600">По этому предмету пока не было продаж в регионе {region}</p>
                </div>
              ) : (
                <>
                  <div className="hidden grid-cols-[1.4fr_1fr_0.7fr_1fr] gap-2 border-b border-zinc-800 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 md:grid">
                    <span>Цена продажи</span><span>Редкость</span><span>Заточка</span><span>Дата</span>
                  </div>
                  {paginatedHistory.map((h) => (
                    <div key={h.id} className="grid grid-cols-2 gap-2 border-b border-zinc-800/50 px-4 py-3 transition last:border-0 hover:bg-zinc-900/40 md:grid-cols-[1.4fr_1fr_0.7fr_1fr]">
                      <div className="mono text-[14px] font-bold text-white">{formatPrice(h.price)} ₽</div>
                      <div className="flex items-center">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px] font-medium"
                          style={{ borderColor: `${QUALITY_COLORS[h.quality]}55`, color: QUALITY_COLORS[h.quality], background: `${QUALITY_COLORS[h.quality]}11` }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ background: QUALITY_COLORS[h.quality] }} />
                          {h.qualityName}
                        </span>
                      </div>
                      <div className="flex items-center">
                        <span className={`mono text-[13px] font-bold ${h.upgrade > 0 ? "text-emerald-400" : "text-zinc-600"}`}>
                          {h.upgrade > 0 ? `+${h.upgrade}` : "—"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[12px] text-zinc-400">📅 {formatDate(h.time)}</div>
                    </div>
                  ))}
                </>
              )}

              {/* Пагинация */}
              {((activeTab === "lots" && totalPages > 1) || (activeTab === "history" && totalHistoryPages > 1)) && (
                <div className="flex items-center justify-center gap-3 border-t border-zinc-800 px-4 py-3 text-[12.5px] text-zinc-400">
                  <button
                    disabled={activeTab === "lots" ? page === 1 : historyPage === 1}
                    onClick={() => activeTab === "lots" ? setPage((p) => Math.max(1, p - 1)) : setHistoryPage((p) => Math.max(1, p - 1))}
                    className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Назад
                  </button>
                  <span>Страница {activeTab === "lots" ? page : historyPage} из {activeTab === "lots" ? totalPages : totalHistoryPages}</span>
                  <button
                    disabled={activeTab === "lots" ? page === totalPages : historyPage === totalHistoryPages}
                    onClick={() => activeTab === "lots" ? setPage((p) => Math.min(totalPages, p + 1)) : setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))}
                    className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                  >
                    Вперёд <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Подсказка про уведомления */}
            {notifPermission !== "granted" && (
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-[#d4ff3f]/20 bg-[#d4ff3f]/5 p-4">
                <BellRing className="h-5 w-5 shrink-0 text-[#d4ff3f]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-white">Включите браузерные уведомления</p>
                  <p className="text-[12px] text-zinc-400">Чтобы получать пуши о лотах, даже когда вкладка неактивна.</p>
                </div>
                <button onClick={requestNotifPermission} className="rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black hover:brightness-110">
                  Включить
                </button>
              </div>
            )}
          </div>
        )}

        {view === "catalog" && (
          <div className="mt-5 anim-fade-up">
            <h1 className="text-xl font-bold text-white">Каталог предметов</h1>
            <p className="mt-0.5 text-[13px] text-zinc-500">
              {catalogTotal.toLocaleString("ru-RU")} предметов из базы STALCRAFT · нажмите на предмет, чтобы открыть аукцион
            </p>

            <div className="mt-4 flex flex-col gap-4 lg:flex-row">
              {/* Категории */}
              <aside className="w-full shrink-0 lg:w-60">
                <div className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-2">
                  <button
                    onClick={() => { setCatalogCategory("all"); setCatalogPage(1); }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] font-medium ${catalogCategory === "all" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"}`}
                  >
                    <span className="flex items-center gap-2"><Database className="h-3.5 w-3.5" /> Все предметы</span>
                  </button>
                  {categories.map((c) => (
                    <button
                      key={c.category}
                      onClick={() => { setCatalogCategory(c.category); setCatalogPage(1); }}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] ${catalogCategory === c.category ? "bg-zinc-800 text-white" : "text-zinc-400 hover:bg-zinc-800/50"}`}
                    >
                      <span className="flex items-center gap-2">
                        {c.category === "weapon" ? <Swords className="h-3.5 w-3.5" /> : c.category === "armour" ? <Shield className="h-3.5 w-3.5" /> : c.category === "artefact" ? <Zap className="h-3.5 w-3.5" /> : c.category === "supply" || c.category === "medicine" ? <FlaskConical className="h-3.5 w-3.5" /> : c.category === "backpack" ? <Backpack className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                        {categoryLabel(c.category)}
                      </span>
                      <span className="text-[11px] text-zinc-600">{c.count}</span>
                    </button>
                  ))}
                </div>
              </aside>

              {/* Сетка */}
              <div className="min-w-0 flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                  <input
                    value={catalogQuery}
                    onChange={(e) => onCatalogQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { if (catalogTimer.current) clearTimeout(catalogTimer.current); setCatalogPage(1); loadCatalog(catalogQuery, catalogCategory, 1); } }}
                    placeholder="Поиск по каталогу… — находится сразу при вводе"
                    className="w-full rounded-xl border border-zinc-800 bg-[#121214] py-2.5 pl-10 pr-10 text-[13px] text-white outline-none placeholder-zinc-600 focus:border-zinc-600"
                  />
                  {catalogLoading ? (
                    <div className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-zinc-700 border-t-[#d4ff3f]" />
                  ) : catalogQuery ? (
                    <button
                      onClick={() => onCatalogQuery("")}
                      title="Очистить"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>

                {catalogLoading ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                    {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
                  </div>
                ) : catalogItems.length === 0 ? (
                  <div className="mt-3 rounded-2xl border border-zinc-800 bg-[#101013] p-10 text-center text-[13px] text-zinc-500">
                    Ничего не найдено. Попробуйте другой запрос.
                  </div>
                ) : (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                      {catalogItems.map((it) => (
                        <button
                          key={it.id}
                          onClick={() => selectItem(it)}
                          className="group flex items-center gap-2.5 rounded-xl border border-zinc-800/80 bg-[#101013] p-2.5 text-left transition hover:border-[#d4ff3f]/40 hover:bg-zinc-900"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={itemIcon(it)}
                            alt=""
                            loading="lazy"
                            onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }}
                            className="h-10 w-10 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 object-contain p-1"
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-[12.5px] font-medium text-zinc-100 group-hover:text-white">{itemName(it)}</span>
                            <span className="mono text-[11px] text-zinc-500">{it.id}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {catalogTotalPages > 1 && (
                      <div className="mt-4 flex items-center justify-center gap-3 text-[12.5px] text-zinc-400">
                        <button
                          disabled={catalogPage === 1}
                          onClick={() => setCatalogPage((p) => Math.max(1, p - 1))}
                          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                        >
                          ← Назад
                        </button>
                        <span>{catalogPage} / {catalogTotalPages}</span>
                        <button
                          disabled={catalogPage === catalogTotalPages}
                          onClick={() => setCatalogPage((p) => Math.min(catalogTotalPages, p + 1))}
                          className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-zinc-200 disabled:opacity-40"
                        >
                          Вперёд →
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {view === "trackers" && (
          <div className="mt-5 anim-fade-up">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <h1 className="text-xl font-bold text-white">Мои трекеры</h1>
                <p className="mt-0.5 text-[13px] text-zinc-500">
                  Активно: {enabledTrackers.length} из {trackers.length}
                  {lastCheck && ` · последняя проверка ${timeAgo(lastCheck)}`}
                </p>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <select
                  value={checkInterval}
                  onChange={(e) => { const v = Number(e.target.value); setCheckInterval(v); try { localStorage.setItem("staltrack_check_interval", String(v)); } catch { /* ignore */ } }}
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[12.5px] text-zinc-200 outline-none"
                  title="Интервал автопроверки (только пока эта вкладка открыта)"
                >
                  <option value={30}>Каждые 30 сек — часто, только для своей БД</option>
                  <option value={60}>Каждую минуту</option>
                  <option value={120}>Каждые 2 мин — рекомендуется</option>
                  <option value={300}>Каждые 5 мин — экономно</option>
                </select>
                <button
                  onClick={() => checkTrackers(false)}
                  disabled={checking || trackers.length === 0}
                  className="flex items-center gap-1.5 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-[13px] font-semibold text-white hover:bg-zinc-700 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                  {checking ? "Проверка…" : "Проверить сейчас"}
                </button>
                <button
                  onClick={() => setShowTrackerModal(true)}
                  className="flex items-center gap-1.5 rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black hover:brightness-110"
                >
                  <Plus className="h-4 w-4" /> Новый трекер
                </button>
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-600">
              Интервал выше ускоряет проверку только пока эта вкладка открыта в браузере (плюс звук и пуш на
              компьютере). Уведомления в Telegram работают отдельно и постоянно — их частота настраивается в
              разделе «Настройки → Фоновый трекинг».
            </p>

            {notifPermission !== "granted" && (
              <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-[#d4ff3f]/20 bg-[#d4ff3f]/5 p-4">
                <BellRing className="h-5 w-5 text-[#d4ff3f]" />
                <p className="min-w-0 flex-1 text-[13px] text-zinc-300">
                  Разрешите уведомления в браузере, чтобы не пропустить нужный лот.
                </p>
                <button onClick={requestNotifPermission} className="rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black">
                  Разрешить
                </button>
              </div>
            )}

            {trackers.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-dashed border-zinc-800 bg-[#101013] p-12 text-center">
                <Crosshair className="mx-auto h-10 w-10 text-zinc-700" />
                <p className="mt-3 text-[15px] font-semibold text-white">Пока нет ни одного трекера</p>
                <p className="mx-auto mt-1 max-w-md text-[13px] text-zinc-500">
                  Откройте любой предмет на аукционе и нажмите «Следить» — мы будем проверять лоты каждые {checkInterval} сек
                  и присылать уведомление, когда появится заточка, редкость и цена под ваши условия.
                </p>
                <button onClick={() => setView("catalog")} className="mt-4 rounded-xl bg-[#d4ff3f] px-5 py-2.5 text-[13px] font-bold text-black">
                  Выбрать предмет
                </button>
              </div>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {trackers.map((t) => (
                  <div key={t.id} className={`rounded-2xl border p-4 transition ${t.enabled ? "border-zinc-800 bg-[#101013]" : "border-zinc-800/60 bg-[#0c0c0e] opacity-60"}`}>
                    <div className="flex items-start gap-3">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={t.itemIcon || FALLBACK_ICON}
                        alt=""
                        onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }}
                        className="h-11 w-11 rounded-xl border border-zinc-800 bg-zinc-900 object-contain p-1"
                      />
                      <div className="min-w-0 flex-1">
                        <button
                          onClick={() => {
                            fetchJson<{ success: boolean; item: Item }>(`/api/items/${t.itemId}`)
                              .then((d) => { if (d.success) selectItem(d.item); })
                              .catch(() => selectItem({ id: t.itemId, nameRu: t.itemName, iconUrl: t.itemIcon || undefined }));
                          }}
                          className="flex items-center gap-1 truncate text-[14px] font-semibold text-white hover:text-[#d4ff3f]"
                        >
                          {t.itemName} <ExternalLink className="h-3 w-3 shrink-0" />
                        </button>
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{t.region}</span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                            {t.upgradeMode === "any" ? "любая заточка" : t.upgradeMode === "min" ? `от +${t.targetUpgrade}` : `+${t.targetUpgrade}`}
                          </span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                            {t.targetQuality === -1 ? "любая редкость" : QUALITY_NAMES[t.targetQuality]}
                          </span>
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                            {t.maxPrice > 0 ? `до ${formatPrice(t.maxPrice)} ₽` : "любая цена"}
                          </span>
                        </div>
                        <div className="mt-1.5 text-[11px] text-zinc-500">
                          Совпадений: {t.matchCount}
                          {t.lastMatchedAt ? ` · последнее ${timeAgo(t.lastMatchedAt)}` : " · пока тихо"}
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500">
                          <Send className="h-3 w-3 shrink-0 text-sky-500" />
                          {tgChats.filter((c) => c.isActive).length === 0 ? (
                            <span>Telegram не привязан</span>
                          ) : !t.notifyChatIds || t.notifyChatIds.length === 0 ? (
                            <span>TG: всем привязанным</span>
                          ) : (
                            <span className="truncate">TG: {t.notifyChatIds.map((id) => tgChats.find((c) => c.chatId === id)?.name || id).join(", ")}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2 border-t border-zinc-800/60 pt-3">
                      <button
                        onClick={() => toggleTracker(t)}
                        className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${t.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                      >
                        {t.enabled ? <><Eye className="h-3.5 w-3.5" /> Активен</> : <><EyeOff className="h-3.5 w-3.5" /> Пауза</>}
                      </button>
                      <span className="flex items-center gap-1 text-[11px] text-zinc-500" title="Звук">
                        <Volume2 className={`h-3.5 w-3.5 ${t.enableSound ? "text-[#d4ff3f]" : "text-zinc-700"}`} />
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-zinc-500" title="Браузерный пуш">
                        <Bell className={`h-3.5 w-3.5 ${t.enableBrowser ? "text-[#d4ff3f]" : "text-zinc-700"}`} />
                      </span>
                      <button
                        onClick={() => deleteTracker(t.id)}
                        className="flex items-center gap-1 rounded-lg bg-red-500/10 px-3 py-1.5 text-[12.5px] font-medium text-red-400 hover:bg-red-500/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> Удалить
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {view === "settings" && (
          <div className="mt-5 anim-fade-up">
            <h1 className="flex items-center gap-2 text-xl font-bold text-white">
              <SettingsIcon className="h-5 w-5 text-[#d4ff3f]" /> Настройки
            </h1>
            <p className="mt-0.5 text-[13px] text-zinc-500">
              Telegram-уведомления, фоновый трекинг 24/7 и адрес сайта.
            </p>

            <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
              {/* ===== Telegram ===== */}
              <section className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-5">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-4 w-4 text-sky-400" />
                  <h2 className="text-[15px] font-bold text-white">Telegram-уведомления</h2>
                  {settings?.telegram_has_token === "1" ? (
                    <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" /> Бот подключён
                    </span>
                  ) : (
                    <span className="ml-auto rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-400">Не настроено</span>
                  )}
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
                  Настройте один раз — и уведомления будут приходить в Telegram даже с выключенным компьютером
                  и закрытым сайтом. Каждый друг привязывает свой Telegram отдельно, своим личным кодом.
                </p>

                {settings?.telegram_has_token !== "1" ? (
                  <div className="mt-3">
                    <label className="mb-1 block text-[12px] font-medium text-zinc-400">Токен бота (от @BotFather)</label>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={tgTokenInput}
                        onChange={(e) => setTgTokenInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveTgToken(); }}
                        placeholder="123456:ABC-DEF..."
                        className="mono min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[12.5px] text-white outline-none placeholder-zinc-600 focus:border-sky-500/50"
                      />
                      <button
                        onClick={saveTgToken}
                        disabled={tgBusy || !tgTokenInput.trim()}
                        className="shrink-0 rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black hover:brightness-110 disabled:opacity-50"
                      >
                        {tgBusy ? "…" : "Подключить"}
                      </button>
                    </div>
                    <details open className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
                      <summary className="flex items-center gap-1.5 text-[12.5px] font-semibold text-zinc-200">
                        <ChevronDown className="h-3.5 w-3.5" /> Шаг 1. Создайте своего бота (займёт 2 минуты)
                      </summary>
                      <ol className="mt-2.5 list-decimal space-y-2 pl-5 text-[12.5px] leading-relaxed text-zinc-400">
                        <li>
                          В Telegram найдите через поиск аккаунт <b className="text-zinc-200">@BotFather</b>
                          (это официальный бот Telegram для создания ботов) и откройте с ним чат.
                        </li>
                        <li>
                          Отправьте ему команду <code className="mono rounded bg-zinc-800 px-1.5 py-0.5">/newbot</code>
                        </li>
                        <li>
                          Он спросит имя бота — напишите любое, например <span className="text-zinc-300">Мой аукцион</span>.
                          Затем спросит username — он обязательно должен заканчиваться на <code className="mono rounded bg-zinc-800 px-1.5 py-0.5">bot</code>,
                          например <span className="text-zinc-300">my_auction_bot</span>.
                        </li>
                        <li>
                          BotFather пришлёт сообщение с токеном — длинной строкой вида
                          <code className="mono ml-1 rounded bg-zinc-800 px-1.5 py-0.5">7123456789:AAH1a2B3c4D5e6F7g8H9</code>.
                          Скопируйте её целиком.
                        </li>
                        <li>Вставьте скопированный токен в поле выше и нажмите кнопку «Подключить».</li>
                      </ol>
                    </details>
                  </div>
                ) : (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3 py-1.5 text-[13px] font-medium text-sky-300">
                        <Send className="h-3.5 w-3.5" /> @{tgBotUsername || settings?.telegram_bot_username || "bot"}
                      </span>
                      <button
                        onClick={() => saveSettings({ telegram_enabled: settings?.telegram_enabled === "0" ? "1" : "0" }, "Telegram-уведомления обновлены")}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium ${settings?.telegram_enabled !== "0" ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}
                      >
                        {settings?.telegram_enabled !== "0" ? <><Check className="h-3.5 w-3.5" /> Включены</> : <><X className="h-3.5 w-3.5" /> Выключены</>}
                      </button>
                      <button
                        onClick={() => testTg(null)}
                        disabled={tgChats.filter((c) => c.isActive).length === 0}
                        className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-[12.5px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
                      >
                        Тест всем
                      </button>
                    </div>

                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                      <p className="text-[12px] font-semibold text-zinc-200">Шаг 2. Привяжите свой Telegram-аккаунт</p>
                      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[11.5px] leading-relaxed text-zinc-500">
                        <li>Нажмите кнопку «Получить код» ниже — появится код из 6 символов.</li>
                        <li>Нажмите «Открыть бота» (или найдите бота в Telegram по имени вручную).</li>
                        <li>В чате с ботом нажмите кнопку <b className="text-zinc-300">Start</b> — код подставится автоматически.</li>
                        <li>Готово — бот пришлёт подтверждение. Каждый друг повторяет эти же 3 шага под своим кодом.</li>
                      </ol>
                      <p className="mt-1.5 text-[11px] text-zinc-600">Код действует 15 минут. Не открылось автоматически — нажмите «Проверить привязку».</p>
                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <button
                          onClick={genLinkCode}
                          disabled={tgBusy}
                          className="flex items-center gap-1.5 rounded-xl bg-[#d4ff3f] px-4 py-2 text-[12.5px] font-bold text-black hover:brightness-110 disabled:opacity-50"
                        >
                          <KeyRound className="h-3.5 w-3.5" /> {tgBusy ? "…" : "Получить код"}
                        </button>
                        <button
                          onClick={pollTgNow}
                          disabled={tgBusy}
                          className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-[12.5px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
                        >
                          Проверить привязку
                        </button>
                      </div>
                      {linkCode && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-[#d4ff3f]/25 bg-[#d4ff3f]/5 p-3 anim-fade-up">
                          <span className="mono text-xl font-extrabold tracking-[0.2em] text-[#d4ff3f]">{linkCode}</span>
                          <button onClick={() => copyText(linkCode, "Код скопирован")} className="rounded-lg border border-zinc-700 bg-zinc-800 p-1.5 text-zinc-300 hover:text-white" title="Скопировать код">
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                          {linkDeep && (
                            <a href={linkDeep} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg bg-sky-500/15 px-3 py-1.5 text-[12px] font-medium text-sky-300 hover:bg-sky-500/25">
                              <Link2 className="h-3.5 w-3.5" /> Открыть бота
                            </a>
                          )}
                        </div>
                      )}
                    </div>

                    <div>
                      <p className="mb-1.5 text-[12px] font-medium text-zinc-400">
                        Привязанные ({tgChats.filter((c) => c.isActive).length})
                      </p>
                      {tgChats.length === 0 ? (
                        <p className="rounded-xl border border-dashed border-zinc-800 px-3 py-3 text-center text-[12px] text-zinc-600">
                          Пока никого — получите код выше и отправьте его боту
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {tgChats.map((c) => (
                            <div key={c.chatId} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${c.isActive ? "border-zinc-800 bg-zinc-900/40" : "border-zinc-800/60 opacity-50"}`}>
                              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold ${c.isActive ? "bg-sky-500/20 text-sky-300" : "bg-zinc-800 text-zinc-500"}`}>
                                {(c.name || "?").slice(0, 1).toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-medium text-zinc-200">
                                  {c.name || c.chatId} {c.username ? <span className="text-zinc-500">@{c.username}</span> : null}
                                </span>
                                <span className="block text-[10.5px] text-zinc-600">
                                  {c.isActive ? `привязан ${timeAgo(c.linkedAt)}` : "отключён"}
                                </span>
                              </span>
                              {c.isActive && (
                                <>
                                  <button onClick={() => testTg(c.chatId)} className="rounded-lg px-2 py-1 text-[11.5px] text-zinc-400 hover:bg-zinc-800 hover:text-white">
                                    Тест
                                  </button>
                                  <button onClick={() => unlinkTg(c.chatId)} className="rounded-lg p-1.5 text-zinc-500 hover:bg-red-500/10 hover:text-red-400" title="Отвязать">
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <button onClick={deleteTgToken} className="text-[12px] text-zinc-600 hover:text-red-400">
                      Удалить токен бота
                    </button>
                  </div>
                )}
              </section>

              {/* ===== Фоновый трекинг ===== */}
              <section className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-5">
                <div className="flex items-center gap-2">
                  <Server className="h-4 w-4 text-[#d4ff3f]" />
                  <h2 className="text-[15px] font-bold text-white">Фоновый трекинг 24/7</h2>
                  {scheduler?.enabled ? (
                    <span className="ml-auto flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" /> Работает
                    </span>
                  ) : (
                    <span className="ml-auto rounded-full border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-400">Выключен</span>
                  )}
                </div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-500">
                  Пока сервер запущен, он сам, без вашего участия, заходит на аукцион по расписанию, сверяет
                  цены со всеми трекерами и шлёт находки в Telegram. Держать сайт открытым в браузере не нужно.
                </p>
                <p className="mt-1.5 text-[11.5px] text-zinc-600">
                  {scheduler?.lastRun
                    ? `Последняя проверка: ${timeAgo(scheduler.lastRun)}${scheduler.lastSummary ? ` — ${scheduler.lastSummary}` : ""}.`
                    : "Проверок пока не было — первая запустится в течение минуты после запуска сайта."}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => saveSettings({ scheduler_enabled: scheduler?.enabled ? "0" : "1" }, "Фоновый трекинг обновлён")}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${scheduler?.enabled ? "bg-[#d4ff3f]" : "bg-zinc-700"}`}
                    title="Вкл/выкл планировщик"
                  >
                    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${scheduler?.enabled ? "left-[22px]" : "left-0.5"}`} />
                  </button>
                  <span className="text-[12.5px] text-zinc-300">Проверять каждые</span>
                  <select
                    value={settings?.scheduler_interval || "600"}
                    onChange={(e) => saveSettings({ scheduler_interval: e.target.value }, "Интервал обновлён")}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-[12.5px] text-zinc-200 outline-none"
                  >
                    <option value="60">1 мин — только для своей БД (не Neon free)</option>
                    <option value="120">2 мин — не для Neon free</option>
                    <option value="300">5 мин — впритык для Neon free</option>
                    <option value="600">10 мин — рекомендуется для Neon free ✓</option>
                    <option value="900">15 минут — с запасом</option>
                    <option value="1800">30 минут — экономно</option>
                  </select>
                </div>
                <div className="mt-3 rounded-xl border border-sky-500/20 bg-sky-500/[0.04] p-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
                    <Database className="h-3.5 w-3.5 text-sky-400" /> Хватит ли бесплатного Neon (0.5 ГБ / 100 CU-часов)?
                  </p>
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-zinc-500">
                    <b className="text-zinc-300">Место на диске — да, с большим запасом:</b> вся база (каталог ~2500 предметов,
                    трекеры, уведомления) весит пару мегабайт из доступных 500. <br />
                    <b className="text-zinc-300">Компьютер-часы — единственное, что нужно контролировать:</b> Neon
                    «замораживает» базу через 5 минут без запросов, и это правило нельзя отключить на бесплатном
                    тарифе. Если проверять чаще, чем раз в 5 минут, база вообще не будет засыпать и лимит в 100
                    часов кончится примерно за 2–3 недели вместо месяца. При интервале <b className="text-zinc-300">10 минут</b> база
                    успевает поспать между проверками, и расход составляет примерно <b className="text-zinc-300">60–90 CU-часов
                    в месяц</b> для 4–5 человек — укладывается с запасом. Именно поэтому 10 минут выбраны по умолчанию.
                  </p>
                  <p className="mt-1.5 text-[11px] text-zinc-600">
                    Если лимит всё же закончится раньше конца месяца — Neon просто приостановит базу до следующего
                    месяца (данные не удаляются). Увеличьте интервал до 15–30 минут, и в следующем месяце лимита
                    хватит с запасом.
                  </p>
                </div>

                <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <p className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
                    <KeyRound className="h-3.5 w-3.5 text-zinc-500" /> Если сайт на бесплатном хостинге — добавьте "будильник"
                  </p>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-zinc-500">
                    Бесплатные тарифы хостингов (Render и похожие) "засыпают" через 10–15 минут без посетителей —
                    тогда планировщик выше тоже останавливается. Чтобы сайт не засыпал и проверка не прерывалась,
                    настройте бесплатный сервис, который сам заходит по ссылке ниже каждые несколько минут:
                  </p>
                  <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[12px] leading-relaxed text-zinc-400">
                    <li>Скопируйте ссылку ниже кнопкой справа.</li>
                    <li>Зайдите на <b className="text-zinc-200">cron-job.org</b> (бесплатно, регистрация по email).</li>
                    <li>Create cronjob → вставьте ссылку в поле URL → интервал «Every 10 minutes» (совпадает с интервалом проверки выше) → Save.</li>
                  </ol>
                  <div className="mt-2 flex gap-2">
                    <code className="mono min-w-0 flex-1 truncate rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-2 text-[11px] text-zinc-400">
                      {cronUrl || "Загрузка…"}
                    </code>
                    <button onClick={() => cronUrl && copyText(cronUrl, "URL скопирован")} className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:text-white" title="Скопировать URL">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={regenCron} className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:text-white" title="Если ссылка попала не в те руки — создать новую">
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-zinc-600">
                    Ссылка содержит секретный код доступа — не выкладывайте её публично. Если это всё же случилось,
                    нажмите кнопку обновления рядом и впишите новую ссылку в cron-job.org.
                  </p>
                  <details className="mt-2.5 rounded-lg bg-zinc-950/60 px-3 py-2.5">
                    <summary className="flex items-center gap-1.5 text-[12px] font-semibold text-zinc-200">
                      <ChevronDown className="h-3.5 w-3.5" /> Ещё не разместили сайт? Пошагово — бесплатно, без карты, ~20 минут
                    </summary>
                    <ol className="mt-2.5 list-decimal space-y-3 pl-5 text-[12px] leading-relaxed text-zinc-400">
                      <li>
                        <b className="text-zinc-200">База данных на Neon.</b> На <b className="text-zinc-200">neon.tech</b> создайте
                        проект (это уже сделано, если вы видите этот сайт). В разделе Connection Details скопируйте
                        строку вида <code className="mono rounded bg-zinc-800 px-1">postgresql://...</code> — это ваш будущий{" "}
                        <code className="mono rounded bg-zinc-800 px-1">DATABASE_URL</code>. Таблицы создавать вручную не нужно —
                        сайт создаст их сам при первом запуске.
                      </li>
                      <li>
                        <b className="text-zinc-200">Код на GitHub.</b> Откройте проект в VS Code → вкладка «Терминал» → по очереди:
                        <div className="mono mt-1.5 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-2.5 text-[11px] text-zinc-300">
                          <div>git init</div>
                          <div>git add .</div>
                          <div>git commit -m &quot;Первая версия сайта&quot;</div>
                          <div>git branch -M main</div>
                          <div>git remote add origin https://github.com/ВАШ_НИК/НАЗВАНИЕ_РЕПО.git</div>
                          <div>git push -u origin main</div>
                        </div>
                        Ссылку для строки с <code className="mono rounded bg-zinc-800 px-1">remote add</code> берут на github.com:
                        зелёная кнопка «New» → придумайте имя репозитория → Create repository → скопируйте ссылку сверху страницы.
                        Файл <code className="mono rounded bg-zinc-800 px-1">.env</code> с паролями в GitHub не попадёт — он уже в .gitignore.
                      </li>
                      <li>
                        <b className="text-zinc-200">Сайт на Render.</b> На <b className="text-zinc-200">render.com</b> → New →
                        Web Service → «Build and deploy from a Git repository» → выберите свой репозиторий (если не виден —
                        нажмите «Configure account» и разрешите доступ к нему). Build Command:{" "}
                        <code className="mono rounded bg-zinc-800 px-1">npm install && npm run build</code>, Start Command:{" "}
                        <code className="mono rounded bg-zinc-800 px-1">npm start</code>, Instance Type: Free.
                      </li>
                      <li>
                        Перед первым Deploy откройте вкладку Environment и добавьте переменные:{" "}
                        <code className="mono rounded bg-zinc-800 px-1">DATABASE_URL</code> (строка из шага 1),{" "}
                        <code className="mono rounded bg-zinc-800 px-1">EXBO_CLIENT_ID</code> = 4062,{" "}
                        <code className="mono rounded bg-zinc-800 px-1">EXBO_CLIENT_SECRET</code> = bcoEmyJYSCDarPliHZ0SNOkZscVDCkP0twxPwfLU
                        → Create Web Service. Первая сборка займёт 3–5 минут.
                      </li>
                      <li>
                        Когда сайт откроется по адресу вида <code className="mono rounded bg-zinc-800 px-1">https://ваш-сайт.onrender.com</code>,
                        настройте cron-job.org, как описано выше (иначе Render уснёт через 15 минут без посетителей).
                      </li>
                      <li>Вернитесь сюда с этого адреса, впишите его в поле «Адрес сайта» ниже и привяжите Telegram — на этом всё готово.</li>
                    </ol>
                    <p className="mt-2.5 text-[11.5px] text-zinc-600">
                      Более подробная версия этой инструкции — в файле <code className="mono rounded bg-zinc-800 px-1">HOSTING.md</code> в корне проекта.
                    </p>
                  </details>
                </div>
              </section>

              {/* ===== Сайт и база ===== */}
              <section className="rounded-2xl border border-zinc-800/80 bg-[#101013] p-5">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-violet-400" />
                  <h2 className="text-[15px] font-bold text-white">Сайт и база предметов</h2>
                </div>
                <label className="mb-1 mt-3 block text-[12px] font-medium text-zinc-400">Адрес сайта (для кнопок в Telegram)</label>
                <div className="flex gap-2">
                  <input
                    value={siteUrlInput}
                    onChange={(e) => setSiteUrlInput(e.target.value)}
                    placeholder="https://ваш-сайт.com"
                    className="mono min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[12.5px] text-white outline-none placeholder-zinc-600 focus:border-violet-500/50"
                  />
                  <button
                    onClick={() => { try { setSiteUrlInput(window.location.origin); } catch { /* ignore */ } }}
                    className="shrink-0 rounded-xl border border-zinc-700 bg-zinc-800 px-3 py-2 text-[12.5px] font-medium text-zinc-200 hover:bg-zinc-700"
                    title="Подставить текущий адрес"
                  >
                    Текущий
                  </button>
                  <button
                    onClick={() => saveSettings({ site_url: siteUrlInput }, "Адрес сайта сохранён")}
                    className="shrink-0 rounded-xl bg-[#d4ff3f] px-4 py-2 text-[13px] font-bold text-black hover:brightness-110"
                  >
                    Сохранить
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                  <Database className="h-4 w-4 text-zinc-500" />
                  <p className="min-w-0 flex-1 text-[12px] text-zinc-400">
                    Когда разработчики добавляют в игру новый предмет, сайт сам подтягивает его в каталог
                    (проверка раз в 6 часов). Если нужен предмет прямо сейчас — не ждите, обновите вручную:
                  </p>
                  <button
                    onClick={syncItems}
                    className="rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2 text-[12.5px] font-medium text-zinc-200 hover:bg-zinc-700"
                  >
                    Обновить сейчас
                  </button>
                </div>
              </section>

              {/* ===== Как это работает ===== */}
              <section className="rounded-2xl border border-[#d4ff3f]/20 bg-[#d4ff3f]/[0.03] p-5">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-[#d4ff3f]" />
                  <h2 className="text-[15px] font-bold text-white">Откуда приходят уведомления — коротко</h2>
                </div>
                <ol className="mt-2 space-y-2 text-[12.5px] leading-relaxed text-zinc-400">
                  <li className="flex gap-2"><span className="mono font-bold text-[#d4ff3f]">1.</span> Пока сервер сайта запущен — он сам, по расписанию (по умолчанию раз в 10 минут), заходит на аукцион и сверяет ваши трекеры.</li>
                  <li className="flex gap-2"><span className="mono font-bold text-[#d4ff3f]">2.</span> Если хостинг бесплатный и "засыпает" — внешний будильник (cron-job.org) не даёт ему уснуть.</li>
                  <li className="flex gap-2"><span className="mono font-bold text-[#d4ff3f]">3.</span> Открытая в браузере страница проверяет ещё чаще и добавляет звук + всплывающее уведомление на компьютере.</li>
                </ol>
                <p className="mt-2 rounded-xl bg-zinc-900/60 px-3 py-2 text-[11.5px] leading-relaxed text-zinc-500">
                  Дублей не будет: сообщение приходит только про лот, которого не было при прошлой проверке.
                  А в самый первый раз после создания трекера сайт молча запоминает, что сейчас есть на аукционе,
                  и не присылает лишнего — уведомления начнутся только про новые лоты, появившиеся позже.
                </p>
              </section>
            </div>
          </div>
        )}
      </main>

      {/* ===== Footer ===== */}
      <footer className="border-t border-zinc-800/60 py-4">
        <div className="mx-auto flex max-w-[1280px] items-center justify-center px-4">
          {footerCountdown ? (
            <button
              onClick={() => setView("settings")}
              title="Настройки фонового трекинга"
              className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-4 py-1.5 text-[12px] text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 live-dot" />
              {footerCountdown.label}{" "}
              <span className="mono font-semibold text-zinc-200">
                {footerCountdown.secs > 0
                  ? `${Math.floor(footerCountdown.secs / 60)}:${String(footerCountdown.secs % 60).padStart(2, "0")}`
                  : "обновляется…"}
              </span>
            </button>
          ) : (
            <span className="text-[12px] text-zinc-600">AucTracker</span>
          )}
        </div>
      </footer>

      {/* ===== Модалка трекера ===== */}
      {showTrackerModal && (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setShowTrackerModal(false)}>
          <div
            className="w-full max-w-md rounded-2xl border border-zinc-800 bg-[#121214] p-5 shadow-2xl anim-fade-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={itemIcon(selectedItem)} alt="" onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }} className="h-10 w-10 rounded-lg border border-zinc-800 bg-zinc-900 object-contain p-1" />
                <div>
                  <h2 className="text-[15px] font-bold text-white">🎯 Новый трекер</h2>
                  <p className="max-w-[240px] truncate text-[12px] text-zinc-500">{itemName(selectedItem)} · {region}</p>
                </div>
              </div>
              <button onClick={() => setShowTrackerModal(false)} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-[12px] font-medium text-zinc-400">Режим заточки</label>
                <div className="grid grid-cols-3 gap-1 rounded-xl border border-zinc-800 bg-zinc-900/50 p-1">
                  {[
                    { v: "exact", t: "Точно" },
                    { v: "min", t: "От и выше" },
                    { v: "any", t: "Любая" },
                  ].map((o) => (
                    <button
                      key={o.v}
                      onClick={() => setTrackerForm((f) => ({ ...f, upgradeMode: o.v }))}
                      className={`rounded-lg px-2 py-1.5 text-[12.5px] font-medium ${trackerForm.upgradeMode === o.v ? "bg-[#d4ff3f] text-black" : "text-zinc-400 hover:text-white"}`}
                    >
                      {o.t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-400">Заточка (+)</label>
                  <input
                    type="number" min={0} max={30}
                    value={trackerForm.targetUpgrade}
                    disabled={trackerForm.upgradeMode === "any"}
                    onChange={(e) => setTrackerForm((f) => ({ ...f, targetUpgrade: Math.max(0, Math.min(30, Number(e.target.value) || 0)) }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-white outline-none disabled:opacity-40"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-400">Редкость</label>
                  <select
                    value={trackerForm.targetQuality}
                    onChange={(e) => setTrackerForm((f) => ({ ...f, targetQuality: Number(e.target.value) }))}
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-white outline-none"
                  >
                    <option value={-1}>Любая</option>
                    {[0, 1, 2, 3, 4, 5].map((q) => <option key={q} value={q}>{QUALITY_NAMES[q]}</option>)}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-400">Цена от (₽)</label>
                  <input
                    value={trackerForm.minPrice || ""}
                    onChange={(e) => setTrackerForm((f) => ({ ...f, minPrice: Number(e.target.value.replace(/\D/g, "")) || 0 }))}
                    placeholder="0 = любая"
                    inputMode="numeric"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-white outline-none placeholder-zinc-600"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[12px] font-medium text-zinc-400">Цена до (₽)</label>
                  <input
                    value={trackerForm.maxPrice || ""}
                    onChange={(e) => setTrackerForm((f) => ({ ...f, maxPrice: Number(e.target.value.replace(/\D/g, "")) || 0 }))}
                    placeholder="0 = любая"
                    inputMode="numeric"
                    className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-[13px] text-white outline-none placeholder-zinc-600"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setTrackerForm((f) => ({ ...f, enableSound: !f.enableSound }))}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12.5px] font-medium ${trackerForm.enableSound ? "border-[#d4ff3f]/40 bg-[#d4ff3f]/10 text-[#d4ff3f]" : "border-zinc-800 text-zinc-500"}`}
                >
                  <Volume2 className="h-3.5 w-3.5" /> Звук
                </button>
                <button
                  onClick={() => setTrackerForm((f) => ({ ...f, enableBrowser: !f.enableBrowser }))}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-[12.5px] font-medium ${trackerForm.enableBrowser ? "border-[#d4ff3f]/40 bg-[#d4ff3f]/10 text-[#d4ff3f]" : "border-zinc-800 text-zinc-500"}`}
                >
                  <Bell className="h-3.5 w-3.5" /> Пуш
                </button>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-zinc-200">
                  <Send className="h-3.5 w-3.5 text-sky-400" /> Уведомления в Telegram
                </div>
                {tgChats.filter((c) => c.isActive).length === 0 ? (
                  <button
                    onClick={() => { setShowTrackerModal(false); setView("settings"); }}
                    className="w-full rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-[12px] leading-relaxed text-zinc-400 hover:border-sky-500/50 hover:text-sky-300"
                  >
                    Привяжите Telegram в настройках — уведомления будут приходить, даже когда сайт закрыт →
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    <label className="flex cursor-pointer items-center gap-2 rounded-lg bg-zinc-900/70 px-2.5 py-1.5 text-[12.5px] text-zinc-200">
                      <input
                        type="checkbox"
                        checked={tgSelected === null}
                        onChange={() => setTgSelected(tgSelected === null ? tgChats.filter((c) => c.isActive).map((c) => c.chatId) : null)}
                        className="h-3.5 w-3.5 accent-[#d4ff3f]"
                      />
                      Всем привязанным ({tgChats.filter((c) => c.isActive).length})
                    </label>
                    {tgSelected !== null && tgChats.filter((c) => c.isActive).map((c) => (
                      <label key={c.chatId} className="ml-4 flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1 text-[12px] text-zinc-300 hover:bg-zinc-900/70">
                        <input
                          type="checkbox"
                          checked={tgSelected.includes(c.chatId)}
                          onChange={() => setTgSelected((prev) => {
                            const arr = prev || [];
                            return arr.includes(c.chatId) ? arr.filter((x) => x !== c.chatId) : [...arr, c.chatId];
                          })}
                          className="h-3.5 w-3.5 accent-[#d4ff3f]"
                        />
                        <span className="truncate">{c.name || c.chatId} {c.username ? <span className="text-zinc-500">@{c.username}</span> : null}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <p className="rounded-xl bg-zinc-900/60 px-3 py-2 text-[11.5px] leading-relaxed text-zinc-500">
                💡 Сервер проверяет аукцион каждые {Math.round((scheduler?.interval || 600) / 60) || 1} мин — уведомления в Telegram приходят, даже когда сайт закрыт. Открытая вкладка дополнительно проверяет каждые {checkInterval} сек + звук и пуши в браузере.
              </p>
            </div>

            <div className="mt-4 flex gap-2">
              <button onClick={saveTracker} className="flex-1 rounded-xl bg-[#d4ff3f] py-2.5 text-[13.5px] font-bold text-black hover:brightness-110">
                Запустить слежку
              </button>
              <button onClick={() => setShowTrackerModal(false)} className="rounded-xl bg-zinc-800 px-5 py-2.5 text-[13.5px] font-medium text-zinc-300 hover:bg-zinc-700">
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Панель уведомлений ===== */}
      {showNotifs && (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm" onClick={() => setShowNotifs(false)}>
          <aside
            className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-[#0d0d0f] anim-slide-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-zinc-800 p-4">
              <Bell className="h-4 w-4 text-[#d4ff3f]" />
              <h2 className="text-[15px] font-bold text-white">Уведомления</h2>
              {unread > 0 && <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold text-white">{unread} новых</span>}
              <div className="ml-auto flex gap-1.5">
                <button
                  onClick={async () => { await fetch("/api/notifications", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: true }) }); loadNotifications(); }}
                  className="rounded-lg px-2.5 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-white"
                >
                  Прочитать все
                </button>
                <button onClick={() => setShowNotifs(false)} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-white">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {notifications.length === 0 ? (
                <div className="grid h-full place-items-center text-center">
                  <div>
                    <Bell className="mx-auto h-8 w-8 text-zinc-700" />
                    <p className="mt-2 text-[13.5px] font-medium text-zinc-400">Пока тихо</p>
                    <p className="mt-1 text-[12px] text-zinc-600">Здесь появятся найденные трекерами лоты</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {notifications.map((n) => (
                    <div key={n.id} className={`flex gap-3 rounded-xl border p-3 ${n.isRead ? "border-zinc-800/60 bg-zinc-900/30" : "border-[#d4ff3f]/25 bg-[#d4ff3f]/5"}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={n.itemIcon || FALLBACK_ICON} alt="" onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }} className="h-10 w-10 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 object-contain p-1" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-white">{n.itemName}</p>
                        <p className="mono mt-0.5 text-[12.5px] font-bold text-[#d4ff3f]">
                          +{n.upgrade} · {formatPrice(n.price)} ₽
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-500">
                          {n.qualityName} · {n.region} · {timeAgo(n.createdAt)}
                        </p>
                      </div>
                      {!n.isRead && <span className="h-2 w-2 shrink-0 rounded-full bg-[#d4ff3f]" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {notifications.length > 0 && (
              <div className="border-t border-zinc-800 p-3">
                <button
                  onClick={async () => { await fetch("/api/notifications", { method: "DELETE" }); loadNotifications(); }}
                  className="w-full rounded-xl border border-zinc-800 py-2 text-[12.5px] text-zinc-500 hover:text-red-400"
                >
                  Очистить все
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* ===== Тосты ===== */}
      <div className="fixed bottom-4 right-4 z-[110] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="flex gap-3 rounded-2xl border border-[#d4ff3f]/30 bg-[#101013]/95 p-3.5 shadow-2xl backdrop-blur anim-slide-in">
            {t.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.icon} alt="" onError={(e) => { (e.target as HTMLImageElement).src = FALLBACK_ICON; }} className="h-10 w-10 shrink-0 rounded-lg border border-zinc-800 bg-zinc-900 object-contain p-1" />
            ) : (
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#d4ff3f]/15 text-[#d4ff3f]">
                <Settings2 className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold text-white">{t.title}</p>
              <p className="mt-0.5 text-[12px] text-zinc-400">{t.message}</p>
            </div>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-zinc-600 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}