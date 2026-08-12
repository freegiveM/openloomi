import path from "node:path";
// vite.config.ts
import { defineConfig } from "vitest/config";

const alias = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      // Local UI alias (apps/web/components/ui)
      {
        find: "@openloomi/ui",
        replacement: alias("./components/ui/index.ts"),
      },
      {
        find: "@openloomi/ui/*",
        replacement: alias("./components/ui/*"),
      },
      // B方案 — `packages/ai/src/agent/*` stays local. The 7 remaining
      // `@openloomi/ai/agent/*` imports in tests must resolve here.
      {
        find: "@openloomi/ai/agent",
        replacement: alias("../packages/ai/src/agent/index.ts"),
      },
      {
        find: "@openloomi/ai/agent/*",
        replacement: alias("../packages/ai/src/agent/*"),
      },
      { find: "@", replacement: alias(".") },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      "tests/unit/*.test.ts",
      "tests/unit/*/*.test.ts",
      "tests/api/*.test.ts",
      "tests/api/*.smoke.ts",
    ],
    exclude: ["node_modules", ".next", "out"],
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // npm migration — vi.mock must intercept ESM imports inside npm
    // packages too (e.g. `vi.mock("chromadb")` for chroma-store,
    // `vi.mock("fs")` for paths). Without this, Vitest's resolver
    // loads the package's CJS/ESM directly and the mocks silently
    // miss. Inline the packages we mock transitively.
    server: {
      deps: {
        inline: [/^(?!.*\.mjs).*chromadb.*/, /^@melandlabs\//, /^fernet$/],
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage/unit",
    },
  },
});
