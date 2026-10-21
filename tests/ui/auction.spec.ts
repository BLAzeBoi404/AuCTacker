import { test, expect, type Page } from "@playwright/test";

const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='12' fill='%2334d399'/%3E%3C/svg%3E";
const bracelet = { id: "AbC", nameRu: "Браслет", category: "artefact", iconUrl: icon };
const other = { id: "DEF", nameRu: "Браслет защитный", category: "artefact", iconUrl: icon };
const stone = { id: "Stone", nameRu: "Камень", category: "artefact", iconUrl: icon };

async function fixture(page: Page) {
  const data = {
    lotCount: 45,
    historyError: false,
    historyDelay: 0,
    searchDelay: 0,
    posted: null as Record<string, unknown> | null,
    lotsRequests: [] as string[],
    errors: [] as string[],
  };
  page.on("pageerror", (error) => data.errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = new URL(req.url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    switch (url.pathname) {
      case "/api/session": return respond({ success: true, isAdmin: false, adminConfigured: true, ownerKey: "1234567890abcdef1234567890abcdef" });
      case "/api/items/AbC": return respond({ success: true, item: bracelet });
      case "/api/items": {
        const q = url.searchParams.get("q")?.toLowerCase() ?? "";
        if (data.searchDelay && q) await new Promise((r) => setTimeout(r, data.searchDelay));
        if (q.includes("камень")) return respond({ success: true, items: [stone], total: 1 });
        if (q) return respond({ success: true, items: [other, bracelet], total: 2 }); // deliberately not exact-name first
        const offset = Number(url.searchParams.get("offset"));
        const count = Number(url.searchParams.get("limit")) || 24;
        return respond({ success: true, items: Array.from({ length: Math.min(50 - offset, count) }, (_, i) => ({ ...bracelet, id: `id${i + offset}`, nameRu: `Предмет ${i + offset}` })), total: 50, categories: [{ category: "artefact", count: 50 }] });
      }
      case "/api/lots": {
        data.lotsRequests.push(url.searchParams.get("itemId")!);
        const lots = Array.from({ length: data.lotCount }, (_, i) => ({ id: `lot-${i}`, startPrice: 3_000_000 + i * 1000,
          buyoutPrice: 3_000_000 + i * 1000, amount: 1, upgrade: 10, quality: 4, qualityName: "Исключительный",
          startTime: new Date(Date.now() - 3_600_000).toISOString(), endTime: new Date(Date.now() + 3_600_000).toISOString() }));
        return respond({ success: true, lots, total: lots.length });
      }
      case "/api/history": {
        if (data.historyDelay) await new Promise((r) => setTimeout(r, data.historyDelay));
        if (data.historyError) return respond({ success: false, message: "История временно недоступна" }, 502);
        const history = Array.from({ length: 45 }, (_, i) => ({ id: `h-${i}`, price: 3_000_000 + i * 1000, amount: 1,
          time: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), upgrade: i === 0 ? -1 : 10,
          quality: i === 0 ? -1 : 4, qualityName: i === 0 ? "Неизвестна" : "Исключительный" }));
        return respond({ success: true, history, total: history.length });
      }
      case "/api/trackers":
        if (req.method() === "POST") { data.posted = req.postDataJSON(); return respond({ success: true, tracker: { id: 1, ...data.posted } }); }
        return respond({ success: true, trackers: [] });
      case "/api/sell-trackers":
        if (req.method() === "POST") { data.posted = req.postDataJSON(); return respond({ success: true, confirmed: true, sellTracker: { id: 1, ...data.posted } }); }
        return respond({ success: true, sellTrackers: [] });
      case "/api/notifications": return respond({ success: true, notifications: [], unread: 0 });
      case "/api/telegram": return respond({ success: true, botReady: false, linked: false });
      default: throw new Error(`Unexpected API route: ${url.pathname}`);
    }
  });
  return data;
}

async function openItem(page: Page) {
  await page.goto("/?item=AbC");
  await expect(page.getByRole("heading", { name: "Браслет", exact: true })).toBeVisible();
  await expect(page.locator(".auction-row")).toHaveCount(15);
}

