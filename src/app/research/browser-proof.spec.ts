import { expect, test, type Page } from "@playwright/test";

const capture = { captureId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1", channel: "whatsapp", captureKind: "url", rawText: "Original saved words", userNote: "My note", sourcePlatform: "example", capturedAt: "2026-09-01T10:00:00Z", assets: [{ filename: "photo.png", mediaType: "image/png" }] };
const result = { contentType: "article", interest: { summary: "Possibly interested in " + "LongWords".repeat(150) + '<img src=x onerror="window.hacked=true">', confidence: 0.2 }, classification: { value: "uncertain", confidence: 0.3 }, underlyingSource: { hints: [], confidence: 0.1 }, resolutionRequired: false, evidence: [{ field: "userNote", observation: "The note may refer to this topic", weight: "primary" }] };
const runs = [1, 2].map(n => ({ evaluationId: `evaluation-${n}`, analysisId: `analysis-${n}`, modelId: `model-${n}`, promptVersion: "v1", pipelineVersion: "v1", analysedAt: capture.capturedAt, confidence: 0.1, result, rated: false }));

async function setup(page: Page, options: { resumed?: boolean; malformed?: boolean; failCard?: boolean; failRecall?: boolean; denyReveal?: boolean } = {}) {
  const state = { stored: !!options.resumed, cards: 0, previews: 0, reveals: 0, failRating: false, ratings: [] as string[], order: [] as string[] };
  await page.addInitScript(() => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const user = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.test" };
    const access_token = [btoa(JSON.stringify({ alg: "HS256" })), btoa(JSON.stringify({ sub: user.id, aud: "authenticated", exp })), "synthetic"].join(".");
    localStorage.setItem("sb-research-test-auth-token", JSON.stringify({ access_token, refresh_token: "synthetic", expires_at: exp, expires_in: 3600, token_type: "bearer", user }));
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://research-test.supabase.co") return route.fulfill({ json: {} });
    if (url.pathname.startsWith("/api/revisit/")) throw new Error("Research must not use ungated revisit endpoints");
    if (url.origin === "http://127.0.0.1:3201") return route.continue();
    return route.abort();
  });
  const frozen = () => runs.map(r => ({ ...r, rated: state.ratings.includes(r.evaluationId), result: options.malformed ? { unknown: "Unsupported frozen result" } : result }));
  await page.route("**/api/research/next", route => route.fulfill({ json: state.ratings.length === 2 ? { phase: "empty" } : { phase: state.stored ? "reveal" : "recall", capture, ...(state.stored ? { runs: frozen() } : {}) } }));
  await page.route("**/api/research/recall", route => {
    if (options.failRecall) return route.fulfill({ status: 503, json: {} });
    state.stored = true; state.order.push("stored");
    return route.fulfill({ json: { phase: "recorded", captureId: capture.captureId } });
  });
  await page.route("**/api/research/reveal?*", route => {
    state.reveals++; state.order.push("reveal");
    return options.denyReveal ? route.fulfill({ status: 409, json: { error: "recall_required" } }) : route.fulfill({ json: { phase: "reveal", captureId: capture.captureId, runs: frozen() } });
  });
  await page.route("**/api/research/cards/*", route => {
    state.cards++; state.order.push("card"); expect(state.stored).toBe(true);
    return options.failCard ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { captureId: capture.captureId, title: "Fetched title", creator: "Fetched creator", rawText: capture.rawText, note: capture.userNote, kind: "link", channel: capture.channel, source: "example", savedAt: capture.capturedAt, inferred: [], assets: [{ id: "asset", filename: "photo.png", mediaType: "image/png", available: true, raster: true }] } });
  });
  await page.route("**/api/research/assets/**", route => {
    state.previews++; state.order.push("preview"); expect(state.stored).toBe(true);
    return route.fulfill({ status: 503, json: {} });
  });
  await page.route("**/api/research/rating", route => {
    if (state.failRating) return route.fulfill({ status: 503, json: {} });
    const id = route.request().postDataJSON().evaluationId; state.ratings.push(id);
    return route.fulfill({ json: { phase: "rated", evaluationId: id } });
  });
  await page.goto("/research");
  return state;
}

