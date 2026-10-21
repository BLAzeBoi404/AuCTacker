import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sellTrackers, telegramChats } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { fetchLotsAll, normalizeRegion } from "@/lib/exbo";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";
import { invalidateTrackerCache, liveSellRows } from "@/lib/tracker-check";
import { cached, invalidateOwner } from "@/lib/user-cache";
import { esc, getBotToken, sendTelegramMessage } from "@/lib/telegram";
import { getSetting } from "@/lib/settings";
import { isRecord, validItemId, validPrice } from "@/lib/validation";
import { isoDate } from "@/lib/auction-data";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

const MAX_SELL_TRACKERS_PER_USER = 25;
export async function GET() {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const rows = await cached(`sell:${owner}`, () =>
      db.select().from(sellTrackers).where(eq(sellTrackers.ownerKey, owner)).orderBy(desc(sellTrackers.createdAt)),
    );
    return NextResponse.json({ success: true, sellTrackers: liveSellRows(rows) });
  } catch (e) {
    console.error("GET /api/sell-trackers failed:", e);
    return NextResponse.json({ success: false, sellTrackers: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const body = await req.json().catch(() => null);
    if (!isRecord(body)) return NextResponse.json({ success: false, message: "Неверный формат запроса." }, { status: 400 });
    const itemId = String(body.itemId || "").trim();
    if (!validItemId(itemId)) {
      return NextResponse.json({ success: false, error: "itemId_required" }, { status: 400 });
    }
    const region = normalizeRegion(typeof body.region === "string" ? body.region : undefined);
    let price = Number(body.price);
    let amount = Number(body.amount ?? 1);
    let upgrade = Number(body.upgrade ?? -1);
    let quality = Number(body.quality ?? -1);
    let lotId = typeof body.lotId === "string" && body.lotId.length <= 200 ? body.lotId : null;
    const clientEnd = isoDate(body.endTime);
    if (!lotId || !validPrice(price) || !price || !Number.isSafeInteger(amount) || amount < 1
      || !Number.isInteger(upgrade) || upgrade < -1 || upgrade > 30 || ![-1, 0, 1, 2, 3, 4, 5].includes(quality)) {
      return NextResponse.json({ success: false, message: "Некорректные данные лота. Обновите аукцион и выберите лот заново." }, { status: 400 });
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

    // Срок берём только из самого лота; никаких придуманных 48 часов.
    let foundEnd = clientEnd ? new Date(clientEnd) : null;
    let foundStart: Date | null = null;
    let confirmed = false;
    try {
      const { lots } = await fetchLotsAll(itemId, region, 500);
      const hit = lots.find((lot) => lot.id === lotId || lot.legacyId === lotId);
      if (hit) {
        confirmed = true;
        lotId = hit.id;
        price = hit.buyoutPrice || hit.startPrice;
        amount = hit.amount;
        upgrade = hit.upgrade;
        quality = hit.quality;
        if (hit.endTime) foundEnd = new Date(hit.endTime);
        if (hit.startTime) foundStart = new Date(hit.startTime);
      }
    } catch {
      // Сохраняем выбранный пользователем ID; фон обновит данные при ответе API.
    }
    const expectedEnd = foundEnd;
    const duplicates = await db.select().from(sellTrackers).where(and(
      eq(sellTrackers.ownerKey, owner), eq(sellTrackers.itemId, itemId),
      eq(sellTrackers.region, region), eq(sellTrackers.status, "active"),
    ));
    const duplicate = duplicates.find((row) => row.targetLotId === lotId);
    if (duplicate) return NextResponse.json({ success: true, sellTracker: duplicate, duplicate: true });

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
        qualityMode: "exact",
        qualityName: QUALITY_NAMES[quality] || "Неизвестна",
        targetLotId: lotId,
        startTime: foundStart,
        expectedEndTime: expectedEnd,
        listedDurationH: null,
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
            (expectedEnd ? `Лот завершается: <b>${expectedEnd.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</b>\n` : `Срок окончания пока не передан EXBO.\n`) +
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