for (const width of [320, 375, 390, 768, 1024, 1440, 1920]) {
  test(`layout and navigation fit ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width < 768 ? 740 : 900 });
    const data = await fixture(page);
    await openItem(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nav = page.getByRole("navigation", { name: "Мобильная навигация" });
    if (width < 1024) await expect(nav).toBeVisible(); else await expect(nav).toBeHidden();
    if ([320, 390, 1440].includes(width)) await page.screenshot({ path: info.outputPath(`auction-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: width < 640 ? "Следить за предметом" : "Следить", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole("button", { name: "Запустить слежку" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Запустить слежку" })).toBeInViewport();
    await dialog.getByRole("button", { name: "Отмена" }).click();
    expect(data.errors).toEqual([]);
  });
}

test("Enter before suggestions load selects the exact name; stale suggestions cannot win", async ({ page }) => {
  const data = await fixture(page); data.searchDelay = 300;
  await openItem(page);
  const search = page.getByRole("searchbox", { name: "Поиск предмета" });
  await search.fill("браслет"); await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Браслет", exact: true })).toBeVisible();
  await expect(search).toHaveValue("Браслет");
  await search.fill("браслет");
  await page.waitForTimeout(200); // allow old request to start before the next query
  await search.fill("камень"); await search.press("Enter");
  await expect(page.getByRole("heading", { name: "Камень", exact: true })).toBeVisible();
  await expect.poll(() => data.lotsRequests.at(-1)).toBe("Stone");
  expect(data.errors).toEqual([]);
});

test("mobile search button submits the form without choosing a suggestion", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await fixture(page); await openItem(page);
  await page.getByRole("searchbox", { name: "Поиск предмета" }).fill("камень");
  await page.getByRole("button", { name: "Найти предмет" }).click();
  await expect(page.getByRole("heading", { name: "Камень", exact: true })).toBeVisible();
});

test("lots and history pagination scroll to the first row in both directions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await fixture(page); await openItem(page);
  for (const list of ["lots", "history"]) {
    if (list === "history") await page.getByRole("button", { name: /^История/ }).click();
    for (const direction of ["Вперёд", "Вперёд", "Назад"]) {
      await page.locator(".pagination").getByRole("button", { name: direction }).click();
      await expect.poll(() => page.getByTestId(`${list}-top`).evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeGreaterThanOrEqual(65);
      await expect.poll(() => page.getByTestId(`${list}-top`).evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThanOrEqual(80);
    }
  }
});

test("page is clamped when refreshing removes lots", async ({ page }) => {
  const data = await fixture(page); await openItem(page);
  await page.locator(".pagination").getByRole("button", { name: "Вперёд" }).click();
  await page.locator(".pagination").getByRole("button", { name: "Вперёд" }).click();
  data.lotCount = 1;
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.locator(".auction-row")).toHaveCount(1);
  await expect(page.getByText("Лоты не найдены", { exact: true })).toHaveCount(0);
});

test("rarity mode reaches the buy API, sale has no manual duration, tracker menu has no creation button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  const data = await fixture(page); await openItem(page);
  await page.getByRole("button", { name: "Следить за предметом" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "От и выше", exact: true }).nth(1).click();
  await dialog.getByRole("combobox").selectOption("3");
  await dialog.getByRole("button", { name: "Запустить слежку" }).click();
  await expect(dialog).toHaveCount(0);
  expect(data.posted).toMatchObject({ itemId: "AbC", qualityMode: "min", targetQuality: 3 });
  await page.getByTitle("Отслеживать продажу этого лота").first().click();
  await expect(page.getByRole("dialog").locator("input, select")).toHaveCount(0);
  await page.getByRole("button", { name: "Привязать продажу" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(data.posted?.lotId).toBe("lot-0");
  expect(data.posted).not.toHaveProperty("listedDurationH");
  expect(data.posted).not.toHaveProperty("durationH");
  await page.getByRole("navigation", { name: "Мобильная навигация" }).getByRole("button", { name: "Трекеры" }).click();
  await expect(page.getByRole("heading", { name: "Мои трекеры" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Новый трекер/ })).toHaveCount(0);
});

test("unknown history rarity is visible and API failures are not shown as an empty successful history", async ({ page }) => {
  const data = await fixture(page); data.historyDelay = 250;
  await openItem(page);
  await page.getByRole("button", { name: /^История/ }).click();
  await expect(page.locator(".auction-row").filter({ hasText: "Неизвестна" })).toHaveCount(1);
  data.historyError = true;
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await expect(page.getByText("История временно недоступна", { exact: true })).toBeVisible();
});

test("mobile catalogue and short landscape dialog remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await fixture(page); await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Мобильная навигация" });
  await nav.getByRole("button", { name: "Предметы" }).click();
  await expect(page.getByRole("heading", { name: "Каталог предметов" })).toBeVisible();
  await page.locator(".pagination").getByRole("button", { name: /Вперёд/ }).click();
  await expect(page.locator(".pagination")).toContainText("2 / 3");
  await expect.poll(() => page.getByTestId("catalog-top").evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThanOrEqual(80);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await nav.getByRole("button", { name: "Telegram" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 640, height: 320 });
  await openItem(page);
  await page.getByRole("button", { name: "Следить", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Запустить слежку" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Запустить слежку" })).toBeInViewport();
});