test.afterEach(async ({ page }) => { expect((await page.pageErrors()).map(e => e.message)).toEqual([]); });

test("AC1/2/6 unaided network boundary, readable frozen uncertainty and keyboard disclosure", async ({ page }) => {
  const state = await setup(page);
  const recall = page.getByRole("form", { name: "Unaided recall" });
  await expect(recall).toBeVisible();
  await expect(page.getByText("1 Sept 2026", { exact: false })).toBeVisible();
  expect(state.cards).toBe(0); expect(state.previews).toBe(0); expect(state.reveals).toBe(0);
  await expect(page.getByText("Fetched title")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Interpretation 1", exact: true })).toHaveCount(0);
  await recall.getByRole("button").click();
  await expect(page.getByRole("heading", { name: "Fetched title" })).toBeVisible();
  const section = page.getByRole("region", { name: "Interpretation 1", exact: true });
  await expect(section.getByText("uncertain", { exact: true })).toBeVisible();
  await expect(section.getByText(result.interest.summary, { exact: true })).toBeVisible();
  const raw = section.locator("pre"); await expect(raw).toBeHidden();
  const disclosure = section.getByLabel("Technical details for interpretation 1");
  await disclosure.focus(); await page.keyboard.press("Enter");
  await expect(raw).toBeVisible(); expect(JSON.parse(await raw.innerText())).toEqual(result);
  await expect(section.getByText("Interest confidence 0.2", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => "hacked" in window)).toBe(false);
  expect(state.order.slice(0, 3)).toEqual(["stored", "reveal", "card"]);
});

test("AC2/3/4 resumed runs preserve rating identity, preview failure and retry completion", async ({ page }) => {
  const state = await setup(page, { resumed: true });
  await expect(page.getByRole("heading", { name: "Fetched title" })).toBeVisible();
  await expect(page.getByText("Attachment unavailable.", { exact: false })).toBeVisible();
  const first = page.getByRole("form", { name: "Rate run analysis-1", exact: true });
  await first.getByLabel("Wrong", { exact: true }).check();
  await first.getByRole("button").click();
  await expect(first.getByRole("button", { name: "Recorded" })).toBeDisabled();
  expect(state.ratings).toEqual(["evaluation-1"]);
  state.failRating = true;
  await page.getByRole("form", { name: "Rate run analysis-2", exact: true }).getByRole("button").click();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  state.failRating = false; await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("form", { name: "Rate run analysis-1", exact: true }).getByRole("button")).toBeDisabled();
  await page.getByRole("form", { name: "Rate run analysis-2", exact: true }).getByRole("button").click();
  await expect(page.getByText("Nothing to evaluate right now.")).toBeVisible();
  expect(state.ratings).toEqual(["evaluation-1", "evaluation-2"]);
});

test("AC4 malformed result and failed card retain raw data and usable rating", async ({ page }) => {
  const state = await setup(page, { resumed: true, malformed: true, failCard: true });
  await expect(page.getByText("Rich capture preview unavailable.", { exact: false })).toBeVisible();
  await expect(page.getByText("Readable interpretation unavailable:", { exact: false })).toHaveCount(2);
  await page.getByLabel("Technical details for interpretation 1").click();
  await expect(page.locator("pre").first()).toContainText("Unsupported frozen result");
  await page.getByRole("form", { name: "Rate run analysis-1", exact: true }).getByRole("button").click();
  expect(state.ratings).toEqual(["evaluation-1"]); expect(state.previews).toBe(0);
});

for (const failure of ["failRecall", "denyReveal"] as const) {
  test(`AC5 ${failure} cannot mount interpretation or request enrichment`, async ({ page }) => {
    const state = await setup(page, { [failure]: true });
    await page.getByRole("form", { name: "Unaided recall" }).getByRole("button").click();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Interpretation 1" })).toHaveCount(0);
    expect(state.cards).toBe(0); expect(state.previews).toBe(0);
  });
}
