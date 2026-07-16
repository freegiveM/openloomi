/**
 * Tests for `extractArtifactPathsFromText` — guards against the false-artifact
 * problem reported in #354:
 *   - plugin SKILL.md and other read-only/internal paths must not surface as
 *     generated artifacts;
 *   - paths quoted inside stack traces must be ignored;
 *   - valid session / cross-session / Desktop / memory artifacts must still
 *     resolve;
 *   - malformed / partial strings must not produce cards.
 */

import { describe, expect, it } from "vitest";

import {
  artifactPathBasename,
  extractArtifactPathsFromText,
  isInsideStackTrace,
  isReadOnlyArtifactPath,
  normalizeExtractedArtifactPath,
  pickPreferredArtifactPath,
} from "@/lib/files/extract-artifact-paths";

const SESSION_USER_DIR = "/Users/alice";
const SESSION_PATH = `${SESSION_USER_DIR}/.openloomi/sessions/chat-42/reports/digest.md`;
const CROSS_SESSION_PATH = `${SESSION_USER_DIR}/.openloomi/sessions/chat-99/notes/summary.md`;
const MEMORY_PATH = `${SESSION_USER_DIR}/.openloomi/data/memory/2026-07-16.md`;
const DESKTOP_PATH = `${SESSION_USER_DIR}/Desktop/report.pdf`;
const PLUGIN_SKILL_PATH = `/Users/alice/codes/openloomi/plugins/claude/skills/openloomi-loop/SKILL.md`;
const PLUGIN_AGENT_PATH = `/Users/alice/codes/openloomi/plugins/claude/agents/openloomi-assistant.md`;
const HOME_PATH_GENERIC = `/Users/alice/some/random/notes.md`;
const NODE_MODULES_PATH = `/Users/alice/codes/openloomi/node_modules/some-lib/index.js`;

describe("isReadOnlyArtifactPath", () => {
  it("flags plugin SKILL.md locations", () => {
    expect(isReadOnlyArtifactPath(PLUGIN_SKILL_PATH)).toBe(true);
  });

  it("flags plugin agent paths", () => {
    expect(isReadOnlyArtifactPath(PLUGIN_AGENT_PATH)).toBe(true);
  });

  it("flags node_modules paths", () => {
    expect(isReadOnlyArtifactPath(NODE_MODULES_PATH)).toBe(true);
  });

  it("flags .claude / .git / build / dist / .next / target / out / src paths", () => {
    for (const p of [
      "/Users/alice/.claude/skills/x.md",
      "/Users/alice/proj/.git/HEAD",
      "/Users/alice/proj/dist/bundle.js",
      "/Users/alice/proj/build/output.js",
      "/Users/alice/proj/.next/static/chunks/1.js",
      "/Users/alice/proj/target/release/binary",
      "/Users/alice/proj/out/output.html",
      "/Users/alice/proj/src/foo.ts",
      "/Users/alice/proj/app/page.tsx",
      String.raw`C:\Users\alice\codes\openloomi\plugins\claude\SKILL.md`,
    ]) {
      expect(isReadOnlyArtifactPath(p)).toBe(true);
    }
  });

  it("does not flag session paths", () => {
    expect(isReadOnlyArtifactPath(SESSION_PATH)).toBe(false);
  });

  it("does not flag memory paths", () => {
    expect(isReadOnlyArtifactPath(MEMORY_PATH)).toBe(false);
  });

  it("does not flag Desktop paths", () => {
    expect(isReadOnlyArtifactPath(DESKTOP_PATH)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isReadOnlyArtifactPath("")).toBe(false);
  });
});

describe("isInsideStackTrace", () => {
  it("matches JS-style `at <path>` frames", () => {
    const trace = `Error: boom
    at Object.<anonymous> (${PLUGIN_SKILL_PATH}:12:5)
    at Module._compile (internal/modules/cjs/loader.js:1234:32)`;
    expect(isInsideStackTrace(trace, PLUGIN_SKILL_PATH)).toBe(true);
  });

  it('matches Python-style `File "<path>"` frames', () => {
    const trace = `Traceback (most recent call last):
  File "${PLUGIN_SKILL_PATH}", line 42, in main
  File "/usr/lib/python3.11/json/decoder.py", line 355, in raw_decode`;
    expect(isInsideStackTrace(trace, PLUGIN_SKILL_PATH)).toBe(true);
  });

  it("matches Ruby / Perl `path:line: in` frames", () => {
    const trace = `${PLUGIN_SKILL_PATH}:42:in \`block in <main>'\``;
    expect(isInsideStackTrace(trace, PLUGIN_SKILL_PATH)).toBe(true);
  });

  it("does not match prose that merely mentions the path", () => {
    const prose = `Loaded skill from ${PLUGIN_SKILL_PATH}. Follow its instructions.`;
    expect(isInsideStackTrace(prose, PLUGIN_SKILL_PATH)).toBe(false);
  });

  it("does not match File created successfully lines", () => {
    const ok = `File created successfully at: ${SESSION_PATH}`;
    expect(isInsideStackTrace(ok, SESSION_PATH)).toBe(false);
  });

  it("returns false for empty text or empty candidate", () => {
    expect(isInsideStackTrace("", SESSION_PATH)).toBe(false);
    expect(isInsideStackTrace("at something", "")).toBe(false);
  });
});

