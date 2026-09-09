export const QUALITY_NAMES: Record<number, string> = {
  0: "Обычный",
  1: "Необычный",
  2: "Особый",
  3: "Редкий",
  4: "Исключительный",
  5: "Легендарный",
};

export const QUALITY_COLORS: Record<number, string> = {
  0: "#a1a1aa",
  1: "#4ade80",
  2: "#60a5fa",
  3: "#c084fc",
  4: "#f87171",
  5: "#fbbf24",
};

export const REGIONS = [
  { id: "RU", label: "Россия", flag: "🇷🇺" },
  { id: "EU", label: "Европа", flag: "🇪🇺" },
  { id: "NA", label: "Америка", flag: "🇺🇸" },
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  weapon: "Оружие",
  armour: "Броня",
  armor: "Броня",
  artefact: "Артефакты",
  artefact_container: "Контейнеры",
  attachment: "Обвесы",
  ammo: "Патроны",
  medicine: "Медицина",
  supply: "Припасы",
  misc: "Разное",
  other: "Разное",
  food: "Еда",
  backpack: "Рюкзаки",
  helmet: "Шлемы",
  suit: "Костюмы",
  mask: "Маски",
  device: "Устройства",
  detector: "Детекторы",
  resource: "Ресурсы",
  material: "Материалы",
  quest: "Квестовые",
  currency: "Валюта",
  skin: "Скины",
  box: "Кейсы",
  grenade: "Гранаты",
};

export function categoryLabel(cat: string): string {
  if (!cat) return "Разное";
  const main = cat.split("/")[0].toLowerCase();
  return CATEGORY_LABELS[main] || CATEGORY_LABELS[cat.toLowerCase()] || "Разное";
}

// Популярные предметы для быстрого старта (реальные ID из игры)
export const POPULAR_ITEMS = [
  { id: "kqgy", name: "Браслет" },
  { id: "gdj6", name: "Детектор узкого диапазона «Эльбрус»" },
  { id: "qoq6", name: "Артефакт" },
  { id: "gy06", name: "Артефакт" },
  { id: "y1q9", name: "«Гадюка»" },
];

export const DB_BASE =
  "https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/global";
