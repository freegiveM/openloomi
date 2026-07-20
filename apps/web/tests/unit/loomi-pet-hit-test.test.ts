/**
 * Loomi Pet — stable drag regression suite.
 *
 * The 168×168 frameless NSPanel hosts `loomi-widget.html` and uses
 * Tauri's native `startDragging()` so the whole window follows the
 * pointer. This suite pins the wiring that makes cold-start dragging
 * work reliably:
 *
 *   · The four pointer handlers are attached to `document.body`
 *     (the only element guaranteed to be in the layout on cold boot).
 *   · `onPointerDown` records coordinates, adds the `dragging` class,
 *     calls `startDragging()`, and captures the pointer.
 *   · `onPointerUp` releases the capture and decides drag vs. click.
 *
 * These source assertions catch the regressions that motivated
 * dropping the #392 alpha-aware click-through layer: the OS-level
 * `setIgnoreCursorEvents(true)` flag was leaving the window unable
 * to receive `pointerdown` on cold launch, and the 4 Hz
 * `get_global_cursor_position` poll was the only path to recovery.
 * We verify the widget no longer carries that plumbing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const widgetPath = path.resolve(__dirname, "../../public/loomi-widget.html");
const widgetHtml = readFileSync(widgetPath, "utf8");
// Strip HTML comments so a clarifying comment can't satisfy (or
// break) a source assertion — we only want to match real code.
const stripped = widgetHtml.replace(/<!--[\s\S]*?-->/g, "");

describe("loomi-widget — stable drag wiring", () => {
  it("attaches the four pointer handlers to document.body", () => {
    // The drag must work on cold boot, before any non-body element
    // has been painted. Pin the exact handler list so a regression
    // that moves one to `document` (which would miss the long-press
    // body class swap) still fails this test.
    expect(stripped).toMatch(
      /document\.body\.addEventListener\(\s*["']pointerdown["']\s*,\s*onPointerDown\s*\)/,
    );
    expect(stripped).toMatch(
      /document\.body\.addEventListener\(\s*["']pointermove["']\s*,\s*onPointerMove\s*\)/,
    );
    expect(stripped).toMatch(
      /document\.body\.addEventListener\(\s*["']pointerup["']\s*,\s*onPointerUp\s*\)/,
    );
    expect(stripped).toMatch(
      /document\.body\.addEventListener\(\s*["']pointercancel["']\s*,\s*onPointerUp\s*\)/,
    );
  });

  it("onPointerDown adds the dragging class, records coords, captures the pointer, and calls startDragging", () => {
    // Slice from the function header to the next function header
    // (or to the end of the IIFE). `onPointerDown` is the first
    // pointer handler in the widget, so its body is bounded by
    // `function onPointerMove` which is guaranteed to exist.
    const start = stripped.indexOf("function onPointerDown");
    const end = stripped.indexOf("function onPointerMove", start);
    expect(start, "onPointerDown not defined").toBeGreaterThan(-1);
    expect(
      end,
      "onPointerMove not defined after onPointerDown",
    ).toBeGreaterThan(start);
    const fnBody = stripped.slice(start, end);
    // Coordinate bookkeeping — used to classify click vs. drag in
    // onPointerUp. Without this the pointerup branch can never
    // decide whether the user dragged.
    expect(fnBody).toMatch(/downX\s*=\s*e\.clientX/);
    expect(fnBody).toMatch(/downY\s*=\s*e\.clientY/);
    // The dragging class is what flips the cursor from `grab` to
    // `grabbing` and gates the long-press indicator.
    expect(fnBody).toMatch(
      /document\.body\.classList\.add\(\s*["']dragging["']\s*\)/,
    );
    // The actual drag — without this call the window never moves
    // and the whole "click anywhere and drag" promise is broken.
    expect(fnBody).toMatch(/w\.startDragging\s*\(\s*\)/);
    // Pointer capture keeps the gesture alive when the OS cursor
    // leaves the 168×168 frame during a native drag.
    expect(fnBody).toMatch(
      /document\.body\.setPointerCapture\(\s*e\.pointerId\s*\)/,
    );
  });

  it("onPointerUp releases the pointer capture and removes the dragging class", () => {
    // Slice from `function onPointerUp` to the IIFE close. The
    // pointerup branch is the last handler in the script, so its
    // body extends to the closing `})();`.
    const start = stripped.indexOf("function onPointerUp");
    expect(start, "onPointerUp not defined").toBeGreaterThan(-1);
    const fnBody = stripped.slice(start);
    // The capture acquired in onPointerDown must be released on
    // the matching release event. Without this the OS keeps the
    // pointer routed to the window even after the user has
    // released, and the next click outside the window is lost.
    expect(fnBody).toMatch(
      /document\.body\.releasePointerCapture\(\s*e\.pointerId\s*\)/,
    );
    // The dragging class must be removed so the cursor reverts
    // from `grabbing` to `grab` once the gesture is over.
    expect(fnBody).toMatch(
      /document\.body\.classList\.remove\(\s*["']dragging["']\s*\)/,
    );
  });

  it("preserves the menu guard so menu clicks do not start a drag", () => {
    // #369 — pointer events that originate inside `#pet-menu`
    // must bail before any drag bookkeeping happens. Without the
    // guard `startDragging()` would lurch the window while the
    // user is mid-click on a menu item, and the matching
    // `pointerup` would re-emit `pet:open-dashboard`, masking
    // whatever operation the menu actually requested. Slice the
    // first ~700 chars of `onPointerDown` — the guard sits just
    // after the long comment block.
    const start = stripped.indexOf("function onPointerDown");
    expect(start, "onPointerDown not defined").toBeGreaterThan(-1);
    const fnBody = stripped.slice(start, start + 800);
    expect(fnBody).toMatch(
      /petMenu\s*&&\s*petMenu\.contains\(\s*e\.target\s*\)/,
    );
    expect(fnBody).toMatch(/return\s*;/);
  });
});

describe("loomi-widget — #392 click-through plumbing removed", () => {
  it("does not call setIgnoreCursorEvents from the Pet hit-test wiring", () => {
    // The #392 layer routed the alpha verdict to the OS-level
    // ignore-cursor flag. Once that layer is gone, the JS should
    // never call the Tauri `setIgnoreCursorEvents` method on the
    // current window — the Pet always claims events.
    expect(stripped).not.toMatch(/w\.setIgnoreCursorEvents\s*\(/);
    // Also pin the absence of the bare `setIgnoreCursorEvents`
    // symbol so a regression that forgets the `w.` prefix still
    // fails the test.
    expect(stripped).not.toMatch(/setIgnoreCursorEvents\s*\(/);
  });

  it("does not invoke the removed get_global_cursor_position command", () => {
    // The 4 Hz `get_global_cursor_position` poll was the only path
    // to recover from `setIgnoreCursorEvents(true)` while the
    // window was in click-through mode. Both the command and the
    // `t.core.invoke` call site must be gone.
    expect(stripped).not.toMatch(
      /t\.core\.invoke\(\s*["']get_global_cursor_position["']/,
    );
    expect(stripped).not.toMatch(/get_global_cursor_position/);
  });

  it("does not declare the alpha mask constants or cache", () => {
    // `MASK_W` / `MASK_H` / `ALPHA_THRESHOLD` drove the cached
    // alpha buffer's sampling. The buffer itself (`maskCache`,
    // `currentMask`, `currentMaskUrl`) was read on every cursor
    // move to decide "claim or pass through". All of it should
    // be gone.
    expect(stripped).not.toMatch(/MASK_W\s*=/);
    expect(stripped).not.toMatch(/MASK_H\s*=/);
    expect(stripped).not.toMatch(/ALPHA_THRESHOLD\s*=/);
    expect(stripped).not.toMatch(/maskCache/);
    expect(stripped).not.toMatch(/currentMask/);
    expect(stripped).not.toMatch(/currentMaskUrl/);
  });

  it("does not declare the transient lock or the cursor poller", () => {
    // The transient lock was the only thing standing between a
    // mid-drag cursor and a click-through flag flip. Without
    // click-through, the lock is dead weight. The 250 ms
    // `pollCursorOnce` interval is also dead — `get_global_cursor_position`
    // is gone, so nothing for the poller to call.
    expect(stripped).not.toMatch(/transientLock/);
    expect(stripped).not.toMatch(/pollCursorOnce/);
    expect(stripped).not.toMatch(/setInterval\s*\(\s*pollCursorOnce/);
  });

  it("does not contain the hidden hit-mask canvas", () => {
    // The 168×168 backing store was the source of alpha data for
    // the JS hit-tester. Without the hit-tester the canvas is
    // dead weight — it would still be hidden, but it would also
    // be carrying a 168×168 RGBA buffer for no reason.
    expect(stripped).not.toMatch(/<canvas[\s\S]*?id=["']hit-mask["']/);
  });

  it("does not apply pointer-events: none to html, body", () => {
    // The #392 layer disabled pointer events on `html, body` so
    // clicks on transparent corners could pass through to the
    // underlying app. We restore normal pointer behavior so the
    // Pet is interactive on every pixel of the 168×168 frame.
    const bodyRule = stripped.match(/html,\s*body\s*{[^}]*}/);
    expect(bodyRule, "html, body rule not found").not.toBeNull();
    expect(bodyRule?.[0]).not.toMatch(/pointer-events:\s*none/);
  });
});