describe("extractArtifactPathsFromText", () => {
  it("returns an empty list for empty input", () => {
    expect(extractArtifactPathsFromText("")).toEqual([]);
    expect(
      extractArtifactPathsFromText(undefined as unknown as string),
    ).toEqual([]);
  });

  it("extracts a session-rooted markdown artifact", () => {
    const out = extractArtifactPathsFromText(`Saved report to ${SESSION_PATH}`);
    expect(out).toEqual([SESSION_PATH]);
  });

  it("extracts cross-session artifacts so the PR #300 resolver can re-root them", () => {
    const out = extractArtifactPathsFromText(
      `Linked summary from ${CROSS_SESSION_PATH}`,
    );
    expect(out).toEqual([CROSS_SESSION_PATH]);
  });

  it("extracts Desktop PDFs", () => {
    const out = extractArtifactPathsFromText(
      `Drop the deck at ${DESKTOP_PATH}`,
    );
    expect(out).toEqual([DESKTOP_PATH]);
  });

  it("extracts memory files", () => {
    const out = extractArtifactPathsFromText(`Stored note ${MEMORY_PATH}`);
    expect(out).toEqual([MEMORY_PATH]);
  });

  it("ignores a plugin SKILL.md even when its path is the only thing printed", () => {
    expect(
      extractArtifactPathsFromText(`Loaded skill at ${PLUGIN_SKILL_PATH}`),
    ).toEqual([]);
  });

  it("ignores a plugin agent .md reference", () => {
    expect(
      extractArtifactPathsFromText(`See agent spec: ${PLUGIN_AGENT_PATH}`),
    ).toEqual([]);
  });

  it("ignores paths printed by shell commands (no card even if a tool echoes the path)", () => {
    const shell = `cat ${PLUGIN_SKILL_PATH}\nFile loaded successfully.`;
    expect(extractArtifactPathsFromText(shell)).toEqual([]);
  });

  it("ignores paths quoted inside a Node stack trace", () => {
    const trace = `Error: ENOENT
    at openSync (node:fs:585:3)
    at Object.openSync (node:fs:585:3)
    at tryReadSync (/Users/alice/proj/dist/worker.js:42:13)
    at ${SESSION_PATH}:1:1`;
    // The session path is on its own `at <path>` frame — should be ignored.
    expect(extractArtifactPathsFromText(trace)).toEqual([]);
  });

  it("ignores paths quoted inside a Python traceback", () => {
    const trace = `Traceback (most recent call last):
  File "${SESSION_PATH}", line 17, in main
SomeError: nope`;
    expect(extractArtifactPathsFromText(trace)).toEqual([]);
  });

  it("ignores generic /Users/home paths that aren't in a managed location", () => {
    expect(
      extractArtifactPathsFromText(`note saved at ${HOME_PATH_GENERIC}`),
    ).toEqual([]);
  });

  it("ignores node_modules paths", () => {
    expect(
      extractArtifactPathsFromText(`Module loaded from ${NODE_MODULES_PATH}`),
    ).toEqual([]);
  });

  it("deduplicates repeated paths", () => {
    const text = `${SESSION_PATH}\n${SESSION_PATH}\n${DESKTOP_PATH}`;
    expect(extractArtifactPathsFromText(text).sort()).toEqual(
      [SESSION_PATH, DESKTOP_PATH].sort(),
    );
  });

  it("still surfaces a session artifact when a plugin path appears on the same output", () => {
    const text = `Loaded skill ${PLUGIN_SKILL_PATH}\nWrote digest to ${SESSION_PATH}\n`;
    expect(extractArtifactPathsFromText(text)).toEqual([SESSION_PATH]);
  });

  it("handles Windows session paths", () => {
    const win = String.raw`C:\Users\alice\.openloomi\sessions\chat-42\reports\report.html`;
    expect(extractArtifactPathsFromText(`Saved to ${win}`)).toEqual([win]);
  });

  it("does not extract bare extensions with no real path", () => {
    expect(extractArtifactPathsFromText(`look at report.md next`)).toEqual([]);
  });

  it("does not extract when the path string is malformed (no leading slash)", () => {
    expect(
      extractArtifactPathsFromText(
        `wrote users/alice/.openloomi/sessions/chat-42/digest.md`,
      ),
    ).toEqual([]);
  });
});

describe("artifactPathBasename", () => {
  it("returns the filename for POSIX paths", () => {
    expect(artifactPathBasename(SESSION_PATH)).toBe("digest.md");
  });

  it("returns the filename for Windows paths", () => {
    expect(
      artifactPathBasename(
        String.raw`C:\Users\alice\.openloomi\sessions\chat-42\report.pdf`,
      ),
    ).toBe("report.pdf");
  });

  it("returns the original string when no separator is present", () => {
    expect(artifactPathBasename("digest.md")).toBe("digest.md");
  });
});

describe("normalizeExtractedArtifactPath", () => {
  it("strips trailing parentheses and whitespace", () => {
    expect(normalizeExtractedArtifactPath(`${SESSION_PATH} )`)).toBe(
      SESSION_PATH,
    );
  });

  it("strips trailing Markdown backticks", () => {
    expect(normalizeExtractedArtifactPath(`${SESSION_PATH}\``)).toBe(
      SESSION_PATH,
    );
  });
});

describe("pickPreferredArtifactPath", () => {
  it("prefers HTML when present", () => {
    const html = `${SESSION_USER_DIR}/.openloomi/sessions/chat-42/page.html`;
    expect(pickPreferredArtifactPath([SESSION_PATH, html, DESKTOP_PATH])).toBe(
      html,
    );
  });

  it("falls back to the first path when no HTML is present", () => {
    expect(pickPreferredArtifactPath([SESSION_PATH, DESKTOP_PATH])).toBe(
      SESSION_PATH,
    );
  });

  it("returns null for empty input", () => {
    expect(pickPreferredArtifactPath([])).toBeNull();
  });
});
