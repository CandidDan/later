import { expect, test, type Page } from "@playwright/test";

async function signedInSelection(page: Page) {
  await page.addInitScript(() => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
    const access_token = [
      btoa(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      btoa(JSON.stringify({ sub: user.id, aud: "authenticated", exp })),
      "synthetic",
    ].join(".");
    localStorage.setItem("sb-return-test-auth-token", JSON.stringify({
      access_token, refresh_token: "synthetic", expires_at: exp,
      expires_in: 3600, token_type: "bearer", user,
    }));
  });
  const cards = [1, 2, 3].map(n => ({
    captureId: `save${n}`, title: `Saved item ${n}`, rawText: "LongContext".repeat(100),
    note: "My original note", kind: "link", channel: "email", source: "example.com",
    savedAt: "2025-01-01T00:00:00Z", inferred: [],
    assets: n === 1 ? [{ id: "asset", filename: "Memory.png", mediaType: "image/png", available: true, raster: true }] : [],
    originalDestination: "https://example.com/original",
  }));
  const state = { batches: 0, actions: 0, previews: 0, failPreview: true, failAction: false };
  await page.route("**/api/revisit/assets/**", route => {
    state.previews++;
    return state.failPreview
      ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
      : route.fulfill({ contentType: "image/png", body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64",
      ) });
  });
  await page.route("**/api/revisit/batch", route => {
    state.batches++;
    return route.fulfill({ json: { cards: cards.slice() } });
  });
  await page.route("**/api/revisit/actions/*", route => {
    state.actions++;
    if (state.failAction) return route.fulfill({ status: 503, json: { error: "Unavailable" } });
    cards.splice(cards.findIndex(card => route.request().url().endsWith(card.captureId)), 1);
    return route.fulfill({ json: { status: "applied" } });
  });
  await page.goto("/revisit");
  await expect(page.getByRole("article")).toHaveCount(3);
  return state;
}

test.beforeEach(async ({ page }) => {
  // Reject unexpected remote traffic, including accidental use of live auth configuration.
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://return-test.supabase.co") {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    if (url.origin === "http://127.0.0.1:3200") return route.continue();
    return route.abort();
  });
});

test.afterEach(async ({ page }) => {
  expect((await page.pageErrors()).map(error => error.message)).toEqual([]);
});

test("AC1 sends a magic link from the labelled return form", async ({ page }) => {
  await page.goto("/revisit");
  await page.getByLabel("Email address", { exact: true }).fill("owner@example.test");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email for a sign-in link.", { exact: false })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});

test("AC5 Retry preview decodes the recovered image without discarding choices", async ({ page }) => {
  const state = await signedInSelection(page);
  const retry = page.getByRole("button", { name: "Retry preview" });
  await expect(retry).toBeVisible();
  state.failPreview = false;
  const requestsBeforeRetry = state.previews;
  await retry.click();
  const image = page.getByAltText("Captured attachment: Memory.png");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  expect(state.previews).toBeGreaterThan(requestsBeforeRetry);
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Another time", exact: true })).toHaveCount(3);
  expect(state.actions).toBe(0);
});

for (const action of ["Another time", "Already consumed"]) {
  test(`AC6 keyboard ${action} moves focus after removal; AC4 waits for explicit more and survives reload`, async ({ page }) => {
    const state = await signedInSelection(page);
    const button = page.getByRole("button", { name: action, exact: true }).first();
    await button.focus();
    await expect(button).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("article")).toHaveCount(2);
    const more = page.getByRole("button", { name: "Show a few more" });
    await expect(more).toBeFocused();
    expect(state.actions).toBe(1);
    expect(state.batches).toBe(1);
    await page.keyboard.press("Enter");
    await expect.poll(() => state.batches).toBe(2);
    await page.reload();
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Saved item 1", exact: true })).toHaveCount(0);
  });
}

test("AC6 long content has no horizontal overflow at 320px", async ({ page }) => {
  await signedInSelection(page);
  await expect(page.getByText("LongContext".repeat(100), { exact: true }).first()).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth,
  }));
  expect(dimensions.viewport).toBe(320);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport);
});

test("AC5 failed action retains choices for retry; AC1 expiry clears private data", async ({ page }) => {
  const state = await signedInSelection(page);
  state.failAction = true;
  await page.getByRole("button", { name: "Another time", exact: true }).first().click();
  await expect(page.getByText("Your choice hasn't been confirmed", { exact: false })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(3);
  state.failAction = false;
  await page.getByRole("button", { name: "Another time", exact: true }).first().click();
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(state.actions).toBe(2);
  expect(state.batches).toBe(1);
  await page.route("**/api/revisit/batch", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
  await page.getByRole("button", { name: "Show a few more" }).click();
  await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
});
