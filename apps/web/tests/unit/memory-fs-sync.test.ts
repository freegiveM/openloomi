import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ isTauriMode: () => true }));

import { writeFile } from "@/lib/ai/memory/fs-sync";

describe("memory filesystem sync", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "openloomi-memory-fs-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { force: true, recursive: true });
  });

  it("atomically replaces an existing memory file", async () => {
    const target = join(directory, "project.md");
    await fs.writeFile(target, "old memory", "utf8");

    await writeFile(target, "new memory");

    expect(await fs.readFile(target, "utf8")).toBe("new memory");
    expect(await fs.readdir(directory)).toEqual(["project.md"]);
  });

  it("preserves the previous memory when the atomic rename fails", async () => {
    const target = join(directory, "project.md");
    await fs.writeFile(target, "old memory", "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeFile(target, "new memory")).rejects.toThrow(
      "rename failed",
    );

    expect(await fs.readFile(target, "utf8")).toBe("old memory");
    expect(await fs.readdir(directory)).toEqual(["project.md"]);
  });
});
