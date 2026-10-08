import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Home from "../page";
import RevisitPage, { metadata } from "./page";
import { ReturnSelection } from "./views";
import { INITIAL_RETURN_STATE } from "../../lib/revisit/return-controller";
import type { CaptureCard } from "../../lib/revisit/card";
const card: CaptureCard = { captureId: "save", title: "Recognisable title", rawText: "Original message", note: "Original reason", kind: "link", channel: "email", source: "example.com", savedAt: "2025-01-01T00:00:00Z", inferred: [], assets: [] };
const render = (cards: CaptureCard[], pending: string | null = null) => renderToStaticMarkup(<ReturnSelection state={{ ...INITIAL_RETURN_STATE, phase: "ready", token: "token", cards, more: true, pending }} act={vi.fn()} load={vi.fn()} />);
describe("later-0020 return surface", () => {
  it("AC1 anonymous page contains no private capture or research reveal", () => {
    const markup = renderToStaticMarkup(<RevisitPage />);
    expect(markup).toContain("Come back to this"); expect(markup).not.toContain("Saved capture");
    expect(markup).not.toMatch(/recallStatus|rememberedInterest|confidence/); expect(metadata.robots).toEqual({ index: false, follow: false });
  });
  it.each(["link", "email", "image", "unknown"])("AC2 renders older %s and incomplete enrichment with original context", kind => {
    const markup = render([{ ...card, kind, title: kind === "unknown" ? undefined : card.title,
      assets: [{ id: "image", filename: "Memory.png", mediaType: "image/png", available: true, raster: true }] }]);
    for (const text of ["Original message", "Original reason", "example.com", "Memory.png", 'dateTime="2025-01-01', "Download attachment"]) expect(markup).toContain(text);
    expect(markup).not.toMatch(/<pre|recallStatus|pipeline|streak|overdue|total saves|backlog/i);
  });
  it("AC3 disables missing Open destinations but keeps attachment and explicit choices", () => {
    const markup = render([card]);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Open original/);
    expect(markup).toMatch(/<button(?![^>]*disabled="")[^>]*>Already consumed/);
    expect(render([{ ...card, originalDestination: "https://example.com" }])).not.toContain('href="https://example.com"');
  });
  it("AC5 has exact empty copy, loading announcement and recoverable failure", () => {
    expect(render([])).toContain("Nothing to bring back right now.");
    expect(render([], "batch")).toContain("Loading your saves…");
    expect(renderToStaticMarkup(<ReturnSelection state={{ ...INITIAL_RETURN_STATE, phase: "error", message: "Please try again." }} act={vi.fn()} load={vi.fn()} />)).toContain("Try again");
  });
  it("AC6 labels native keyboard actions, announces pending state and wraps long content", () => {
    const markup = render([{ ...card, rawText: "x".repeat(4000) }], "save");
    expect(markup).toContain('aria-busy="true"'); expect(markup).toContain('role="status"');
    expect(markup).toContain('role="group" aria-label="Choices for Recognisable title"');
    expect(markup).toContain('aria-describedby="delay-save"'); expect(markup).toContain("seven days");
    expect(markup).toContain("overflow-wrap:anywhere"); expect(markup).toContain("flex-wrap");
    expect(markup.match(/disabled=""/g)?.length).toBe(4);
  });
  it("AC7 provides separate landing routes and exact documented auth redirect", () => {
    const markup = renderToStaticMarkup(<Home />);
    expect(markup).toContain('href="/revisit"'); expect(markup).toContain('href="/research"');
    const readme = readFileSync("README.md", "utf8"); expect(readme).toContain("https://notfor.now/revisit");
    expect(readme).toContain("<deployment-origin>/revisit"); expect(readme).toContain("Redirect URLs");
  });
});
