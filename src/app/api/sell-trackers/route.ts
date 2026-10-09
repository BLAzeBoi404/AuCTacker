import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sellTrackers, telegramChats } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { fetchLotsAll, normalizeRegion } from "@/lib/exbo";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";
import { invalidateTrackerCache } from "@/lib/tracker-check";
import { cached, invalidateOwner } from "@/lib/user-cache";
import { esc, getBotToken, sendTelegramMessage } from "@/lib/telegram";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

const MAX_SELL_TRACKERS_PER_USER = 25;
const ALLOWED_DURATIONS = [6, 12, 24, 48];

function snapDuration(h: number): number {
  const n = Math.max(1, Math.round(Number(h) || 48));
  let best = ALLOWED_DURATIONS[0];
  for (const d of ALLOWED_DURATIONS) {
    if (Math.abs(d - n) < Math.abs(best - n)) best = d;
  }
  return best;
}

function sameLot(
  lot: { buyoutPrice: number; startPrice: number; amount: number; upgrade: number; quality: number; endTime: string | null; id: string },
  f: { lotId?: string; price: number; amount: number; upgrade: number; quality: number; endTime: string | null },
): boolean {
  if (f.lotId && lot.id === f.lotId) return true;
  const price = lot.buyoutPrice || lot.startPrice || 0;
  if (price !== f.price || lot.amount !== f.amount || lot.upgrade !== f.upgrade || lot.quality !== f.quality) {
    return false;
  }
  if (f.endTime && lot.endTime) {
    return Math.abs(new Date(lot.endTime).getTime() - new Date(f.endTime).getTime()) < 120_000;
  }
  return true;
}

