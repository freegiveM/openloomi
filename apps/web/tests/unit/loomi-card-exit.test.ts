/**
 * Loomi Pet card — exit-button symmetry (#319 / #317).
 *
 * The popup card (`apps/web/public/loomi-card.html`) has paired exits in
 * both layouts:
 *   - compact Collapse / Open Loop actions
 *   - full-card ✕ / View details actions
 *
 * Every exit must retire the native card window instead of leaving its
 * transparent always-on-top region active.
 *
 * The card is plain HTML/JS that boots the Tauri bridge, so — like
 * `pet-theme.test.ts` — we assert against the shipped source directly.
 * A real DOM simulation is a follow-up once happy-dom is wired into the
 * node-environment vitest suite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cardPath = path.resolve(__dirname, "../../public/loomi-card.html");
const cardHtml = readFileSync(cardPath, "utf8");
// Remove comments so source assertions only match executable code.
const source = cardHtml
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/^\s*\/\/.*$/gm, "");

function hideCardWindowBody(): string {
  const start = source.indexOf("function hideCardWindow");
  expect(start, "hideCardWindow() not found").toBeGreaterThan(-1);
  const end = source.indexOf("(function wireCompactActions()", start);
  expect(end, "compact actions terminator not found").toBeGreaterThan(start);
  return source.slice(start, end);
}

function compactActionsBlock(): string {
  const start = source.indexOf("(function wireCompactActions()");
  expect(start, "compact actions not found").toBeGreaterThan(-1);
  const end = source.indexOf("async function postAction", start);
  expect(end, "postAction terminator not found").toBeGreaterThan(start);
  return source.slice(start, end);
}

function compactCloseBranch(): string {
  const block = compactActionsBlock();
  const start = block.indexOf('if (action === "close")');
  expect(start, "compact Collapse branch not found").toBeGreaterThan(-1);
  const end = block.indexOf('else if (action === "open-loop")', start);
  expect(end, "compact Open Loop branch not found").toBeGreaterThan(start);
  return block.slice(start, end);
}

function compactOpenBranch(): string {
  const block = compactActionsBlock();
  const start = block.indexOf('else if (action === "open-loop")');
  expect(start, "compact Open Loop branch not found").toBeGreaterThan(-1);
  return block.slice(start);
}

function openBranch(): string {
  const postAction = source.indexOf("async function postAction");
  expect(postAction, "postAction() not found").toBeGreaterThan(-1);
  const start = source.indexOf('if (action === "open")', postAction);
  expect(start, "postAction open branch not found").toBeGreaterThan(-1);
  const end = source.indexOf('if (action === "edit")', start);
  expect(end, "edit branch terminator not found").toBeGreaterThan(start);
  return source.slice(start, end);
}

function legacyCloseBranch(): string {
  const postAction = source.indexOf("async function postAction");
  const delegatedClick = source.indexOf(
    'card.addEventListener("click", (e) => {',
    postAction,
  );
  expect(
    delegatedClick,
    "delegated card click handler not found",
  ).toBeGreaterThan(postAction);
  const start = source.indexOf('if (action === "close")', delegatedClick);
  expect(start, "legacy close branch not found").toBeGreaterThan(
    delegatedClick,
  );
  const end = source.indexOf('if (action === "guide-connect-more")', start);
  expect(end, "legacy close branch terminator not found").toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

function tauriListenerBlock(eventName: string, nextEventName: string): string {
  const start = source.indexOf(`tauri.event.listen("${eventName}"`);
  expect(start, `${eventName} listener not found`).toBeGreaterThan(-1);
  const end = source.indexOf(`tauri.event.listen("${nextEventName}"`, start);
  expect(end, `${nextEventName} listener terminator not found`).toBeGreaterThan(
    start,
  );
  return source.slice(start, end);
}

describe("loomi-card shared window-hide helper", () => {
  it("defines a single reusable hideCardWindow() function", () => {
    const defs = source.match(/function hideCardWindow\s*\(/g) || [];
    expect(defs.length).toBe(1);
  });

  it("hideCardWindow() performs the full retirement sequence", () => {
    const body = hideCardWindowBody();
    expect(body).toMatch(/const win\s*=\s*getCurrentWindow\(\)/);
    expect(body).not.toMatch(/t\.window/);

    const cursorTransparent = body.indexOf("win.setIgnoreCursorEvents(true)");
    const nativeHide = body.indexOf("win.hide()");
    expect(
      cursorTransparent,
      "cursor transparency call not found",
    ).toBeGreaterThan(-1);
    expect(nativeHide, "native hide call not found").toBeGreaterThan(-1);
    expect(cursorTransparent).toBeLessThan(nativeHide);

    // Tell the Rust host.
    expect(body).toMatch(/emit\(\s*["']pet:close-card["']\s*\)/);
    // Fade the local DOM (standalone-browser fallback).
    expect(body).toMatch(/card\.style\.display\s*=\s*["']none["']/);
  });
});

describe("View details (open) fully retires the card (#319)", () => {
  it("open branch calls the shared hideCardWindow()", () => {
    expect(openBranch()).toMatch(/hideCardWindow\(\)/);
  });

  it("open branch clears the decision so an in-flight event can't re-pop it", () => {
    const branch = openBranch();
    expect(branch).toMatch(/decision\s*=\s*null/);
    expect(branch).toMatch(/emit\(\s*["']loop:decision-cleared["']/);
  });

  it("open branch still emits the navigation events", () => {
    const branch = openBranch();
    expect(branch).toMatch(/emit\(\s*["']pet:open-dashboard["']/);
    expect(branch).toMatch(/emit\(\s*["']pet:open-brief["']/);
    expect(branch).toMatch(/emit\(\s*["']pet:open-wrap["']/);
    expect(branch).toMatch(/emit\(\s*["']pet:open-decision["']/);
  });
});

describe("compact card exits reuse the shared hide sequence", () => {
  it("Collapse calls hideCardWindow()", () => {
    expect(compactCloseBranch()).toMatch(/hideCardWindow\(\)/);
  });

  it("Open Loop navigates and calls hideCardWindow()", () => {
    const branch = compactOpenBranch();
    expect(branch).toMatch(/emit\(\s*["']pet:open-dashboard["']/);
    expect(branch).toMatch(/hideCardWindow\(\)/);
  });
});

describe("background events preserve hidden cursor transparency", () => {
  it.each([
    ["loop:decision", "loop:state"],
    ["loop:state", "loop:pending-list"],
  ])("%s does not reactivate cursor events", (eventName, nextEventName) => {
    const listener = tauriListenerBlock(eventName, nextEventName);
    expect(listener).not.toMatch(/setIgnoreCursorEvents\(false\)/);
  });
});

describe("✕ close reuses the same hide sequence", () => {
  it("close handler calls hideCardWindow() instead of an inline hide", () => {
    const branch = legacyCloseBranch();
    expect(branch).toMatch(/hideCardWindow\(\)/);
    expect(branch).not.toMatch(/getCurrentWebviewWindow/);
  });
});
