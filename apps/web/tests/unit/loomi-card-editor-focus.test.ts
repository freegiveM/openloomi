/**
 * Loomi Pet card — editor input focus / pointer-events (regression).
 *
 * Bug report: "loomi card 中的 im reply 和 draft reply edit 输入框好像不能编辑"
 * (IM reply + email_reply editor textareas look un-editable on macOS).
 *
 * Root causes being defended against:
 *
 *   1. The card window is a Tauri NSPanel (`macos_window::
 *      configure_as_floating_panel`). NSPanel's `canBecomeKeyWindow`
 *      returns false until a real click lands on the webview. A bare
 *      `requestAnimationFrame(() => body.focus())` fires *before* that
 *      click has promoted the window to key, so the focus() call silently
 *      no-ops and the user sees the editor open but typing goes nowhere.
 *      Fix: triple-tap the focus call (rAF + 60ms + 200ms) so the
 *      textarea picks up focus once the window actually becomes key.
 *
 *   2. macOS webview shells can drop `pointer-events` on descendants of
 *      `html, body { user-select: none }` — a defensive `pointer-events:
 *      auto` + `user-select: text` on the editable surface itself keeps
 *      click-to-focus reliable even if a future CSS rule accidentally
 *      disables pointer events upstream.
 *
 *   3. Caret color hard-coded to `--ink` (a fixed dark color) was
 *      invisible against the dark-theme `--panel-soft` background. The
 *      caret now follows `currentColor` so it stays visible in both
 *      themes.
 *
 * The card is plain HTML/JS that boots the Tauri bridge, so — like
 * `loomi-card-exit.test.ts` — we assert against the shipped source
 * directly. A real DOM simulation is a follow-up once happy-dom is wired
 * into the node-environment vitest suite.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const cardPath = path.resolve(__dirname, "../../public/loomi-card.html");
const cardHtml = readFileSync(cardPath, "utf8");
// Strip HTML comments so a clarifying comment can't satisfy (or break)
// a source assertion — we only want to match real code.
const stripped = cardHtml.replace(/<!--[\s\S]*?-->/g, "");

// Helper: pull out just the setEditMode() / setEditModeIm() function
// bodies so the assertions below can't be satisfied by unrelated code.
function editModeBody(): string {
  const start = stripped.indexOf("async function setEditMode(");
  expect(start, "setEditMode() not found").toBeGreaterThan(-1);
  const end = stripped.indexOf("async function saveDraft(", start);
  expect(end, "saveDraft() (setEditMode terminator) not found").toBeGreaterThan(
    start,
  );
  return stripped.slice(start, end);
}
function editModeImBody(): string {
  const start = stripped.indexOf("async function setEditModeIm(");
  expect(start, "setEditModeIm() not found").toBeGreaterThan(-1);
  const end = stripped.indexOf("async function saveDraftIm(", start);
  expect(
    end,
    "saveDraftIm() (setEditModeIm terminator) not found",
  ).toBeGreaterThan(start);
  return stripped.slice(start, end);
}

describe("setEditMode() focus is robust to NSPanel activation delay", () => {
  it("calls body.focus() at least once on the next animation frame", () => {
    expect(editModeBody()).toMatch(/requestAnimationFrame\(/);
    expect(editModeBody()).toMatch(/body\.focus\(\)/);
  });

  it("schedules two follow-up focus() calls via setTimeout to survive a slow NSPanel promote", () => {
    // The triple-tap pattern (rAF + 60ms + 200ms) is the whole point of
    // the fix — see the file comment for the macOS NSPanel rationale.
    const body = editModeBody();
    const setTimeoutMatches =
      body.match(/setTimeout\([^,]+,\s*\d+\s*\)/g) || [];
    // Filter for the focus-scheduling setTimeouts (they pass focusBody).
    const focusSetTimeouts = setTimeoutMatches.filter((m) =>
      /setTimeout\(focusBody/.test(m),
    );
    expect(focusSetTimeouts.length).toBeGreaterThanOrEqual(2);
    // The numeric delays should include 60 and 200 (give or take formatting).
    expect(setTimeoutMatches.join(" ")).toMatch(/,\s*60\s*\)/);
    expect(setTimeoutMatches.join(" ")).toMatch(/,\s*200\s*\)/);
  });
});

describe("setEditModeIm() focus is robust to NSPanel activation delay", () => {
  it("calls body.focus() at least once on the next animation frame", () => {
    expect(editModeImBody()).toMatch(/requestAnimationFrame\(/);
    expect(editModeImBody()).toMatch(/body\.focus\(\)/);
  });

  it("schedules two follow-up focus() calls via setTimeout (60ms + 200ms)", () => {
    const body = editModeImBody();
    const setTimeoutMatches =
      body.match(/setTimeout\([^,]+,\s*\d+\s*\)/g) || [];
    const focusSetTimeouts = setTimeoutMatches.filter((m) =>
      /setTimeout\(focusBodyIm/.test(m),
    );
    expect(focusSetTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(setTimeoutMatches.join(" ")).toMatch(/,\s*60\s*\)/);
    expect(setTimeoutMatches.join(" ")).toMatch(/,\s*200\s*\)/);
  });
});

describe("editor wrappers have a click-to-focus safety net", () => {
  it("binds a mousedown listener on #dec-editor that focuses the body textarea", () => {
    // Find the binding block (between the comment + the focusOnEditorSurface
    // helper and the keyboard-shortcuts block). We look for the literal
    // selector string + the addEventListener call.
    expect(stripped).toMatch(
      /getElementById\(["']dec-editor["']\)[\s\S]{0,200}addEventListener\(["']mousedown["']/,
    );
  });

  it("binds a mousedown listener on #dec-editor-im that focuses the IM body textarea", () => {
    expect(stripped).toMatch(
      /getElementById\(["']dec-editor-im["']\)[\s\S]{0,200}addEventListener\(["']mousedown["']/,
    );
  });

  it("the safety-net helper re-focuses a clicked Subject / Body / IM-body input/textarea", () => {
    // Pre-fix this returned early for any input/textarea click, leaving
    // the NSPanel-promote race unhandled (Subject and Body both
    // unclickable). The fix focuses any input/textarea that was
    // clicked (idempotent when the browser already focused it) and,
    // when the direct focus() didn't take, kicks off a short 60 ms /
    // 3 s retry burst against just that target. The helper is
    // ~70 lines of code now, so we look for the key invariants as
    // individual anchored patterns instead of one big regex.
    expect(stripped).toMatch(
      /focusOnEditorSurface[\s\S]{0,2000}closest\(\s*["']input,textarea["']\s*\)/,
    );
    // The direct focus() call against the clicked target (now
    // outside the input/textarea closest branch — earlier return
    // early was the bug).
    expect(stripped).toMatch(
      /focusOnEditorSurface\s*=\s*\([\s\S]*?\)\s*=>\s*\{[\s\S]{0,500}target\.focus\(\s*\{\s*preventScroll/,
    );
  });

  it("the click safety net kicks off a 60 ms / 3 s retry burst when the direct focus() didn't stick", () => {
    // The burst is shorter than the editor watchdog (3 s vs 6 s)
    // because the click already proves the OS is dispatching events
    // to the webview, so the NSPanel shouldn't stay non-key much
    // longer once a click has landed. The burst reuses the same
    // window.__loomiEditorFocusTimer slot as setEditMode() so either
    // handler can cancel the other.
    const start = stripped.indexOf("focusOnEditorSurface =");
    expect(start, "focusOnEditorSurface body not found").toBeGreaterThan(-1);
    const end = stripped.indexOf("const editorRoot =", start);
    expect(
      end,
      "editorRoot (focusOnEditorSurface terminator) not found",
    ).toBeGreaterThan(start);
    const body = stripped.slice(start, end);
    expect(body).toMatch(/>\s*3000/);
    expect(body).toMatch(/,\s*60\s*\)/);
    expect(body).toMatch(/__loomiEditorFocusTimer/);
  });
});

describe("editable surfaces always receive pointer events", () => {
  it("#dec-editor-subject and #dec-editor-body both declare pointer-events: auto", () => {
    // Pull the rule for the email editor's editable inputs.
    const blockMatch = stripped.match(
      /#dec-editor-subject,\s*\n\s*#dec-editor-body\s*\{[\s\S]*?\n\s*\}/,
    );
    expect(blockMatch, "rule for subject/body block not found").not.toBeNull();
    expect(blockMatch?.[0]).toMatch(/pointer-events:\s*auto/);
    expect(blockMatch?.[0]).toMatch(/user-select:\s*text/);
    expect(blockMatch?.[0]).toMatch(/-webkit-user-select:\s*text/);
  });

  it("#dec-editor-im-body declares pointer-events: auto", () => {
    // Two rules match `#dec-editor-im-body {`: the early user-select
    // rule (line ~764) and the larger styling block (line ~801). Anchor
    // on the body styling block by requiring `min-height: 80px`, which
    // is only present in the larger block.
    const blockMatch = stripped.match(
      /#dec-editor-im-body\s*\{[\s\S]*?min-height:\s*80px[\s\S]*?\n\s*\}/,
    );
    expect(
      blockMatch,
      "styling block for #dec-editor-im-body not found",
    ).not.toBeNull();
    expect(blockMatch?.[0]).toMatch(/pointer-events:\s*auto/);
    expect(blockMatch?.[0]).toMatch(/user-select:\s*text/);
    expect(blockMatch?.[0]).toMatch(/caret-color:\s*currentColor/);
  });
});

describe("caret color tracks the text color in both themes", () => {
  it("uses currentColor (not a hard-coded --ink) so the caret stays visible in dark theme", () => {
    // Two textareas, both should use currentColor.
    const caretMatches = stripped.match(/caret-color:\s*currentColor/g) || [];
    expect(caretMatches.length).toBeGreaterThanOrEqual(2);
    // Make sure no leftover caret-color: var(--ink) survives the fix.
    expect(stripped).not.toMatch(/caret-color:\s*var\(--ink\)/);
  });
});