export async function GET() {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const rows = await cached(`sell:${owner}`, () =>
      db.select().from(sellTrackers).where(eq(sellTrackers.ownerKey, owner)).orderBy(desc(sellTrackers.createdAt)),
    );
    return NextResponse.json({ success: true, sellTrackers: rows });
  } catch (e) {
    console.error("GET /api/sell-trackers failed:", e);
    return NextResponse.json({ success: false, sellTrackers: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const body = await req.json();
    const itemId = String(body.itemId || "").toLowerCase().trim();
    if (!itemId) {
      return NextResponse.json({ success: false, error: "itemId_required" }, { status: 400 });
    }
    const region = normalizeRegion(body.region);
    const price = Math.max(0, Math.round(Number(body.price) || 0));
    const amount = Math.max(1, Math.min(999, Math.round(Number(body.amount) || 1)));
    const upgrade = Math.max(0, Math.min(30, Math.round(Number(body.upgrade) || 0)));
    const quality = [0, 1, 2, 3, 4, 5].includes(Number(body.quality)) ? Number(body.quality) : 0;
    const lotId = typeof body.lotId === "string" && body.lotId ? body.lotId : null;
    const clientEnd = typeof body.endTime === "string" && body.endTime ? new Date(body.endTime) : null;
    const durationH = snapDuration(body.durationH ?? body.listedDurationH ?? 48);

    if (!price) {
      return NextResponse.json({ success: false, error: "price_required", message: "Не указана цена лота." }, { status: 400 });
    }

    const mine = await db
      .select({ id: sellTrackers.id })
      .from(sellTrackers)
      .where(and(eq(sellTrackers.ownerKey, owner), eq(sellTrackers.status, "active")));
    if (mine.length >= MAX_SELL_TRACKERS_PER_USER) {
      return NextResponse.json(
        { success: false, error: "limit_reached", message: `Максимум ${MAX_SELL_TRACKERS_PER_USER} активных продаж на профиль.` },
        { status: 400 },
      );
    }

    // Проверяем, что такой лот реально есть на аукционе прямо сейчас.
    // Если EAPI его ещё не отдал (задержка после выставления) — честно скажем,
    // но привязку всё равно создадим: проверка догонит лот позже.
    let foundEnd: Date | null = clientEnd && !Number.isNaN(clientEnd.getTime()) ? clientEnd : null;
    let foundStart: Date | null = null;
    let confirmed = false;
    try {
      const { lots } = await fetchLotsAll(itemId, region, 500);
      const hit = lots.find((l) =>
        sameLot(l, { lotId: lotId || undefined, price, amount, upgrade, quality, endTime: foundEnd ? foundEnd.toISOString() : null }),
      );
      if (hit) {
        confirmed = true;
        if (hit.endTime) foundEnd = new Date(hit.endTime);
        if (hit.startTime) foundStart = new Date(hit.startTime);
      }
    } catch {
      // EXBO недоступен — создаём привязку, фоновая проверка разберётся
    }

    const expectedEnd = foundEnd ?? new Date(Date.now() + durationH * 3_600_000);

    // Защита от двойной привязки одного и того же лота
    const dup = await db
      .select({ id: sellTrackers.id })
      .from(sellTrackers)
      .where(
        and(
          eq(sellTrackers.ownerKey, owner),
          eq(sellTrackers.itemId, itemId),
          eq(sellTrackers.region, region),
          eq(sellTrackers.status, "active"),
        ),
      );
    // Точное совпадение по отпечатку — вернём существующий вместо дубля
    for (const d of dup) {
      const [row] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, d.id));
      if (
        row &&
        row.price === price &&
        (row.amount ?? 1) === amount &&
        (row.upgrade ?? 0) === upgrade &&
        (row.quality ?? 0) === quality &&
        row.expectedEndTime &&
        Math.abs(new Date(row.expectedEndTime).getTime() - expectedEnd.getTime()) < 10 * 60_000
      ) {
        return NextResponse.json({ success: true, sellTracker: row, duplicate: true });
      }
    }

    const itemName = String(body.itemName || itemId);
    const [row] = await db
      .insert(sellTrackers)
      .values({
        ownerKey: owner,
        itemId,
        itemName,
        itemIcon: body.itemIcon ? String(body.itemIcon) : null,
        region,
        price,
        amount,
        upgrade,
        quality,
        qualityName: typeof body.qualityName === "string" ? body.qualityName : null,
        targetLotId: lotId,
        startTime: foundStart,
        expectedEndTime: expectedEnd,
        listedDurationH: durationH,
        status: "active",
        lastSeenAt: confirmed ? new Date() : null,
        missCount: 0,
      })
      .returning();

    invalidateTrackerCache(); // чтобы фоновая проверка подхватила новую продажу
    invalidateOwner(owner);

    // Мгновенное подтверждение в Telegram — пользователь видит, что привязка сработала
    let tgSent = false;
    try {
      const token = await getBotToken();
      const enabled = ((await getSetting("telegram_enabled")) ?? "1") === "1";
      if (token && enabled) {
        const chats = await db
          .select({ chatId: telegramChats.chatId })
          .from(telegramChats)
          .where(and(eq(telegramChats.ownerKey, owner), eq(telegramChats.isActive, true)));
        if (chats.length) {
          const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
          const html =
            `🔔 <b>Лот привязан к продаже: ${esc(itemName)}</b>\n\n` +
            `Цена: <b>${price.toLocaleString("ru-RU")} ₽</b>${amount > 1 ? ` × ${amount}` : ""}\n` +
            `${upgrade > 0 ? `+${upgrade} • ` : ""}Регион: ${esc(region)}\n` +
            `Лот завершается: <b>${expectedEnd.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</b>\n` +
            `Источник: EXBO EAPI\n\n` +
            (confirmed
              ? `Вижу ваш лот на аукционе. Сообщу, когда он продастся или истечёт срок.`
              : `Пока не вижу лот на аукционе (возможно, EAPI ещё не обновился). Буду проверять — как только появится, возьму под наблюдение.`);
          for (const c of chats) {
            if (await sendTelegramMessage(c.chatId, html, siteUrl ? `${siteUrl}/?item=${encodeURIComponent(itemId)}` : undefined)) {
              tgSent = true;
            }
          }
        }
      }
    } catch (e) {
      console.error("sell bind telegram failed:", e);
    }

    return NextResponse.json({ success: true, sellTracker: row, confirmed, tgSent });
  } catch (e) {
    console.error("POST /api/sell-trackers failed:", e);
    return NextResponse.json({ success: false, error: "create_failed" }, { status: 500 });
  }
}
