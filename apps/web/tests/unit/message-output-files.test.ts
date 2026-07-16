/**
 * Tests for `collectToolOutputFilesFromParts` — guards against the duplicate-file
 * problem reported in #357:
 *   - repeated Write → Edit → Write of the same canonical path must collapse to
 *     a single entry whose metadata reflects the **latest** tool-native part;
 *   - intermediate scripts and `temp/` paths must surface as `role: "work"`
 *     so they don't compete visually with final deliverables;
 *   - timed-out / errored tool runs must mark the file `readiness: "incomplete"`
 *     so the row can render an "Incomplete" pill;
 *   - same-basename files in different sessions must stay distinct (the map key
 *     is the full canonical path, never the basename);
 *   - structured tool-native entries must take precedence over plain text
 *     mentions of the same path (tool-native beats free-text).
 */

import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@openloomi/shared";
import {
  collectToolOutputFilesFromParts,
  type ToolOutputFileReadiness,
  type ToolOutputFileRole,
} from "@/components/message/message-output-files";

// Permissive fixture type: the production code already treats parts loosely
// (`(part as { type?: string })`), so `any[]` casts keep the fixtures readable
// without forcing every test to construct the full ChatMessage shape.
type PartFixture = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const partsOf = (parts: PartFixture[]): ChatMessage["parts"] =>
  parts as unknown as ChatMessage["parts"];

const SESSION = "/Users/alice/.openloomi/sessions/chat-42/reports/digest.md";
const CROSS = "/Users/alice/.openloomi/sessions/chat-99/reports/digest.md";
const TEMP = "/Users/alice/.openloomi/sessions/chat-42/temp/scratch.py";

function toolNative(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool-native",
    toolUseId: "u1",
    toolName: "Write",
    toolInput: {},
    status: "completed" as const,
    isError: false,
    ...overrides,
  };
}

describe("collectToolOutputFilesFromParts — latest-wins dedup (#357)", () => {
  it("collapses repeated Write → Edit → Write into one card", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(SESSION);
  });

  it("uses the latest valid metadata for a path (later name/type wins)", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: SESSION, name: "draft.md", type: "md" },
      }),
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("digest.md");
  });

  it("keeps same-basename files on different session paths distinct", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
      toolNative({
        generatedFile: { path: CROSS, name: "digest.md", type: "md" },
      }),
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out.map((f) => f.path).sort()).toEqual([CROSS, SESSION].sort());
  });
});

describe("collectToolOutputFilesFromParts — readiness classification", () => {
  it("marks a completed write as readiness: completed", () => {
    const parts = partsOf([
      toolNative({
        status: "completed",
        isError: false,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.readiness).toBe<ToolOutputFileReadiness>("completed");
  });

  it("marks a timed-out write (status: error) as readiness: incomplete", () => {
    const parts = partsOf([
      toolNative({
        status: "error",
        isError: true,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.readiness).toBe<ToolOutputFileReadiness>("incomplete");
  });

  it("marks a timed-out write (isError: true, no status) as readiness: incomplete", () => {
    const parts = partsOf([
      toolNative({
        status: undefined,
        isError: true,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.readiness).toBe<ToolOutputFileReadiness>("incomplete");
  });

  it("re-written path after failure ends up readiness: completed (single entry)", () => {
    const parts = partsOf([
      toolNative({
        status: "error",
        isError: true,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
      toolNative({
        status: "completed",
        isError: false,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0].readiness).toBe<ToolOutputFileReadiness>("completed");
  });
});

describe("collectToolOutputFilesFromParts — role classification", () => {
  it("classifies a non-temp generated file as role: deliverable", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.role).toBe<ToolOutputFileRole>("deliverable");
    expect(first.isTemporary).toBe(false);
  });

  it("classifies temp/ files as role: work", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: TEMP, name: "scratch.py", type: "py" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.role).toBe<ToolOutputFileRole>("work");
    expect(first.isTemporary).toBe(true);
  });

  it("classifies codeFile-only entries (intermediate script) as role: work", () => {
    const parts = partsOf([
      toolNative({
        // No generatedFile — only codeFile. Represents an intermediate script
        // surfaced for code preview, not a final deliverable.
        generatedFile: undefined,
        codeFile: { path: SESSION, name: "scratch.py", language: "py" },
      }),
    ]);
    const [first] = collectToolOutputFilesFromParts(parts);
    expect(first.role).toBe<ToolOutputFileRole>("work");
  });

  it("classifies a generatedFile as role: deliverable even when paired with a codeFile on the same path", () => {
    const parts = partsOf([
      toolNative({
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
        codeFile: { path: SESSION, name: "digest.md", language: "md" },
      }),
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    // Both candidates share the same path → single entry, generatedFile's
    // metadata wins because it's pushed first and the latest-wins overwrite
    // keeps the value stable across the two writes in this iteration.
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe<ToolOutputFileRole>("deliverable");
  });
});

describe("collectToolOutputFilesFromParts — text-blob interactions", () => {
  it("does not let free-text mention downgrade structured metadata", () => {
    const parts = partsOf([
      toolNative({
        status: "error",
        isError: true,
        generatedFile: { path: SESSION, name: "digest.md", type: "md" },
      }),
      {
        type: "text",
        text: `Wrote ${SESSION}`,
      },
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    // Structured metadata (status: error, isError: true) must win — the text
    // blob's insert-if-absent branch must NOT clobber readiness.
    expect(out[0].readiness).toBe<ToolOutputFileReadiness>("incomplete");
  });

  it("surfaces text-only artifacts when no tool-native part exists", () => {
    const parts = partsOf([
      {
        type: "text",
        text: `Saved report at ${SESSION}`,
      },
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe(SESSION);
    expect(out[0].name).toBe("digest.md");
    // Free-text-only path: no tool-native status fidelity, so we default to
    // completed and let the row render normally.
    expect(out[0].readiness).toBe<ToolOutputFileReadiness>("completed");
    expect(out[0].role).toBe<ToolOutputFileRole>("deliverable");
  });

  it("free-text-only path under temp/ is classified role: work", () => {
    const parts = partsOf([
      {
        type: "text",
        text: `Wrote helper at ${TEMP}`,
      },
    ]);
    const out = collectToolOutputFilesFromParts(parts);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe<ToolOutputFileRole>("work");
    expect(out[0].isTemporary).toBe(true);
  });
});