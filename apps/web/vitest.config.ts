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
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage/unit",
    },
  },
});